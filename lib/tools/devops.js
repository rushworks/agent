"use strict";

// Devops-role tools — operational diagnostics on the host the agent
// runs on. Two tools:
//
//   system_logs — tail / grep any readable file on the host. A hard
//                 deny-list blocks sensitive paths (.env, .ssh, *.key,
//                 shadow, sudoers, etc.) regardless of what's requested.
//   db_query    — SELECT-only against a connection string the PM
//                 configures per-project. Enforced via READ ONLY
//                 transaction; customer should also use a DB user with
//                 SELECT-only grants.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const log = require('../Log');
const { hardDeny } = require('./deny-list');

const MAX_LOG_OUTPUT  = 64 * 1024;
const MAX_QUERY_ROWS  = 500;
const DB_QUERY_TIMEOUT_MS = 15_000;

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

// Resolve symlinks. Returns the realpath if it exists, null on ENOENT.
function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

module.exports = [
  {
    name: 'system_logs',
    roles: ['devops'],
    description: 'Read or grep a file on the host this agent runs on. A hardcoded deny-list refuses .env / *.key / *.pem / .ssh / shadow / sudoers regardless of request. Output is capped at 64 KB. Use `tail` mode (default) to read the last N lines; use `grep` mode to filter for matching lines.',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        path:  { type: 'string',  description: 'Absolute file path on the host.' },
        mode:  { type: 'string',  enum: ['tail', 'grep'], description: 'tail (default) returns the last `lines` lines. grep filters for matches.' },
        lines: { type: 'integer', description: 'Number of lines for tail mode. Default 200, max 2000.' },
        pattern: { type: 'string', description: 'Regex pattern for grep mode (required when mode=grep).' }
      }
    },
    async execute({ path: p, mode, lines, pattern }) {
      if (!p || !path.isAbsolute(p)) {
        throw new Error('absolute path required');
      }

      let resolvedPath;
      try {
        resolvedPath = safeRealpath(p);
      } catch (err) {
        throw new Error(`cannot resolve path: ${err.code || err.message}`);
      }
      if (!resolvedPath) {
        throw new Error(`path does not exist: ${p}`);
      }
      if (hardDeny(resolvedPath)) {
        throw new Error(`path blocked by security deny-list: ${resolvedPath}`);
      }
      try {
        fs.accessSync(resolvedPath, fs.constants.R_OK);
      } catch (err) {
        throw new Error(`cannot read ${resolvedPath}: ${err.code || err.message}`);
      }
      const safePath = resolvedPath;

      const m = (mode || 'tail').toLowerCase();
      if (m !== 'tail' && m !== 'grep') {
        throw new Error('mode must be "tail" or "grep"');
      }

      return new Promise((resolve, reject) => {
        let args;
        if (m === 'tail') {
          const n = Math.min(Math.max(parseInt(lines, 10) || 200, 1), 2000);
          args = ['-n', String(n), safePath];
          execFile('tail', args, { maxBuffer: MAX_LOG_OUTPUT * 2, timeout: 15_000 },
            (err, stdout) => {
              if (err) return reject(new Error(`tail failed: ${err.message}`));
              resolve(JSON.stringify({
                path: safePath, mode: 'tail', lines_requested: n,
                output: String(stdout).slice(0, MAX_LOG_OUTPUT)
              }));
            });
        } else {
          if (!pattern || typeof pattern !== 'string') {
            return reject(new Error('mode=grep requires a non-empty pattern'));
          }
          args = ['-E', '-i', '-n', pattern, safePath];
          execFile('grep', args, { maxBuffer: MAX_LOG_OUTPUT * 2, timeout: 15_000 },
            (err, stdout) => {
              if (err && err.code !== 1) return reject(new Error(`grep failed: ${err.message}`));
              resolve(JSON.stringify({
                path: safePath, mode: 'grep', pattern,
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
    description: 'Run a SELECT query against the customer database. The connection string is configured by the PM via the project Team tab. Every query runs inside `BEGIN; SET TRANSACTION READ ONLY` — the DB engine rejects any write (INSERT / UPDATE / DELETE / DDL) regardless of role grants. Statement timeout: 15s. Results capped at 500 rows. Connection string is held in the tool runtime and never reaches the model context.',
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
      if (!cfg.db_url) throw new Error('database connection string is not configured for this project — ask the PM to set it via the Team tab');
      if (cfg.db_kind && cfg.db_kind !== 'postgres') {
        throw new Error(`db_kind="${cfg.db_kind}" is not yet supported in this agent version (postgres only for now)`);
      }

      const dsnPattern = /(postgres(?:ql)?|mysql):\/\/[^\s'"`]+/gi;
      const scrub = (s) => String(s == null ? '' : s).replace(dsnPattern, '<db-url-redacted>');

      const { Client } = loadPg();
      const client = new Client({ connectionString: cfg.db_url });
      const startMs = Date.now();
      let connected = false;
      try {
        await client.connect();
        connected = true;
        await client.query('BEGIN');
        await client.query('SET TRANSACTION READ ONLY');
        await client.query(`SET LOCAL statement_timeout = ${DB_QUERY_TIMEOUT_MS}`);
        const result = await client.query(query, Array.isArray(params) ? params : []);
        await client.query('COMMIT');
        const rows = (result.rows || []).slice(0, MAX_QUERY_ROWS);
        return JSON.stringify({
          rows,
          row_count: result.rowCount,
          truncated: result.rowCount > MAX_QUERY_ROWS,
          elapsed_ms: Date.now() - startMs
        });
      } catch (err) {
        if (connected) {
          try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        }
        const code = err.code || err.severity || '';
        throw new Error(`db_query failed${code ? ' (' + code + ')' : ''}: ${scrub(err.message)}`);
      } finally {
        if (connected) {
          try { await client.end(); } catch (_) { /* ignore */ }
        }
      }
    }
  }
];
