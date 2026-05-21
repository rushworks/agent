"use strict";

const log = require('./Log');

// Thin wrapper over the model provider SDK. v1 supports Anthropic only;
// OpenAI / others can land as additional provider blocks without changing
// the public chat() interface.

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

class LLM {
  constructor({ provider = 'anthropic', model = 'claude-sonnet-4-6', maxTokens = 16384 } = {}) {
    this.provider = provider;
    this.model = model;
    this.maxTokens = maxTokens;
    this.client = null;
  }

  async init(apiKey) {
    if (!apiKey) throw new Error(`no API key for provider=${this.provider}`);
    if (this.provider === 'anthropic') {
      const Anthropic = require('@anthropic-ai/sdk');
      // We do our own retries with retry-after honoring + visible logging.
      // Disable the SDK's transparent retries so they don't stack.
      this.client = new Anthropic({ apiKey, maxRetries: 0 });
    } else {
      throw new Error(`unsupported provider: ${this.provider}`);
    }
    log.info(`LLM ready: ${this.provider} / ${this.model}`);
  }

  async chat({ system, messages, tools, cacheSystem = false, cacheTools = false }) {
    if (!this.client) throw new Error('LLM not initialized');
    const params = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages
    };
    if (system) params.system = this._maybeCachedSystem(system, cacheSystem);
    if (tools && tools.length > 0) params.tools = this._maybeCachedTools(tools, cacheTools);
    log.debug(`chat: ${messages.length} msgs, ${(tools || []).length} tools`);

    const res = await this._callWithRetry(() => this.client.messages.create(params));

    const u = res.usage || {};
    if (u.cache_read_input_tokens || u.cache_creation_input_tokens) {
      log.debug(`chat done: stop=${res.stop_reason}, in=${u.input_tokens || 0}, cached_read=${u.cache_read_input_tokens || 0}, cached_write=${u.cache_creation_input_tokens || 0}, out=${u.output_tokens || 0}`);
    } else {
      log.debug(`chat done: stop=${res.stop_reason}, in=${u.input_tokens || 0}, out=${u.output_tokens || 0}`);
    }

    // Surface the "empty response" pathology explicitly. Sonnet/Opus
    // occasionally returns end_turn with zero content blocks — no tool
    // call, no text. Downstream this manifests as silent task completion
    // or a mention that never replies; without this warn it's almost
    // impossible to spot from the iter logs alone.
    if (res.stop_reason === 'end_turn' && (!res.content || res.content.length === 0)) {
      log.warn(`LLM returned empty end_turn (0 content blocks) — model produced no output. usage: in=${u.input_tokens || 0}, out=${u.output_tokens || 0}`);
    }
    return res;
  }

  // Convert a string system prompt to a content block array with a
  // cache_control marker so system + tools are cached for ~5 minutes.
  // The skill prompt + inlined CLAUDE.md are stable across an agent
  // session, so on iter 2+ we read them from cache rather than billing
  // them as fresh input each turn. Crosses the 1024-token minimum easily.
  _maybeCachedSystem(system, enable) {
    if (!enable) return system;
    if (typeof system === 'string') {
      return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    }
    const arr = system.slice();
    if (arr.length > 0) {
      arr[arr.length - 1] = { ...arr[arr.length - 1], cache_control: { type: 'ephemeral' } };
    }
    return arr;
  }

  _maybeCachedTools(tools, enable) {
    if (!enable || tools.length === 0) return tools;
    const out = tools.slice();
    out[out.length - 1] = { ...out[out.length - 1], cache_control: { type: 'ephemeral' } };
    return out;
  }

  // Retry loop honoring retry-after / retry-after-ms headers from the
  // provider. Non-retryable errors propagate unchanged.
  async _callWithRetry(fn, { maxRetries = 4 } = {}) {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err) {
        const status = err && err.status;
        if (!RETRYABLE_STATUSES.has(status)) throw err;
        attempt += 1;
        if (attempt > maxRetries) {
          log.warn(`LLM call exceeded ${maxRetries} retries on status ${status} — giving up`);
          throw err;
        }
        const waitMs = this._waitMsFor(err, attempt);
        log.warn(`LLM call ${status} — waiting ${Math.round(waitMs / 1000)}s and retrying (attempt ${attempt}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  // Pick the wait before the next attempt. Honor retry-after if present;
  // otherwise exponential backoff with a 60s cap.
  _waitMsFor(err, attempt) {
    const headers = err && err.headers;
    if (headers) {
      const raMs = this._readHeader(headers, 'retry-after-ms');
      if (raMs) return Math.min(120000, Math.max(1000, parseInt(raMs, 10) || 0));
      const ra = this._readHeader(headers, 'retry-after');
      if (ra) return Math.min(120000, Math.max(1000, (parseInt(ra, 10) || 0) * 1000));
    }
    return Math.min(60000, 1000 * Math.pow(2, attempt));
  }

  _readHeader(headers, name) {
    try {
      if (typeof headers.get === 'function') return headers.get(name);
      if (typeof headers === 'object') return headers[name] || headers[name.toLowerCase()];
    } catch (_) { /* ignore */ }
    return null;
  }
}

module.exports = LLM;
