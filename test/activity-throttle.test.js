"use strict";

// Sprint 1 Workstream C's deferred item, completed in Sprint 2 W1.
//
// Two writes go out per tool iteration and they are NOT interchangeable:
//
//   setActivity   overwrites one "doing now" line AND refreshes the claim
//                 heartbeat. Unthrottled by necessity — the portal's lease
//                 sweeper (W3b) releases work orders on a stale heartbeat, so
//                 throttling this would get a worker released mid-work.
//   postActivity  appends a durable, human-read event to the Workspace feed.
//                 Throttled, because one row per tool call buries the story.
//
// These tests pin that distinction, since collapsing the two is the obvious
// "simplification" a future reader would reach for.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const UpdateWorker = require('../lib/UpdateWorker');

function worker() {
  const posted = [];
  const w = Object.create(UpdateWorker.prototype);
  w.portal = { postActivity: (id, label, kind) => { posted.push({ id, label, kind }); return Promise.resolve(); } };
  return { w, posted };
}

test('throttled posts are suppressed inside the window', () => {
  const { w, posted } = worker();
  w._postActivityThrottled(1, 'Reading a file');
  w._postActivityThrottled(1, 'Reading another file');
  w._postActivityThrottled(1, 'And another');
  assert.equal(posted.length, 1, 'only the first of a rapid burst reaches the feed');
  assert.equal(posted[0].kind, 'tool');
});

test('a post is allowed again once the window has passed', () => {
  const { w, posted } = worker();
  w._postActivityThrottled(1, 'first');
  // Simulate the window elapsing rather than sleeping through it.
  w._lastActivityPostAt = Date.now() - 60_000;
  w._postActivityThrottled(1, 'second');
  assert.equal(posted.length, 2);
  assert.deepEqual(posted.map((p) => p.label), ['first', 'second']);
});

test('milestones BYPASS the throttle — they are the legible trail', () => {
  const { w, posted } = worker();
  w._postActivityThrottled(1, 'a tool call');
  w._postMilestone(1, 'Opened a pull request for work order #1', 'pr');
  w._postMilestone(1, 'Finished work order #1', 'update');
  assert.equal(posted.length, 3, 'milestones are never suppressed');
  assert.deepEqual(posted.slice(1).map((p) => p.kind), ['pr', 'update']);
});

test('a milestone re-arms the throttle window', () => {
  const { w, posted } = worker();
  w._postMilestone(1, 'Started', 'update');
  w._postActivityThrottled(1, 'immediately after');
  assert.equal(posted.length, 1, 'a tool post right after a milestone is suppressed');
});

test('a feed write never throws into the tool loop', async () => {
  const { w } = worker();
  w.portal.postActivity = () => Promise.reject(new Error('portal down'));
  assert.doesNotThrow(() => w._postActivityThrottled(1, 'x'));
  assert.doesNotThrow(() => w._postMilestone(1, 'y', 'update'));
  await new Promise((r) => setImmediate(r));   // let the rejection settle
});

test('setActivity is still called every iteration (heartbeat is not throttled)', () => {
  // Asserted on the code shape: the unthrottled setActivity call and the
  // throttled feed call must both be present at the emit site.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'UpdateWorker.js'), 'utf8');
  assert.match(src, /this\.portal\.setActivity\(updateId, activityLabel\)/,
    'setActivity must fire unconditionally each iteration (claim heartbeat)');
  assert.match(src, /this\._postActivityThrottled\(updateId, activityLabel\)/,
    'the feed write must go through the throttle');
});
