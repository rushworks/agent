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

        if (res.status === 401 || res.status === 403) {
          this.revoked = true;
          throw new Error(`Portal returned ${res.status} — token revoked or insufficient role`);
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

  // ── Tasks ─────────────────────────────────────────────────────────────
  // "My" tasks — restricted to current_assignee_agent_id = me.
  listTasks({ status, project_id } = {}) {
    return this.request('GET', '/api/agent/tasks', { query: { status, project_id } });
  }

  // Project-scoped task list — any task in a project I'm on, regardless of
  // assignee. Use for backlog review / triage / prioritization.
  listProjectTasks(projectId, { status, assignee, limit } = {}) {
    return this.request('GET', `/api/agent/projects/${projectId}/tasks`,
      { query: { status, assignee, limit } });
  }

  getTask(taskId) {
    return this.request('GET', `/api/agent/tasks/${taskId}`);
  }

  setTaskStatus(taskId, status) {
    return this.request('POST', `/api/agent/tasks/${taskId}/status`, { body: { status } });
  }

  createTask(projectId, body) {
    return this.request('POST', `/api/agent/projects/${projectId}/tasks`, { body });
  }

  updateTask(taskId, body) {
    return this.request('POST', `/api/agent/tasks/${taskId}`, { body });
  }

  commentOnTask(taskId, body) {
    return this.request('POST', `/api/agent/tasks/${taskId}/comments`, { body: { body } });
  }

  // One-line "what I'm doing right now" — written each iter so the
  // kanban card shows live progress. Overwrites the previous note.
  setActivity(taskId, note) {
    return this.request('POST', `/api/agent/tasks/${taskId}/activity`, { body: { note } });
  }

  requestInput(taskId, { from_user_id, kind, note }) {
    return this.request('POST', `/api/agent/tasks/${taskId}/needs-input`,
      { body: { from_user_id, kind, note } });
  }

  resolveInput(taskId) {
    return this.request('POST', `/api/agent/tasks/${taskId}/resolve-input`);
  }

  // Flag a task as needing human review. Called by the worker on its
  // abnormal-exit paths (fixation_loop, max_iterations). The task stays
  // in In Progress; the portal surfaces a "Needs review" badge and exposes
  // PM Retry/Cancel buttons. kind is a short tag for the UI; reason is
  // the human-readable explanation that goes into the panel + audit log.
  flagIntervention(taskId, { reason, kind }) {
    return this.request('POST', `/api/agent/tasks/${taskId}/intervention`,
      { body: { reason, kind } });
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
