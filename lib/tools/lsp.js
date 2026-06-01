"use strict";

const path = require('path');
const LspClient = require('../lsp/Client');

// LSP-based code intelligence tools. Developer-only — analysts don't have
// a working directory. The LSP client is lazy-initialized on first call and
// persists for the agent's process lifetime.
//
// All tools accept 1-based line numbers (matching grep output and editor
// UIs) and convert to 0-based for the LSP protocol.

function requireWorkingDir(context) {
  if (!context.working_directory) {
    throw new Error('No working_directory configured — LSP tools require local repo access (BYOA agents only)');
  }
  return context.working_directory;
}

function toAbsolute(wd, filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(wd, filePath);
}

function formatLocations(result, wd) {
  if (!result) return '(no results)';
  const locations = Array.isArray(result) ? result : [result];
  if (locations.length === 0) return '(no results)';
  return locations.map(loc => {
    const uri = loc.uri || loc.targetUri || '';
    let file = uri.replace(/^file:\/\//, '');
    if (file.startsWith(wd)) file = file.slice(wd.length + 1);
    const line = ((loc.range || loc.targetRange || {}).start || {}).line;
    const char = ((loc.range || loc.targetRange || {}).start || {}).character;
    const lineNum = typeof line === 'number' ? line + 1 : '?';
    const charNum = typeof char === 'number' ? char + 1 : '?';
    return `${file}:${lineNum}:${charNum}`;
  }).join('\n');
}

module.exports = [
  {
    name: 'code_definition',
    roles: ['developer'],
    description: 'Go to definition: find where a symbol (function, class, variable, type) is defined. Provide the file path and the 1-based line + column where the symbol appears. Returns the file and line where it is defined.',
    parameters: {
      type: 'object',
      required: ['file', 'line', 'column'],
      properties: {
        file:   { type: 'string', description: 'File path (relative to repo root or absolute)' },
        line:   { type: 'integer', description: '1-based line number' },
        column: { type: 'integer', description: '1-based column number' }
      }
    },
    async execute({ file, line, column }, context) {
      const wd = requireWorkingDir(context);
      const absPath = toAbsolute(wd, file);
      const client = await LspClient.get(wd);
      const result = await client.definition(absPath, line - 1, column - 1);
      return formatLocations(result, wd);
    }
  },

  {
    name: 'code_references',
    roles: ['developer'],
    description: 'Find all references: locate every usage of a symbol across the codebase. Provide the file path and the 1-based line + column where the symbol appears. Returns all files and lines where it is referenced.',
    parameters: {
      type: 'object',
      required: ['file', 'line', 'column'],
      properties: {
        file:   { type: 'string', description: 'File path (relative to repo root or absolute)' },
        line:   { type: 'integer', description: '1-based line number' },
        column: { type: 'integer', description: '1-based column number' }
      }
    },
    async execute({ file, line, column }, context) {
      const wd = requireWorkingDir(context);
      const absPath = toAbsolute(wd, file);
      const client = await LspClient.get(wd);
      const result = await client.references(absPath, line - 1, column - 1);
      return formatLocations(result, wd);
    }
  },

  {
    name: 'code_diagnostics',
    roles: ['developer'],
    description: 'Get type errors and diagnostics for a file from the TypeScript language server. Returns compiler errors, warnings, and suggestions without running tsc directly.',
    parameters: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', description: 'File path (relative to repo root or absolute)' }
      }
    },
    async execute({ file }, context) {
      const wd = requireWorkingDir(context);
      const absPath = toAbsolute(wd, file);
      const client = await LspClient.get(wd);
      const result = await client.diagnostics(absPath);
      const items = (result && result.items) || [];
      if (items.length === 0) return 'No diagnostics (clean).';
      return items.map(d => {
        const line = ((d.range || {}).start || {}).line;
        const lineNum = typeof line === 'number' ? line + 1 : '?';
        const sev = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }[d.severity] || 'unknown';
        return `${lineNum}: [${sev}] ${d.message}`;
      }).join('\n');
    }
  }
];
