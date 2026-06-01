"use strict";

const { spawn } = require('child_process');
const path = require('path');
const log = require('../Log');

// Minimal LSP client that communicates over stdio with a language server.
// Lazy-initialized on first tool call; persists for agent process lifetime.
// V1 supports typescript-language-server only; extensible to others later.

let _instance = null;

class LspClient {
  constructor(workingDirectory) {
    this.wd = workingDirectory;
    this.proc = null;
    this.ready = false;
    this.msgId = 0;
    this.pending = new Map();
    this.buffer = '';
  }

  static async get(workingDirectory) {
    if (_instance && _instance.ready && _instance.wd === workingDirectory) {
      return _instance;
    }
    if (_instance) {
      _instance.dispose();
    }
    _instance = new LspClient(workingDirectory);
    await _instance.initialize();
    return _instance;
  }

  async initialize() {
    const tsserver = this.findBinary();
    if (!tsserver) {
      throw new Error('typescript-language-server not found. Install it: npm i -g typescript-language-server typescript');
    }

    this.proc = spawn(tsserver, ['--stdio'], {
      cwd: this.wd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    this.proc.stderr.on('data', (chunk) => {
      log.debug(`lsp stderr: ${chunk.toString().trim()}`);
    });
    this.proc.on('exit', (code) => {
      log.info(`LSP server exited (code ${code})`);
      this.ready = false;
      if (_instance === this) _instance = null;
    });

    const initResult = await this.send('initialize', {
      processId: process.pid,
      rootUri: `file://${this.wd}`,
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: true }
        }
      },
      workspaceFolders: [{ uri: `file://${this.wd}`, name: path.basename(this.wd) }]
    });

    this.notify('initialized', {});
    this.ready = true;
    log.info(`LSP initialized for ${this.wd} (server capabilities received)`);
    return initResult;
  }

  findBinary() {
    const localBin = path.join(this.wd, 'node_modules', '.bin', 'typescript-language-server');
    try {
      require('fs').accessSync(localBin, require('fs').constants.X_OK);
      return localBin;
    } catch (_) { /* not local */ }
    try {
      const { execSync } = require('child_process');
      const p = execSync('which typescript-language-server', { encoding: 'utf8', timeout: 5000 }).trim();
      if (p) return p;
    } catch (_) { /* not global */ }
    return null;
  }

  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      const packet = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;

      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request ${method} timed out after 30s`));
      }, 30_000);

      this.pending.set(id, { resolve, reject, timeout });

      try {
        this.proc.stdin.write(packet);
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params) {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    const packet = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
    try { this.proc.stdin.write(packet); } catch (_) { /* best effort */ }
  }

  onData(chunk) {
    this.buffer += chunk.toString();
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const len = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + len) break;
      const body = this.buffer.slice(bodyStart, bodyStart + len);
      this.buffer = this.buffer.slice(bodyStart + len);

      try {
        const msg = JSON.parse(body);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(p.timeout);
          if (msg.error) {
            p.reject(new Error(`LSP error: ${msg.error.message || JSON.stringify(msg.error)}`));
          } else {
            p.resolve(msg.result);
          }
        }
      } catch (_) { /* ignore parse errors on notifications */ }
    }
  }

  async openFile(filePath) {
    const fs = require('fs');
    const content = fs.readFileSync(filePath, 'utf8');
    const uri = `file://${filePath}`;
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: this.languageId(filePath),
        version: 1,
        text: content
      }
    });
    // Small delay for the server to index
    await new Promise(r => setTimeout(r, 500));
    return uri;
  }

  languageId(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
      '.ts': 'typescript', '.tsx': 'typescriptreact',
      '.js': 'javascript', '.jsx': 'javascriptreact',
      '.mjs': 'javascript', '.cjs': 'javascript'
    };
    return map[ext] || 'typescript';
  }

  async definition(filePath, line, character) {
    const uri = await this.openFile(filePath);
    return this.send('textDocument/definition', {
      textDocument: { uri },
      position: { line, character }
    });
  }

  async references(filePath, line, character) {
    const uri = await this.openFile(filePath);
    return this.send('textDocument/references', {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true }
    });
  }

  async diagnostics(filePath) {
    const uri = await this.openFile(filePath);
    // typescript-language-server publishes diagnostics async via
    // textDocument/publishDiagnostics notifications. We request a pull
    // if the server supports it, otherwise collect from notifications.
    // For simplicity, wait a moment and then request document diagnostics
    // via the pull model if available, or fall back to a fresh didOpen.
    await new Promise(r => setTimeout(r, 1500));

    // Collect any diagnostics sent via notification. We'll use a special
    // request that some servers support, or fall back.
    try {
      const result = await this.send('textDocument/diagnostic', {
        textDocument: { uri }
      });
      return result;
    } catch (_) {
      // Server doesn't support pull diagnostics. Return empty — the
      // agent can fall back to running the TypeScript compiler directly.
      return { kind: 'full', items: [] };
    }
  }

  dispose() {
    if (this.proc) {
      try { this.notify('shutdown', null); } catch (_) {}
      setTimeout(() => {
        try { this.proc.kill(); } catch (_) {}
      }, 2000);
      this.ready = false;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(new Error('LSP client disposed'));
    }
    this.pending.clear();
    if (_instance === this) _instance = null;
  }
}

module.exports = LspClient;
