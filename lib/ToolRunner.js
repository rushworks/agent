"use strict";

const log = require('./Log');

// Tool registry + dispatcher. Loads ./tools/index.js, filters by agent
// role at boot, and converts between Anthropic's tool-name format (no
// dots/colons allowed) and our internal names.

class ToolRunner {
  constructor() {
    this.tools = new Map();
  }

  loadForRole(role) {
    this.tools.clear();
    const registry = require('./tools');
    if (!Array.isArray(registry)) {
      log.warn('tool registry did not return an array');
      return;
    }
    for (const tool of registry) {
      if (!tool.name || typeof tool.execute !== 'function') {
        log.warn(`skipping invalid tool: ${tool.name || '(unnamed)'}`);
        continue;
      }
      const allowed = !tool.roles || tool.roles.length === 0 || tool.roles.includes(role);
      if (!allowed) continue;
      this.tools.set(tool.name, tool);
    }
    log.info(`loaded ${this.tools.size} tools for role=${role}: ${[...this.tools.keys()].join(', ')}`);
  }

  // Anthropic tool names match ^[A-Za-z0-9_-]{1,64}$. Our names already
  // satisfy this since we use snake_case throughout, but we keep a
  // round-trip helper in case we ever add dotted names.
  toApiName(name)   { return name.replace(/\./g, '_'); }
  fromApiName(api)  { for (const n of this.tools.keys()) if (this.toApiName(n) === api) return n; return api; }

  definitions() {
    const defs = [];
    for (const [name, tool] of this.tools) {
      defs.push({
        name:         this.toApiName(name),
        description:  tool.description || '',
        input_schema: tool.parameters || { type: 'object', properties: {} }
      });
    }
    return defs;
  }

  async execute(name, input, context) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`tool not found or not allowed for your role: ${name}`);

    // Session project lockdown. A mention or task session has an implicit
    // project the agent is acting on; tool calls that take a project_id
    // must operate on THAT project, regardless of what the LLM passes.
    // Closes the abuse case where a PM in project A says "@agent list
    // tasks for project B" — without this override, the call would
    // succeed if the agent had access to both. With it, the project_id
    // is silently rewritten and a warning logs the attempt so we can see
    // it. We don't surface an error to the LLM because the goal isn't to
    // confuse the model; it's to make the LLM physically unable to act
    // on the wrong project.
    const effectiveInput = input || {};
    const session = context && context.sessionProjectId;
    if (session !== undefined && session !== null
        && effectiveInput.project_id !== undefined
        && effectiveInput.project_id !== null
        && Number(effectiveInput.project_id) !== Number(session)) {
      log.warn(`tool ${name} called with project_id=${effectiveInput.project_id} but session locked to project=${session}; overriding`);
      effectiveInput.project_id = session;
    }

    log.debug(`exec ${name} ${JSON.stringify(effectiveInput).slice(0, 200)}`);
    const out = await tool.execute(effectiveInput, context);
    return typeof out === 'string' ? out : JSON.stringify(out);
  }

  has(name)   { return this.tools.has(name); }
  get size()  { return this.tools.size; }
}

module.exports = ToolRunner;
