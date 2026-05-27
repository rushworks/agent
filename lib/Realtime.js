"use strict";

const { io } = require('socket.io-client');
const log = require('./Log');

const MAX_AUTH_RETRIES = 10;
const AUTH_BACKOFF_BASE_MS = 5_000;
const AUTH_BACKOFF_CAP_MS = 300_000;

class Realtime {
  constructor({ portalUrl, agentToken }) {
    this.portalUrl  = portalUrl;
    this.agentToken = agentToken;
    this.sock = null;
    this.connected = false;
    this.lastReady = null;
    this.authFailCount = 0;
    this.authRetryTimer = null;
    this.handlers = {
      ready:          new Set(),
      task:           new Set(),
      message:        new Set(),
      notification:   new Set(),
      disconnect:     new Set(),
      auth_exhausted: new Set()
    };
  }

  on(event, fn) {
    if (!this.handlers[event]) throw new Error(`unknown realtime event: ${event}`);
    this.handlers[event].add(fn);
    return () => this.handlers[event].delete(fn);
  }

  emit(event, payload) {
    for (const fn of this.handlers[event]) {
      try { fn(payload); }
      catch (err) { log.error(`realtime handler for ${event} threw:`, err.message); }
    }
  }

  connect() {
    if (this.sock) return;

    this.sock = io(this.portalUrl, {
      auth: { token: this.agentToken },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
      timeout: 20_000
    });

    this.sock.on('connect', () => {
      this.connected = true;
      this.authFailCount = 0;
      if (this.authRetryTimer) { clearTimeout(this.authRetryTimer); this.authRetryTimer = null; }
      log.info(`realtime connected (sid=${this.sock.id})`);
    });

    this.sock.on('ready', (payload) => {
      this.lastReady = payload;
      log.info(`realtime subscribed to projects: [${(payload.project_ids || []).join(', ')}]`);
      this.emit('ready', payload);
    });

    this.sock.on('task:event', (payload) => {
      log.debug('task:event', JSON.stringify(payload).slice(0, 200));
      this.emit('task', payload);
    });

    this.sock.on('message:event', (payload) => {
      log.debug('message:event', JSON.stringify(payload).slice(0, 200));
      this.emit('message', payload);
    });

    this.sock.on('notification:event', (payload) => {
      log.debug('notification:event', JSON.stringify(payload).slice(0, 200));
      this.emit('notification', payload);
    });

    this.sock.on('disconnect', (reason) => {
      this.connected = false;
      log.warn(`realtime disconnected: ${reason}`);
      this.emit('disconnect', { reason });
    });

    this.sock.on('connect_error', (err) => {
      const isAuth = /unauthorized|forbidden/i.test(err.message);
      if (!isAuth) {
        log.warn(`realtime connect_error: ${err.message}`);
        return;
      }

      this.authFailCount++;
      log.warn(`realtime connect_error: ${err.message} (auth failure ${this.authFailCount}/${MAX_AUTH_RETRIES})`);

      if (this.authFailCount >= MAX_AUTH_RETRIES) {
        log.error(`realtime: ${MAX_AUTH_RETRIES} consecutive auth failures — giving up`);
        this.sock.disconnect();
        this.emit('auth_exhausted', { failures: this.authFailCount });
        return;
      }

      const delay = Math.min(AUTH_BACKOFF_BASE_MS * Math.pow(2, this.authFailCount - 1), AUTH_BACKOFF_CAP_MS);
      log.info(`realtime: will retry in ${Math.round(delay / 1000)}s`);
      this.sock.disconnect();
      this.authRetryTimer = setTimeout(() => this.sock.connect(), delay);
    });
  }

  // Cheap heartbeat — confirms the connection is alive without an HTTP call.
  ping() {
    return new Promise((resolve) => {
      if (!this.connected) return resolve({ ok: false, reason: 'disconnected' });
      this.sock.timeout(5_000).emit('ping', null, (err, ack) => {
        if (err) return resolve({ ok: false, reason: err.message });
        resolve(ack || { ok: true });
      });
    });
  }

  close() {
    if (this.authRetryTimer) { clearTimeout(this.authRetryTimer); this.authRetryTimer = null; }
    if (this.sock) {
      this.sock.close();
      this.sock = null;
      this.connected = false;
    }
  }
}

module.exports = Realtime;
