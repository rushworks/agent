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

// Hard deny-list — paths the agent refuses to read even when the PM's
// allowlist permits them. Catches the obvious "I allowlisted /etc/
// to debug nginx and now the agent's reading shadow" footgun.
// Patterns match against the realpath-resolved absolute path.
const HARD_DENY_PATTERNS = [
  /(^|\/)\.env(\.|$)/,                // .env, .env.production, etc.
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /\.(key|pem|p12|pfx|crt|cer)$/i,    // private keys + certs
  /(^|\/)id_rsa(\.|$)/,
  /(^|\/)id_ed25519(\.|$)/,
  /(^|\/)id_ecdsa(\.|$)/,
  /(^|\/)\.ssh(\/|$)/,                // entire .ssh dir
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /^\/etc\/shadow$/,
  /^\/etc\/sudoers(\.|$)/,
  /^\/etc\/passwd$/,                  // less critical but no diagnostic value
  /^\/root(\/|$)/                     // root's home — never legitimate diagnostic territory
];

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

// Resolve symlinks + walk up the path. Returns the realpath if it
// exists, null on ENOENT (caller decides how to handle missing files).
// Throws on other fs errors (e.g. EACCES — surfaces as a clear failure).
function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function hardDeny(absPath) {
  for (const pat of HARD_DENY_PATTERNS) {
    if (pat.test(absPath)) return true;
  }
  return false;
}

module.exports = [
  {
    name: 'system_logs',
    roles: ['devops'],
    description: 'Read or grep a log file on the host this agent runs on. The PM allowlists which paths you can access via the project Team tab; both the path you request AND its realpath (after symlink resolution) must be in the allowlist. A hardcoded deny-list refuses .env / *.key / *.pem / .ssh / shadow / sudoers regardless of allowlist. Output is capped at 64 KB. Use `tail` mode (default) to read the last N lines; use `grep` mode to filter for matching lines.',
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

      // Two-step path check: the requested path AND its symlink-resolved
      // realpath both must pass. A symlinked allowlist entry that points
      // outside the intended target would otherwise let the agent read
      // arbitrary files. Final check is against the hard deny-list so
      // even a customer who allowlists /etc/ can't slurp /etc/shadow.
      if (!matchAllowlist(cfg.log_paths || [], p)) {
        throw new Error(`path "${p}" is not in the allowlist for this project. Configured paths: ${(cfg.log_paths || []).join(', ') || '(none)'}`);
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
      // The realpath (symlink-resolved) must ALSO be in the allowlist —
      // otherwise a symlink at allowed/foo.log → /etc/shadow would let
      // an attacker who controls the allowlisted directory escape it.
      if (!matchAllowlist(cfg.log_paths || [], resolvedPath)) {
        throw new Error(`path "${p}" resolves to "${resolvedPath}" which is not in the allowlist`);
      }
      if (hardDeny(resolvedPath)) {
        throw new Error(`path "${resolvedPath}" matches the hardcoded deny-list (env / keys / shadow / etc.) — refused regardless of allowlist`);
      }
      try {
        fs.accessSync(resolvedPath, fs.constants.R_OK);
      } catch (err) {
        throw new Error(`cannot read ${resolvedPath}: ${err.code || err.message}`);
      }
      // Use the resolved path for the actual read so we never operate
      // on the unresolved symlink chain again.
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
          // -E for extended regex; the pattern arrives as one arg via
          // execFile so there's no shell interpretation. Limit lines
          // returned + maxBuffer to bound output.
          args = ['-E', '-i', '-n', pattern, safePath];
          execFile('grep', args, { maxBuffer: MAX_LOG_OUTPUT * 2, timeout: 15_000 },
            (err, stdout) => {
              // grep exits 1 with no error when there are no matches; treat as success.
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
      if (!cfg.db_enabled) throw new Error('database access is disabled for this project — ask the PM to enable it via the Team tab');
      if (!cfg.db_url) throw new Error('database connection string is not configured for this project');
      if (cfg.db_kind && cfg.db_kind !== 'postgres') {
        throw new Error(`db_kind="${cfg.db_kind}" is not yet supported in this agent version (postgres only for now)`);
      }

      // Scrub a string that might contain the DB connection URL before
      // returning it to the LLM (pg sometimes echoes the connection
      // string in error messages, which would leak the password into
      // the model context + prompt cache). Replace any DSN-shaped
      // substring with a placeholder.
      const dsnPattern = /(postgres(?:ql)?|mysql):\/\/[^\s'"`]+/gi;
      const scrub = (s) => String(s == null ? '' : s).replace(dsnPattern, '<db-url-redacted>');

      const { Client } = loadPg();
      const client = new Client({ connectionString: cfg.db_url });
      const startMs = Date.now();
      let connected = false;
      try {
        // Timeout the connect itself so a wrong host doesn't hang the
        // tool indefinitely. The query also runs under a statement
        // timeout enforced via SET below.
        await client.connect();
        connected = true;
        // Defense-in-depth: enforce read-only at the TRANSACTION level
        // before running the query. Even if the PM accidentally
        // configured a connection string for a user with write grants,
        // any INSERT / UPDATE / DELETE / DDL inside this transaction
        // gets rejected by the DB engine with code 25006 ("cannot
        // execute X in a read-only transaction"). This is the proper
        // SELECT-only enforcement we deferred at v1 ship.
        await client.query('BEGIN');
        await client.query('SET TRANSACTION READ ONLY');
        // Statement timeout — Postgres-specific. Issue before the
        // actual query so a slow / runaway SELECT can't hang the agent.
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
        // Roll back the transaction if we opened one, so the connection
        // returns to a clean state even though we're about to .end() it.
        if (connected) {
          try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        }
        // Surface pg error code + scrubbed message so the LLM can adapt
        // without leaking the connection string into model context.
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
