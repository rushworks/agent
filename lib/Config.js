"use strict";

const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require('./Log');

// Local config lives at ~/.rushworks/agent.json. We pick a per-user file
// rather than a project-rooted .rushworksrc so the same user can drive
// multiple agents (or projects) from one machine. Secrets stored here are
// 0600 to keep nosy roommates out; users are responsible for full-disk
// encryption otherwise.

const CONFIG_DIR  = path.join(os.homedir(), '.rushworks');
const CONFIG_PATH = path.join(CONFIG_DIR, 'agent.json');

// Canonical portal URL for the public BYOA install path. Hardcoded
// so the init wizard never prompts for it. Local dev / staging
// overrides via RW_PORTAL_URL env var at runtime (resolveConfig
// gives env precedence over file values).
const PORTAL_URL_DEFAULT = 'https://rushworks.ai';

const DEFAULTS = {
  // Identity
  portal_url: PORTAL_URL_DEFAULT,    // overridden at runtime by RW_PORTAL_URL env
  agent_token: null,                 // rwsk_... — your one-time-shown bearer

  // Model
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  anthropic_api_key: null,
  max_tokens: 16384,

  // Behaviour
  working_directory: null,           // dev role only; absolute path
  poll_interval_seconds: 30,         // catchup poll fallback when WS is down
  max_concurrent_tasks: 1,
  max_iterations_per_task: 20
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (err) {
    log.warn(`Could not read ${CONFIG_PATH}: ${err.message}`);
    return { ...DEFAULTS };
  }
}

function saveConfig(cfg) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return CONFIG_PATH;
}

// Final config = file < env overrides. Env vars are useful for ephemeral
// CI runs and `npx` invocations that don't want to touch the filesystem.
function resolveConfig() {
  const fileCfg = loadConfig();
  const env = process.env;
  return {
    portal_url:              env.RW_PORTAL_URL              || fileCfg.portal_url,
    agent_token:             env.RW_AGENT_TOKEN             || fileCfg.agent_token,
    provider:                env.RW_PROVIDER                || fileCfg.provider,
    model:                   env.RW_MODEL                   || fileCfg.model,
    anthropic_api_key:       env.ANTHROPIC_API_KEY          || env.RW_ANTHROPIC_API_KEY || fileCfg.anthropic_api_key,
    max_tokens:              parseInt(env.RW_MAX_TOKENS, 10)        || fileCfg.max_tokens,
    working_directory:       env.RW_WORKING_DIRECTORY       || fileCfg.working_directory,
    poll_interval_seconds:   parseInt(env.RW_POLL_INTERVAL, 10)     || fileCfg.poll_interval_seconds,
    max_concurrent_tasks:    parseInt(env.RW_MAX_CONCURRENT, 10)    || fileCfg.max_concurrent_tasks,
    max_iterations_per_task: parseInt(env.RW_MAX_ITERATIONS, 10)    || fileCfg.max_iterations_per_task
  };
}

// Validate that a token resolves on the configured portal. Returns the
// whoami payload on success; throws on failure. We use this from the CLI
// `init` flow and on every `start` to fail fast on a bad token.
async function verifyToken({ portal_url, agent_token }) {
  if (!portal_url) throw new Error('portal_url is not configured');
  if (!agent_token) throw new Error('agent_token is not configured');
  if (!/^rwsk_[A-Za-z0-9_\-]+$/.test(agent_token)) {
    throw new Error('agent_token does not look like a Rushworks token (rwsk_...)');
  }
  const res = await fetch(`${portal_url.replace(/\/$/, '')}/api/agent/whoami`, {
    headers: { 'Authorization': `Bearer ${agent_token}` }
  });
  if (!res.ok) {
    throw new Error(`Portal returned ${res.status} ${res.statusText} — check token / URL`);
  }
  return res.json();
}

module.exports = {
  CONFIG_PATH,
  PORTAL_URL_DEFAULT,
  loadConfig,
  saveConfig,
  resolveConfig,
  verifyToken,
  DEFAULTS
};
