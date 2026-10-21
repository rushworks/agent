"use strict";

// Portal-defined tools, disabled tools and card triggers (policies v3).
// The runtime must stay a generic executor: these tests pin that it only
// ever calls the agent API, binds placeholders strictly, and leaves an
// older portal's behaviour unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const { build, validSpec, bindPath } = require('../lib/tools/portalDefined');
const ToolRunner = require('../lib/ToolRunner');
const { cardTriggerFor } = require('../lib/Agent');

const spec = (over = {}) => ({
  name: 'portal_propose', roles: ['analyst'], description: 'Propose work',
  parameters: { type: 'object', required: ['project_id'], properties: { project_id: { type: 'integer' } } },
  method: 'POST', path: '/api/agent/projects/{project_id}/proposals', ...over
});

test('specs outside the agent API are refused', () => {
  assert.equal(validSpec(spec()), null);
  assert.match(validSpec(spec({ path: 'https://evil.test/x' })), /\/api\/agent\//);
  assert.match(validSpec(spec({ path: '/api/connect/x' })), /\/api\/agent\//);
  assert.match(validSpec(spec({ path: '/api/agent/../../admin' })), /not allowed/);
  assert.match(validSpec(spec({ path: '/api/agent/x?y=1' })), /not allowed/);
  assert.match(validSpec(spec({ method: 'DELETE' })), /GET or POST/);
  assert.match(validSpec(spec({ name: 'Bad Name!' })), /bad name/);
  assert.deepEqual(build([spec({ path: 'https://evil.test' })], 'analyst'), [], 'an invalid spec is skipped, not trusted');
});

test('placeholders bind strictly and leave the rest as the body', () => {
  assert.deepEqual(bindPath('/api/agent/projects/{project_id}/feedback/{message_id}/triage', { project_id: 5, message_id: 9, title: 'x' }),
    { path: '/api/agent/projects/5/feedback/9/triage', rest: { title: 'x' } });
  assert.throws(() => bindPath('/api/agent/projects/{project_id}', {}), /missing or invalid project_id/);
  assert.throws(() => bindPath('/api/agent/projects/{project_id}', { project_id: '../admin' }), /invalid/);
});

test('tools are role-filtered and call the portal with the bound path', async () => {
  assert.equal(build([spec()], 'developer').length, 0);
  const [tool] = build([spec(), spec({ name: 'portal_get_board', method: 'GET', path: '/api/agent/projects/{project_id}/board' })], 'analyst');
  const calls = [];
  const portal = { request: async (m, p, o) => { calls.push([m, p, o]); return { ok: true }; } };
  const out = await tool.execute({ project_id: 7, tasks: [{ title: 'A' }] }, { portal });
  assert.equal(out, '{"ok":true}');
  assert.deepEqual(calls[0], ['POST', '/api/agent/projects/7/proposals', { body: { tasks: [{ title: 'A' }] }, retries: 1 }],
    'writes are not retried');
  const [, get] = build([spec(), spec({ name: 'portal_get_board', method: 'GET', path: '/api/agent/projects/{project_id}/board' })], 'analyst');
  await get.execute({ project_id: 7 }, { portal });
  assert.deepEqual(calls[1], ['GET', '/api/agent/projects/7/board', { query: {} }]);
});

test('ToolRunner: disabled tools vanish, portal tools register, old portals change nothing', () => {
  const tr = new ToolRunner();
  tr.loadForRole('analyst');
  const before = tr.size;
  assert.ok(tr.has('portal_activate_update'), 'built-in present by default');

  tr.loadForRole('analyst', { disabled_tools: ['portal_activate_update'], tools: [spec()] });
  assert.equal(tr.has('portal_activate_update'), false, 'disabled by policy');
  assert.ok(tr.has('portal_propose'));
  assert.equal(tr.isPortalDefined('portal_propose'), true);
  assert.equal(tr.isPortalDefined('portal_post_message'), false);
  assert.equal(tr.size, before, 'one removed, one added');

  tr.loadForRole('analyst', {});
  assert.equal(tr.size, before, 'no policies keys: unchanged');
});

test('card triggers match kind and filters, nothing else', () => {
  const policies = { card_triggers: {
    feedback: { match: { 'metadata.status': ['new'] }, instructions: 'triage' },
    summary: { match: {} }
  } };
  assert.ok(cardTriggerFor(policies, { kind: 'feedback', metadata: { status: 'new' } }));
  assert.equal(cardTriggerFor(policies, { kind: 'feedback', metadata: { status: 'triaged' } }), null, 'already triaged');
  assert.ok(cardTriggerFor(policies, { kind: 'summary', metadata: null }), 'empty match accepts the kind');
  assert.ok(cardTriggerFor(policies, { message_kind: 'summary' }), 'polling payloads use message_kind');
  assert.equal(cardTriggerFor(policies, { kind: 'human', body: 'hi' }), null);
  assert.equal(cardTriggerFor({}, { kind: 'feedback', metadata: { status: 'new' } }), null, 'older portal: no triggers');
  assert.equal(cardTriggerFor(policies, { kind: 'constructor' }), null, 'no prototype keys');
});
