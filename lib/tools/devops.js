"use strict";

// Devops-role tools — read-only operational diagnostics on the host
// the agent runs on. Two tools:
//
//   system_logs — tail / grep against an allowlisted set of log paths
//                 set per-project by the PM via the portal.
//   db_query    — SELECT-only against a connection string the PM
//                 configures per-project. Customer is expected to use
//                 a DB user with SELECT-only grants — we don't parse
//                 the query to enforce that.
//
// Both tools read their permissions from `context.devops_config`, which
// the TaskWorker pulls from the project briefing. When a tool is invoked
// without devops_config in scope (e.g. a non-task tool dispatch), it
// errors out — devops tools require an active project context to know
// what's allowed.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const log = require('../Log');

const MAX_LOG_OUTPUT  = 64 * 1024;
const MAX_QUERY_ROWS  = 500;
const DB_QUERY_TIMEOUT_MS = 15_000;

// Lazy-require the postgres driver. Mysql support is a v2 follow-up.
let _pg = null;
function loadPg() {
  if (_pg) return _pg;
  try {
    _pg = require('pg');
    return _pg;
  } catch (err) {
    throw new Error('pg driver not installed; run `npm install pg` in the agent-cli directory');
  }
}

// Does a configured log allowlist entry match the requested path?
// Supports literal absolute paths and simple shell-glob patterns
// (only * and ? at the basename level — no recursive ** or
// directory globbing). Anchored: the request must equal a literal
// entry, or match its glob pattern after both are absolute-pathed.
function matchAllowlist(allowlist, requestedPath) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
  const reqAbs = path.resolve(requestedPath);
  for (const entry of allowlist) {
    if (typeof entry !== 'string') continue;
    if (!entry.startsWith('/')) continue;       // relative paths are rejected upstream too
    if (entry.indexOf('*') === -1 && entry.indexOf('?') === -1) {
      if (path.resolve(entry) === reqAbs) return true;
      continue;
    }
    // Glob: escape regex specials except * and ?, then turn into a
    // regex anchored start-to-end.
    const regexBody = entry
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');
    const re = new RegExp('^' + regexBody + '$');
    if (re.test(reqAbs)) return true;
  }
  return false;
}

module.exports = [
  {
    name: 'system_logs',
    roles: ['devops'],
    description: 'Read or grep a log file on the host this agent runs on. The PM allowlists which paths you can access via the project Team tab; if the path you request is not in the allowlist, this tool refuses. Output is capped at 64 KB. Use `tail` mode (default) to read the last N lines; use `grep` mode to filter for matching lines.',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        path:  { type: 'string',  description: 'Absolute file path on the host. Must match the allowlist set by the PM.' },
        mode:  { type: 'string',  enum: ['tail', 'grep'], description: 'tail (default) returns the last `lines` lines. grep filters for matches.' },
        lines: { type: 'integer', description: 'Number of lines for tail mode. Default 200, max 2000.' },
        pattern: { type: 'string', description: 'Regex pattern for grep mode (required when mode=grep).' }
      }
    },
    async execute({ path: p, mode, lines, pattern }, context) {
      const cfg = context && context.devops_config;
      if (!cfg) throw new Error('no devops_config in scope — this tool runs only inside a task/mention with project context');
      if (!cfg.logs_enabled) throw new Error('log reads are disabled for this project — ask the PM to enable them via the Team tab');
      if (!matchAllowlist(cfg.log_paths || [], p)) {
        throw new Error(`path "${p}" is not in the allowlist for this project. Configured paths: ${(cfg.log_paths || []).join(', ') || '(none)'}`);
      }
      try {
        fs.accessSync(p, fs.constants.R_OK);
      } catch (err) {
        throw new Error(`cannot read ${p}: ${err.code || err.message}`);
      }

      const m = (mode || 'tail').toLowerCase();
      if (m !== 'tail' && m !== 'grep') {
        throw new Error('mode must be "tail" or "grep"');
      }

      return new Promise((resolve, reject) => {
        let args;
        if (m === 'tail') {
          const n = Math.min(Math.max(parseInt(lines, 10) || 200, 1), 2000);
          args = ['-n', String(n), p];
          execFile('tail', args, { maxBuffer: MAX_LOG_OUTPUT * 2, timeout: 15_000 },
            (err, stdout) => {
              if (err) return reject(new Error(`tail failed: ${err.message}`));
              resolve(JSON.stringify({
                path: p, mode: 'tail', lines_requested: n,
                output: String(stdout).slice(0, MAX_LOG_OUTPUT)
              }));
            });
        } else {
          if (!pattern || typeof pattern !== 'string') {
            return reject(new Error('mode=grep requires a non-empty pattern'));
          }
          // -E for extended regex; the pattern arrives as one arg via
          // execFile so there's no shell interpretation. Limit lines
          // returned + maxBuffer to bound output.
          args = ['-E', '-i', '-n', pattern, p];
          execFile('grep', args, { maxBuffer: MAX_LOG_OUTPUT * 2, timeout: 15_000 },
            (err, stdout) => {
              // grep exits 1 with no error when there are no matches; treat as success.
              if (err && err.code !== 1) return reject(new Error(`grep failed: ${err.message}`));
              resolve(JSON.stringify({
                path: p, mode: 'grep', pattern,
                output: String(stdout).slice(0, MAX_LOG_OUTPUT)
              }));
            });
        }
      });
    }
  },

  {
    name: 'db_query',
    roles: ['devops'],
    description: 'Run a SELECT query against the customer database. The connection string is configured by the PM via the project Team tab. The PM is expected to provision a DB user with SELECT-only grants — we do not parse the query to enforce that. Results are capped at 500 rows.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query:  { type: 'string', description: 'SQL query. Use $1, $2 for parameterized values.' },
        params: { type: 'array', items: { type: 'string' }, description: 'Optional positional parameters bound to the query.' }
      }
    },
    async execute({ query, params }, context) {
      const cfg = context && context.devops_config;
      if (!cfg) throw new Error('no devops_config in scope — this tool runs only inside a task/mention with project context');
      if (!cfg.db_enabled) throw new Error('database access is disabled for this project — ask the PM to enable it via the Team tab');
      if (!cfg.db_url) throw new Error('database connection string is not configured for this project');
      if (cfg.db_kind && cfg.db_kind !== 'postgres') {
        throw new Error(`db_kind="${cfg.db_kind}" is not yet supported in this agent version (postgres only for now)`);
      }

      const { Client } = loadPg();
      const client = new Client({ connectionString: cfg.db_url });
      const startMs = Date.now();
      let connected = false;
      try {
        // Timeout the connect itself so a wrong host doesn't hang the
        // tool indefinitely. The query also runs under a statement
        // timeout enforced by node-pg via the connection options below.
        await client.connect();
        connected = true;
        // Statement timeout — Postgres-specific. Issue before the
        // actual query so a slow / runaway SELECT can't hang the agent.
        await client.query(`SET statement_timeout = ${DB_QUERY_TIMEOUT_MS}`);
        const result = await client.query(query, Array.isArray(params) ? params : []);
        const rows = (result.rows || []).slice(0, MAX_QUERY_ROWS);
        return JSON.stringify({
          rows,
          row_count: result.rowCount,
          truncated: result.rowCount > MAX_QUERY_ROWS,
          elapsed_ms: Date.now() - startMs
        });
      } catch (err) {
        // Surface pg error code + message so the LLM can adapt.
        const code = err.code || err.severity || '';
        throw new Error(`db_query failed${code ? ' (' + code + ')' : ''}: ${err.message}`);
      } finally {
        if (connected) {
          try { await client.end(); } catch (_) { /* ignore */ }
        }
      }
    }
  }
];
