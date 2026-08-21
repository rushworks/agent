"use strict";

const log = require('./Log');

// Portal API client. Every call goes through `request()` so retries,
// 401-revoke handling, and JSON parsing live in one place.
//
// The portal API surface (current as of agent v0.2) is fully documented in
// docs/agent-api.md on the portal repo; this file only includes the
// endpoints the agent actually uses.

class Portal {
  constructor({ portalUrl, agentToken }) {
    this.baseUrl = portalUrl.replace(/\/$/, '');
    this.token = agentToken;
    this.revoked = false;
    this.timeout = 30_000;
  }

  async request(method, path, { body, query, retries = 3 } = {}) {
    if (this.revoked) {
      throw new Error('Agent token has been revoked — cannot make further requests');
    }

    const qs = query
      ? '?' + Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join('&')
      : '';
    const url = `${this.baseUrl}${path}${qs}`;
    const opts = {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type':  'application/json'
      },
      signal: AbortSignal.timeout(this.timeout)
    };
    if (body !== undefined) opts.body = JSON.stringify(body);

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        log.debug(`${method} ${path}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
        const res = await fetch(url, opts);

        if (res.status === 401) {
          this.revoked = true;
          throw new Error('Portal returned 401 — token revoked');
        }

        // Most agent endpoints reply JSON, but /api/agent/skill.md returns
        // markdown. Sniff the content type so we don't choke on text bodies.
        const ct = res.headers.get('content-type') || '';
        const isJson = ct.includes('application/json');
        const data = isJson ? await res.json() : await res.text();

        if (!res.ok) {
          const msg = (isJson && data && data.error) ? data.error : `HTTP ${res.status}`;
          const err = new Error(`${method} ${path} → ${msg}`);
          err.status = res.status;
          err.payload = data;
          throw err;
        }
        return data;
      } catch (err) {
        if (this.revoked) throw err;
        const retryable =
          err.name === 'TimeoutError' ||
          err.message === 'fetch failed' ||
          err.code === 'ECONNREFUSED' ||
          err.code === 'ECONNRESET' ||
          (err.status >= 500 && err.status <= 599);
        if (retryable && attempt < retries) {
          const delay = Math.min(2 ** (attempt - 1) * 1000, 30_000);
          log.warn(`${method} ${path} failed (${err.message}); retrying in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }

  // ── Identity ──────────────────────────────────────────────────────────
  whoami() {
    return this.request('GET', '/api/agent/whoami');
  }

  // Markdown body — used for system prompt assembly on boot.
  skillMd() {
    return this.request('GET', '/api/agent/skill.md');
  }

  // Role-tailored prompt templates + heuristic copy. Fetched once at
  // boot and cached for the life of the process — see Agent.bootstrap.
  // Variables in the returned strings use {{placeholder}} format;
  // the agent substitutes them at use-time (substitute() helper in
  // Agent.js).
  policies() {
    return this.request('GET', '/api/agent/policies');
  }

  // ── Projects ──────────────────────────────────────────────────────────
  listProjects() {
    return this.request('GET', '/api/agent/projects');
  }

  getBriefing(projectId) {
    return this.request('GET', `/api/agent/projects/${projectId}/briefing`);
  }

  // ── Updates (repo-as-truth work units) ────────────────────────────────
  // Status is DERIVED from the repo — there is no setStatus. A developer works
  // ONLY Updates assigned + activated to it; it claims (soft lease), works the
  // branch, opens a PR. Analysts create/activate/assign (decompose Wishes).

  // My work queue: Updates assigned to me, activated + sanctioned + open.
  listMyUpdates({ project_id } = {}) {
    return this.request('GET', '/api/agent/updates', { query: { project_id } });
  }

  getUpdate(updateId) {
    return this.request('GET', `/api/agent/updates/${updateId}`);
  }

  // Claim = start work (soft lease). Fails unless assigned + activated + sanctioned.
  claimUpdate(updateId) {
    return this.request('POST', `/api/agent/updates/${updateId}/claim`);
  }

  releaseUpdate(updateId) {
    return this.request('POST', `/api/agent/updates/${updateId}/release`);
  }

  // Keep the claim lease alive while working.
  heartbeatUpdate(updateId) {
    return this.request('POST', `/api/agent/updates/${updateId}/heartbeat`);
  }

  // One-line "what I'm doing right now" — overwrites each iter; shows on the
  // Pipeline as live work. Also refreshes the heartbeat.
  setActivity(updateId, note) {
    return this.request('POST', `/api/agent/updates/${updateId}/activity`, { body: { note } });
  }

  // Append a breadcrumb to the project's Workspace activity feed. Distinct
  // from setActivity above, and both are kept on purpose:
  //   setActivity  overwrites a single "what I'm doing now" line AND refreshes
  //                the claim heartbeat, so it must fire every iteration.
  //   postActivity appends a durable, client-visible event, so it is
  //                THROTTLED by the caller — the feed is a calm narrative,
  //                not a log.
  // project_id is derived server-side from update_id.
  postActivity(updateId, label, kind = 'tool') {
    return this.request('POST', '/api/agent/activity', {
      body: { update_id: updateId, kind, label }
    });
  }

  // Analyst-only: decompose a confirmed Wish into an Update work order.
  createUpdate(projectId, body) {
    return this.request('POST', `/api/agent/projects/${projectId}/updates`, { body });
  }

  // Analyst-only: activate a Requested Update so it becomes claimable.
  activateUpdate(updateId) {
    return this.request('POST', `/api/agent/updates/${updateId}/activate`);
  }

  // Analyst-only: route an Update to a worker. body = {kind:'user'|'agent', id} | {clear:true}
  assignUpdate(updateId, body) {
    return this.request('POST', `/api/agent/updates/${updateId}/assignee`, { body });
  }

  // ── Channels & messages ───────────────────────────────────────────────
  listChannels(projectId) {
    return this.request('GET', `/api/agent/projects/${projectId}/channels`);
  }

  listChannelMessages(channelId, { before, limit } = {}) {
    return this.request('GET', `/api/agent/channels/${channelId}/messages`,
      { query: { before, limit } });
  }

  postMessage(channelId, { body, thread_parent_id } = {}) {
    return this.request('POST', `/api/agent/channels/${channelId}/messages`,
      { body: { body, thread_parent_id } });
  }

  // ── Events catchup (used on boot to drain anything missed) ────────────
  getEvents({ since, limit, types } = {}) {
    return this.request('GET', '/api/agent/events',
      { query: { since, limit, types } });
  }

  // ── GitHub (developer role only — server enforces) ────────────────────
  mintGitToken(projectId) {
    return this.request('GET', `/api/agent/projects/${projectId}/git-token`);
  }

  openPullRequest(projectId, { title, head, base, body, draft }) {
    return this.request('POST', `/api/agent/projects/${projectId}/pulls`,
      { body: { title, head, base, body, draft } });
  }

  commentOnPullRequest(projectId, prNumber, body) {
    return this.request('POST', `/api/agent/projects/${projectId}/pulls/${prNumber}/comments`,
      { body: { body } });
  }

  listCommits(projectId, { branch, per_page } = {}) {
    return this.request('GET', `/api/agent/projects/${projectId}/commits`,
      { query: { branch, per_page } });
  }

  listPullRequests(projectId, { state, per_page } = {}) {
    return this.request('GET', `/api/agent/projects/${projectId}/pulls`,
      { query: { state, per_page } });
  }

  getPullRequest(projectId, prNumber) {
    return this.request('GET', `/api/agent/projects/${projectId}/pulls/${prNumber}`);
  }

  getPullRequestFiles(projectId, prNumber, { per_page } = {}) {
    return this.request('GET', `/api/agent/projects/${projectId}/pulls/${prNumber}/files`,
      { query: { per_page } });
  }

  getCheckRuns(projectId, ref, { per_page } = {}) {
    return this.request('GET', `/api/agent/projects/${projectId}/checks`,
      { query: { ref, per_page } });
  }

  listPRComments(projectId, prNumber, { per_page } = {}) {
    return this.request('GET', `/api/agent/projects/${projectId}/pulls/${prNumber}/comments`,
      { query: { per_page } });
  }

  listPRReviews(projectId, prNumber, { per_page } = {}) {
    return this.request('GET', `/api/agent/projects/${projectId}/pulls/${prNumber}/reviews`,
      { query: { per_page } });
  }

  listIssues(projectId, { state, labels, per_page } = {}) {
    return this.request('GET', `/api/agent/projects/${projectId}/issues`,
      { query: { state, labels, per_page } });
  }

  getIssue(projectId, issueNumber) {
    return this.request('GET', `/api/agent/projects/${projectId}/issues/${issueNumber}`);
  }

  // ── Project documents ─────────────────────────────────────────────────
  listDocuments(projectId) {
    return this.request('GET', `/api/agent/projects/${projectId}/documents`);
  }
  readDocument(projectId, slug) {
    return this.request('GET', `/api/agent/projects/${projectId}/documents/${slug}`);
  }
  createDocument(projectId, { title, slug, body }) {
    return this.request('POST', `/api/agent/projects/${projectId}/documents`,
      { body: { title, slug, body } });
  }
  updateDocument(projectId, slug, { title, body }) {
    return this.request('POST', `/api/agent/projects/${projectId}/documents/${slug}`,
      { body: { title, body } });
  }

  // ── Repo browser (read-only, GitHub App auth) ─────────────────────────
  // Preferred unified accessor: server-side branches on the path's type
  // and returns either { kind: 'dir', entries } or { kind: 'file', content }.
  repoGet(projectId, { path, ref } = {}) {
    return this.request('GET', `/api/agent/projects/${projectId}/repo/get`,
      { query: { path, ref } });
  }
  // Legacy split accessors — kept for back-compat with older agent code
  // and as a fallback if /repo/get is ever unavailable. New code should
  // use repoGet.
  repoList(projectId, { path, ref } = {}) {
    return this.request('GET', `/api/agent/projects/${projectId}/repo/list`,
      { query: { path, ref } });
  }
  repoFile(projectId, { path, ref } = {}) {
    return this.request('GET', `/api/agent/projects/${projectId}/repo/file`,
      { query: { path, ref } });
  }
  repoSearch(projectId, { q, per_page } = {}) {
    return this.request('GET', `/api/agent/projects/${projectId}/repo/search`,
      { query: { q, per_page } });
  }
  repoLog(projectId, { branch, path, since, until, per_page } = {}) {
    return this.request('GET', `/api/agent/projects/${projectId}/repo/log`,
      { query: { branch, path, since, until, per_page } });
  }
}

module.exports = Portal;
