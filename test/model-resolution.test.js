"use strict";

// TRIPWIRE for Sprint 1 Workstream B (agent#21), re-verified after the
// Update-era merge (Sprint 2 W1).
//
// Why this exists: B's model-resolution block lives in lib/Agent.js, which is
// the ONE file both `main` and `repo-as-truth-updates` modified. A merge
// resolved in favour of the Update-era file would silently drop the whole
// feature — no error, no conflict marker, just an agent that quietly ignores
// the portal's model setting forever.
//
// Git happened to auto-merge it correctly this time. That is luck, not a
// guarantee, so the behaviour is pinned here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const Config = require('../lib/Config');
const ROOT = path.join(__dirname, '..');

test('runtime default is the doc-checked pick from Workstream B', () => {
  assert.equal(Config.DEFAULTS.model, 'claude-opus-5');
});

test('LLM fallback literal cannot silently disagree with Config', () => {
  const llm = fs.readFileSync(path.join(ROOT, 'lib', 'LLM.js'), 'utf8');
  const m = llm.match(/model\s*=\s*'([^']+)'/);
  assert.ok(m, 'LLM.js must carry a default model literal');
  assert.equal(m[1], Config.DEFAULTS.model,
    'LLM.js default and Config.DEFAULTS.model must be the same string');
});

test('Agent.js still CONTAINS the portal-override resolution (survived the merge)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'Agent.js'), 'utf8');
  // Assert on code shapes, not prose (Sprint 1 anchor rule).
  assert.match(src, /let\s+portalModel\s*=\s*null/,
    'portalModel must be declared');
  assert.match(src, /portalModel\s*=\s*\(resp && typeof resp\.model === 'string' && resp\.model\)/,
    'portalModel must be POPULATED from the policies payload, not merely referenced');
  assert.match(src, /const\s+resolvedModel\s*=\s*portalModel\s*\|\|\s*this\.config\.model/,
    'resolution must prefer the portal value over local config');
  assert.match(src, /model:\s*resolvedModel/,
    'the LLM must be constructed with the RESOLVED model, not this.config.model');
});

test('Agent.js does not construct the LLM with the unresolved config model', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'Agent.js'), 'utf8');
  const llmBlock = src.slice(src.indexOf('new LLM('), src.indexOf('new LLM(') + 200);
  assert.ok(!/model:\s*this\.config\.model/.test(llmBlock),
    'the pre-B form (model: this.config.model) must not come back');
});

// The precedence rule itself, as behaviour rather than as source text.
const resolve = (portalModel, localModel) => portalModel || localModel;

test('resolution order: portal config -> env/local -> runtime default', () => {
  assert.equal(resolve('claude-haiku-4-5', 'claude-opus-5'), 'claude-haiku-4-5',
    'portal wins over local');
  assert.equal(resolve(null, 'claude-sonnet-5'), 'claude-sonnet-5',
    'local used when the portal sets none');
  assert.equal(resolve(null, Config.DEFAULTS.model), 'claude-opus-5',
    'built-in default when neither is set');
  assert.equal(resolve('', 'claude-opus-5'), 'claude-opus-5',
    'an empty portal value is not an override');
});

test('an older portal (no model field) degrades to local config', () => {
  // policies payload v1 has no `model` key at all.
  const resp = { version: 1, role: 'developer', policies: {} };
  const portalModel = (resp && typeof resp.model === 'string' && resp.model) || null;
  assert.equal(portalModel, null);
  assert.equal(resolve(portalModel, Config.DEFAULTS.model), 'claude-opus-5');
});
