"use strict";

// Portal-defined tools.
//
// The portal ships some tool specs in /api/agent/policies (v3+):
//   { name, roles, description, parameters, method, path }
// so new portal surfaces reach running agents without a runtime release,
// and the playbook (what each tool is FOR) stays portal-side. This module
// only turns a spec into an executable tool. It is deliberately strict:
//
//   - method must be GET or POST
//   - path must be an absolute path under /api/agent/ (the agent API this
//     runtime already holds a bearer token for); never another host
//   - {placeholders} are filled from the input, must be integers or simple
//     slugs, and are removed from the body/query
//   - writes are not retried (a retried proposal would post twice)
//
// A spec that fails validation is skipped with a warning, never trusted.

const NAME_RE = /^[a-z0-9_]{1,64}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

function validSpec(spec) {
  if (!spec || typeof spec !== 'object') return 'not an object';
  if (!NAME_RE.test(spec.name || '')) return 'bad name';
  if (!['GET', 'POST'].includes(spec.method)) return 'method must be GET or POST';
  if (typeof spec.path !== 'string' || !spec.path.startsWith('/api/agent/')) return 'path must start with /api/agent/';
  if (spec.path.includes('..') || spec.path.includes('//') || /[?#\s]/.test(spec.path)) return 'path not allowed';
  if (spec.parameters && typeof spec.parameters !== 'object') return 'bad parameters';
  return null;
}

/** Fill {placeholders}; returns { path, rest } or throws. */
function bindPath(template, input) {
  const rest = { ...(input || {}) };
  const path = template.replace(/\{([a-z_]+)\}/g, (_m, key) => {
    const v = rest[key];
    delete rest[key];
    if (v === undefined || v === null || !SAFE_SEGMENT.test(String(v))) {
      throw new Error(`missing or invalid ${key}`);
    }
    return encodeURIComponent(String(v));
  });
  return { path, rest };
}

/**
 * @param specs  policies.tools (may be undefined on older portals)
 * @param role   this agent's role
 * @param log    optional logger with warn()
 * @returns tool objects shaped like lib/tools/* entries, flagged portalDefined
 */
function build(specs, role, log) {
  if (!Array.isArray(specs)) return [];
  const out = [];
  for (const spec of specs) {
    const problem = validSpec(spec);
    if (problem) { if (log) log.warn(`portal tool skipped (${spec && spec.name}): ${problem}`); continue; }
    if (Array.isArray(spec.roles) && spec.roles.length && !spec.roles.includes(role)) continue;
    out.push({
      name: spec.name,
      roles: spec.roles,
      description: String(spec.description || ''),
      parameters: spec.parameters || { type: 'object', properties: {} },
      portalDefined: true,
      async execute(input, { portal }) {
        const { path, rest } = bindPath(spec.path, input);
        const r = spec.method === 'GET'
          ? await portal.request('GET', path, { query: rest })
          : await portal.request('POST', path, { body: rest, retries: 1 });
        return typeof r === 'string' ? r : JSON.stringify(r);
      }
    });
  }
  return out;
}

module.exports = { build, validSpec, bindPath };
