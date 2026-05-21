"use strict";

const { io } = require('socket.io-client');
const log = require('./Log');

// Wraps the agent's WebSocket connection to the portal. Reconnect is
// handled by socket.io-client itself; we just expose a small EventTarget-
// like surface so the Agent can subscribe to logical events without
// caring about the socket lifecycle.
//
// Server-side, the agent is auto-joined to every project room it has a
// project_agents row for, plus its personal agent:<id> room. Events come
// in three flavours:
//   task:event          - any task touched in any of your projects
//   message:event       - new channel message in any of your projects
//   notification:event  - a direct ping at this agent

class Realtime {
  constructor({ portalUrl, agentToken }) {
    this.portalUrl  = portalUrl;
    this.agentToken = agentToken;
    this.sock = null;
    this.connected = false;
    this.lastReady = null;
    this.handlers = {
      ready:        new Set(),
      task:         new Set(),
      message:      new Set(),
      notification: new Set(),
      disconnect:   new Set()
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
      log.warn(`realtime connect_error: ${err.message}`);
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
    if (this.sock) {
      this.sock.close();
      this.sock = null;
      this.connected = false;
    }
  }
}

module.exports = Realtime;
