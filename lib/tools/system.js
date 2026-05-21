"use strict";

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const log = require('../Log');

// Filesystem + shell tools. Two access tiers:
//   - read-only tools (list, read, glob, grep) are available to both roles
//     so an analyst can pull context from a connected working directory.
//   - write tools (write_file, edit_file, bash) are developer-only.
//
// All paths are resolved against `context.working_directory` and rejected
// if they escape it. This is the agent's local-filesystem perimeter; the
// agent never reads outside its own working dir.

const MAX_READ_BYTES   = 200 * 1024;
const MAX_BASH_OUTPUT  = 64 * 1024;
const MAX_GREP_RESULTS = 500;

function resolveSafe(workingDir, p) {
  if (!workingDir) {
    throw new Error('no working_directory configured — set one with `rushworks-agent init`');
  }
  const abs = path.resolve(workingDir, p || '.');
  if (!abs.startsWith(workingDir + path.sep) && abs !== workingDir) {
    throw new Error(`path escapes working_directory: ${p}`);
  }
  return abs;
}

function rel(workingDir, abs) {
  return path.relative(workingDir, abs) || '.';
}

// Simple glob — supports * and ** in path segments. We avoid pulling in a
// dep for one matcher; matches gitignore-style with **/ for any-depth.
function globToRegex(pattern) {
  let r = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      r += '.*'; i += 1;
      if (pattern[i + 1] === '/') i += 1;
    } else if (c === '*') {
      r += '[^/]*';
    } else if (c === '?') {
      r += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      r += '\\' + c;
    } else {
      r += c;
    }
  }
  return new RegExp(r + '$');
}

function walk(dir, opts, results = []) {
  if (results.length >= opts.limit) return results;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_e) { return results; }
  for (const ent of entries) {
    if (results.length >= opts.limit) break;
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full, opts, results);
    } else if (ent.isFile()) {
      results.push(full);
    }
  }
  return results;
}

module.exports = [
  // ── Read-only (analyst + developer) ─────────────────────────────────
  {
    name: 'system_list_dir',
    roles: ['analyst', 'developer'],
    description: 'List entries (files + directories) inside a directory under your working directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path; defaults to "."' } }
    },
    async execute({ path: p }, { working_directory }) {
      const abs = resolveSafe(working_directory, p);
      const entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
        .map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : (e.isSymbolicLink() ? 'symlink' : 'file')
        }));
      return JSON.stringify({ path: rel(working_directory, abs), entries });
    }
  },

  {
    name: 'system_read_file',
    roles: ['analyst', 'developer'],
    description: 'Read a text file (max 200KB; binary files are rejected).',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string' } }
    },
    async execute({ path: p }, { working_directory }) {
      const abs = resolveSafe(working_directory, p);
      const stat = fs.statSync(abs);
      if (!stat.isFile()) throw new Error(`not a file: ${p}`);
      if (stat.size > MAX_READ_BYTES) {
        throw new Error(`file too large (${stat.size} bytes; max ${MAX_READ_BYTES}). Use system_grep / system_glob to narrow it down.`);
      }
      const buf = fs.readFileSync(abs);
      // Reject if non-text (heuristic: nulls in first 1024 bytes).
      if (buf.slice(0, 1024).includes(0)) {
        throw new Error(`binary file refused: ${p}`);
      }
      return buf.toString('utf8');
    }
  },

  {
    name: 'system_glob',
    roles: ['analyst', 'developer'],
    description: 'Find files by glob pattern (e.g. "src/**/*.js"). Returns up to 500 paths.',
    parameters: {
      type: 'object',
      required: ['pattern'],
      properties: { pattern: { type: 'string' } }
    },
    async execute({ pattern }, { working_directory }) {
      const root = resolveSafe(working_directory, '.');
      const files = walk(root, { limit: 5000 }).map((f) => rel(working_directory, f));
      const re = globToRegex(pattern);
      const matches = files.filter((f) => re.test(f)).slice(0, MAX_GREP_RESULTS);
      return JSON.stringify({ pattern, count: matches.length, matches });
    }
  },

  {
    name: 'system_grep',
    roles: ['analyst', 'developer'],
    description: 'Search file contents with a regex. Returns up to 500 matches with file:line:line_content.',
    parameters: {
      type: 'object',
      required: ['regex'],
      properties: {
        regex:    { type: 'string', description: 'JavaScript regex source (no slashes/flags)' },
        path_glob:{ type: 'string', description: 'Optional file glob; defaults to all text files' },
        flags:    { type: 'string', description: 'Optional regex flags (e.g. "i")' }
      }
    },
    async execute({ regex, path_glob, flags }, { working_directory }) {
      const root = resolveSafe(working_directory, '.');
      const fileMatcher = path_glob ? globToRegex(path_glob) : null;
      const re = new RegExp(regex, flags || '');
      const files = walk(root, { limit: 5000 }).map((f) => rel(working_directory, f));
      const target = files.filter((f) => !fileMatcher || fileMatcher.test(f));
      const matches = [];
      for (const f of target) {
        if (matches.length >= MAX_GREP_RESULTS) break;
        let buf;
        try { buf = fs.readFileSync(path.join(working_directory, f)); }
        catch (_e) { continue; }
        if (buf.slice(0, 1024).includes(0)) continue;          // skip binary
        if (buf.length > MAX_READ_BYTES) continue;             // skip huge
        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matches.push({ file: f, line: i + 1, text: lines[i].slice(0, 240) });
            if (matches.length >= MAX_GREP_RESULTS) break;
          }
        }
      }
      return JSON.stringify({ regex, count: matches.length, matches });
    }
  },

  // ── Write (developer only) ──────────────────────────────────────────
  {
    name: 'system_write_file',
    roles: ['developer'],
    description: 'Create or overwrite a file with content. Creates parent directories as needed.',
    parameters: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path:    { type: 'string' },
        content: { type: 'string' }
      }
    },
    async execute({ path: p, content }, { working_directory }) {
      const abs = resolveSafe(working_directory, p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      return JSON.stringify({ wrote: rel(working_directory, abs), bytes: Buffer.byteLength(content) });
    }
  },

  {
    name: 'system_edit_file',
    roles: ['developer'],
    description: 'Replace an exact string in a file with new content. The old_string must match exactly once. For multiple occurrences, scope with more surrounding context.',
    parameters: {
      type: 'object',
      required: ['path', 'old_string', 'new_string'],
      properties: {
        path:       { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' }
      }
    },
    async execute({ path: p, old_string, new_string }, { working_directory }) {
      const abs = resolveSafe(working_directory, p);
      const content = fs.readFileSync(abs, 'utf8');
      const first = content.indexOf(old_string);
      if (first === -1) throw new Error(`old_string not found in ${p}`);
      const second = content.indexOf(old_string, first + old_string.length);
      if (second !== -1) {
        throw new Error(`old_string matches more than once in ${p}; add surrounding context`);
      }
      const updated = content.slice(0, first) + new_string + content.slice(first + old_string.length);
      fs.writeFileSync(abs, updated);
      return JSON.stringify({ edited: rel(working_directory, abs), bytes_delta: updated.length - content.length });
    }
  },

  {
    name: 'system_bash',
    roles: ['developer'],
    description: 'Run a shell command inside your working directory. Output is truncated at 64KB. Use for builds, tests, git operations — prefer dedicated tools (read/write/edit/glob/grep) where one exists.',
    parameters: {
      type: 'object',
      required: ['command'],
      properties: {
        command:        { type: 'string' },
        timeout_seconds:{ type: 'integer', description: 'Default 120; max 600.' }
      }
    },
    async execute({ command, timeout_seconds }, { working_directory }) {
      if (!working_directory) {
        throw new Error('no working_directory configured');
      }
      const timeout = Math.min(Math.max(timeout_seconds || 120, 1), 600) * 1000;
      log.info(`bash: ${command.slice(0, 120)}`);
      return new Promise((resolve) => {
        execFile('/bin/sh', ['-c', command], {
          cwd: working_directory,
          timeout,
          maxBuffer: MAX_BASH_OUTPUT * 2,    // childStdout + childStderr buffer
          env: process.env
        }, (err, stdout, stderr) => {
          const out = (stdout || '').slice(0, MAX_BASH_OUTPUT);
          const errOut = (stderr || '').slice(0, MAX_BASH_OUTPUT);
          resolve(JSON.stringify({
            exit_code: err ? (err.code ?? 1) : 0,
            stdout:    out,
            stderr:    errOut,
            timed_out: !!(err && err.killed && err.signal === 'SIGTERM')
          }));
        });
      });
    }
  }
];
