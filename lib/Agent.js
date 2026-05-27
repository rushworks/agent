"use strict";

const log = require('./Log');
const Portal = require('./Portal');
const LLM = require('./LLM');
const ToolRunner = require('./ToolRunner');
const Realtime = require('./Realtime');
const TaskWorker = require('./TaskWorker');

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Simple {{placeholder}} substitution used to fill values into prompt
// templates fetched from /api/agent/policies. Unknown placeholders are
// left intact so a server-side template that introduces a new var
// doesn't crash older agents — they'll just render the literal token.
function substitute(template, vars) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m;
  });
}

// Lean fallback policies used only when the portal's /api/agent/policies
// endpoint is unreachable. Kept deliberately generic — the real
// proprietary templates live portal-side. If you're reading this in
// the public agent repo and looking for the actual playbook, you
// won't find it here; ask the portal.
const DEFAULT_POLICIES = {
  task_epilogue: 'Complete the task using the tools, then end your turn with a short summary.',
  cross_task_cache_intro: 'Files already read this session:',
  mention_triage_header: 'You were mentioned. Decide what to do and act in one step.',
  mention_triage_options: [
    '- Reply in the channel with a short, useful message.',
    '- Create a task if the ask is real work.',
    '- Ask a clarifying question if unclear.'
  ],
  mention_triage_closer: 'End your turn after one action.',
  silence_ack_copy: 'I received your mention but could not generate a response. Please try again.',
  polite_ack_copy: 'Hi — I see your mention. I will wait for a project manager to file a task.',
  fixation_loop_diagnosis: 'Stopped: repeated tool failure.',
  stuck_on_error_diagnosis: 'Stopped: repeated environmental error.'
};

// Top-level lifecycle. Owns the portal client, LLM, tool registry, and
// the realtime connection. Decides when to spawn a TaskWorker.
//
// Three triggers for spawning a worker:
//   1. boot   — list my Queued + In Progress tasks, work each
//   2. ws     — task:event with assigned_to_me on Backlog/Queued/In Progress
//   3. catch  — fallback poll every N seconds (when WS is down or absent)
//
// We never spawn more than `max_concurrent_tasks` workers at once. New
// triggers for an already-running task are coalesced.

class Agent {
  constructor(config) {
    this.config = config;
    this.portal = new Portal({
      portalUrl: config.portal_url,
      agentToken: config.agent_token
    });
    this.toolRunner = new ToolRunner();
    this.llm = null;
    this.realtime = null;
    this.identity = null;
    this.systemPrompt = null;
    this.activeTasks = new Set();           // task ids currently being worked
    this.pollTimer = null;
    this.running = false;
    // Cross-task research cache. Each entry: { projectId, path, ref,
    // ts }. Populated by TaskWorker after a successful repo_get /
    // system_read_file call; read by the next TaskWorker so siblings
    // don't re-explore the same files for context. Bounded to
    // RECENT_READS_MAX and pruned by TTL on every read.
    this.recentReads = [];
  }

  async start() {
    log.info('starting agent');

    // 1. Identity & system prompt
    this.identity = await this.portal.whoami();
    log.info(`hello, ${this.identity.display_name} (id=${this.identity.id}, role=${this.identity.role})`);

    // 1*. Identity-vs-workspace check.
    // Catches the case where this workspace's .env was overwritten with
    // a token that authenticates as a DIFFERENT agent — symptom otherwise
    // is "the agent in workspace X actually claims identity Y," which
    // leads to duplicate replies (when both agents are running) and the
    // intended-X-identity agent looking permanently silent.
    //
    // Heuristic: slugify identity.display_name and compare to the
    // basename of cwd. If they differ AND RW_ALLOW_IDENTITY_MISMATCH is
    // not set, refuse to start with a clear remediation message.
    // Operators with intentional custom workspace naming opt in via
    // the env var.
    const cwd = process.cwd();
    const workspaceName = require('path').basename(cwd);
    const identitySlug = String(this.identity.display_name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (workspaceName && identitySlug && workspaceName !== identitySlug) {
      const allow = String(process.env.RW_ALLOW_IDENTITY_MISMATCH || '').trim() === '1';
      if (!allow) {
        // Print to stderr directly so the error isn't lost in log noise.
        const lines = [
          '',
          '✗ Identity mismatch — refusing to start.',
          '',
          `   Workspace directory:    ${cwd}`,
          `   Workspace basename:     "${workspaceName}"`,
          `   Token authenticates as: "${this.identity.display_name}" (slug: "${identitySlug}", id=${this.identity.id}, role=${this.identity.role})`,
          '',
          '   These almost always match. A mismatch usually means the wrong',
          '   RW_AGENT_TOKEN got written into this workspace\'s .env.',
          '',
          '   To fix:',
          `     1. Open ${cwd}/.env`,
          `     2. Replace RW_AGENT_TOKEN with the token for "${workspaceName}"`,
          '        (re-issue from the portal if you no longer have it)',
          '     3. Restart the agent',
          '',
          '   If you\'re intentionally running this workspace under a different',
          '   identity, set RW_ALLOW_IDENTITY_MISMATCH=1 in the .env or shell.',
          ''
        ];
        process.stderr.write(lines.join('\n') + '\n');
        process.exit(1);
      }
      log.warn(`identity mismatch — workspace="${workspaceName}" vs identity slug="${identitySlug}" — proceeding because RW_ALLOW_IDENTITY_MISMATCH=1`);
    }

    // 1a. Role-aware defaults. Developers need a larger per-task iter
    // budget than analysts — branch + clone + edit + test + commit +
    // push + open PR + status + comment is easily 15-20 iters of
    // essential ceremony before any actual work. If the operator didn't
    // set RW_MAX_ITERATIONS explicitly (which leaves us at the analyst
    // default of 20), bump it to 40 for developer-role boots.
    if (!process.env.RW_MAX_ITERATIONS && this.identity.role === 'developer') {
      this.config.max_iterations_per_task = 40;
      log.info(`developer role: bumping default max_iterations_per_task → 40 (set RW_MAX_ITERATIONS to override)`);
    }

    this.systemPrompt = await this.portal.skillMd();
    log.info(`skill loaded (${this.systemPrompt.length} chars)`);

    // 1b. Policies — proprietary prompt templates + heuristic copy
    // fetched from the portal so the agent runtime stays a generic
    // LLM loop. Cached for the life of this process. If the endpoint
    // is unavailable (older portal, network blip), the runtime falls
    // back to baked-in defaults below so a fresh boot doesn't break.
    try {
      const resp = await this.portal.policies();
      this.policies = (resp && resp.policies) || DEFAULT_POLICIES;
      log.info(`policies loaded (v${resp && resp.version || '?'}, role=${resp && resp.role || this.identity.role})`);
    } catch (err) {
      log.warn(`policies fetch failed (${err.message}) — using built-in defaults`);
      this.policies = DEFAULT_POLICIES;
    }

    // 2. Model
    this.llm = new LLM({
      provider: this.config.provider,
      model: this.config.model,
      maxTokens: this.config.max_tokens
    });
    await this.llm.init(this.config.anthropic_api_key);

    // 3. Tools (role-filtered)
    this.toolRunner.loadForRole(this.identity.role);
    if (this.toolRunner.size === 0) {
      throw new Error('no tools available — check role + tools/index.js');
    }

    // 3a. Developer agents need a working_directory to clone repos +
    //     run system tools (system_bash, system_edit_file, etc.). Without
    //     it they boot fine but fail every system_* call later, often
    //     burning a whole iter budget before max_iterations fires. Validate
    //     up front and refuse to start.
    if (this.identity.role === 'developer') {
      const wd = this.config.working_directory;
      if (!wd) {
        throw new Error(
          'developer agents require RW_WORKING_DIRECTORY to be set ' +
          '(a writable local path, NOT inside a cloud-sync tree like ' +
          'Google Drive / Dropbox / iCloud). Add it to your workspace .env ' +
          'or ~/.rushworks/agent.json.'
        );
      }
      const fs = require('fs');
      if (!fs.existsSync(wd)) {
        throw new Error(`developer working_directory does not exist: ${wd} — create it with \`mkdir -p "${wd}"\`.`);
      }
      try {
        fs.accessSync(wd, fs.constants.W_OK);
      } catch (_) {
        throw new Error(`developer working_directory is not writable: ${wd} — check permissions.`);
      }
      log.info(`developer working_directory: ${wd}`);
    }

    // 4. Realtime (long-running runtimes win here — we're a daemon)
    this.realtime = new Realtime({
      portalUrl: this.config.portal_url,
      agentToken: this.config.agent_token
    });
    this.realtime.on('task',           (e) => this.onTaskEvent(e));
    this.realtime.on('message',        (e) => this.onMessageEvent(e));
    this.realtime.on('notification',   (e) => this.onNotificationEvent(e));
    this.realtime.on('disconnect',     () => { /* socket.io-client reconnects */ });
    this.realtime.on('auth_exhausted', () => {
      log.error('realtime auth exhausted — exiting so a process supervisor can restart');
      this.stop();
      process.exit(1);
    });
    this.realtime.connect();

    // 5. Boot catchup: any in-progress task from a prior session, then any
    //    Queued task assigned to me. We process up to max_concurrent_tasks.
    this.running = true;
    await this.bootCatchup();

    // 6. Polling fallback — fires every N seconds whether or not WS is up.
    //    Cheap insurance against a missed event; the no-op path is one HTTP
    //    call returning an empty array.
    this.schedulePoll();

    log.info('agent ready — waiting for events');
  }

  stop() {
    log.info('stopping agent');
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.realtime) this.realtime.close();
    log.info('agent stopped');
  }

  // ── Triggers ──────────────────────────────────────────────────────────

  async bootCatchup() {
    try {
      // In Progress tasks left over from a prior process — finish them first.
      const inProg = await this.portal.listTasks({ status: 'In Progress' });
      for (const t of inProg.tasks || []) this.maybeWork(t);

      // Then Queued tasks waiting for me to start.
      const queued = await this.portal.listTasks({ status: 'Queued' });
      for (const t of queued.tasks || []) this.maybeWork(t);
    } catch (err) {
      log.error(`boot catchup failed: ${err.message}`);
    }
  }

  schedulePoll() {
    if (!this.running) return;
    const base = (this.config.poll_interval_seconds || 30) * 1000;
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    this.pollTimer = setTimeout(() => this.poll(), Math.round(base + jitter));
  }

  async poll() {
    if (!this.running) return;
    try {
      if (this.atCapacity()) {
        log.debug(`poll: at capacity (${this.activeTasks.size}/${this.config.max_concurrent_tasks})`);
      } else {
        const queued = await this.portal.listTasks({ status: 'Queued' });
        for (const t of queued.tasks || []) {
          if (this.atCapacity()) break;
          this.maybeWork(t);
        }
      }
    } catch (err) {
      if (this.portal.revoked) {
        log.error('token revoked — shutting down');
        return this.stop();
      }
      log.error(`poll failed: ${err.message}`);
    }
    this.schedulePoll();
  }

  onTaskEvent(e) {
    // Push from the server about something on a task in one of our project
    // rooms. The portal broadcasts in a shape like:
    //   { type: 'created' | 'updated' | 'input_resolved' | ..., taskId,
    //     projectId, statusChanged, assigneeChanged,
    //     actorUserId | actorAgentId }
    // We react to anything that might mean "I have new work":
    //   - task created (often by a mention flow that just spawned a task)
    //   - status / assignee changed on an existing task
    //   - input resolved (a paused task can resume)
    if (!e || !e.taskId) return;

    const interesting =
      e.type === 'created' ||
      (e.type === 'updated' && (e.statusChanged || e.assigneeChanged)) ||
      e.type === 'input_resolved';
    if (!interesting) return;

    // Self-actor filter, narrowed: skip self-triggered UPDATED events (e.g.
    // I moved my own task to Ready — no need to re-engage). Don't skip
    // self-triggered CREATED events: a mention flow that just created a
    // Queued task assigned to me is exactly the handoff signal we want.
    if (e.type !== 'created'
        && e.actorAgentId
        && this.identity
        && e.actorAgentId === this.identity.id) return;

    log.info(`event: task ${e.taskId} ${e.type}${e.statusChanged ? ' status' : ''}${e.assigneeChanged ? ' assignee' : ''} — checking`);
    this.portal.getTask(e.taskId)
      .then(({ task }) => {
        if (!task) return;
        const mine = task.assignee && task.assignee.type === 'agent'
          && task.assignee.id === this.identity.id;
        if (!mine) return;
        this.maybeWork(task);
      })
      .catch((err) => log.warn(`fetch task ${e.taskId} failed: ${err.message}`));
  }

  onMessageEvent(e) {
    if (!e || !e.message) return;
    const m = e.message;

    // Both analysts AND developers react to mentions now. The triage
    // prompt is role-aware so developers don't try to create tasks
    // (which the server would reject anyway) and instead route to
    // quick reply / needs_input / "ask the PM to file a task" paths.

    // System messages (task → Ready, needs_input notifications, etc.)
    // are informational and don't represent a user asking the agent for
    // anything. They might happen to include text resembling an @-mention
    // (e.g. "Needs input from @rushramia"); skip them so the agent
    // doesn't react to its own notification feed.
    if (m.kind === 'system') return;
    // Skip our own posts — prevents an obvious feedback loop.
    if (m.author_agent_id && m.author_agent_id === this.identity.id) return;
    // Other agents' messages also don't trigger mentions — only humans
    // direct analysts. Prevents agent-to-agent loops.
    if (m.author_agent_id) return;

    // In a DM, every non-self message is implicitly for the agent —
    // no @-mention required. Channels still require explicit @-mention
    // to avoid pulling the agent into general chatter.
    if (!m.is_dm) {
      const name = this.identity && this.identity.display_name;
      if (!name) return;
      const re = new RegExp(`@${escapeRegex(name)}\\b`, 'i');
      if (!re.test(m.body || '')) return;
    }

    // Dedupe in case the WS replays. Bounded to keep memory finite.
    if (!this.handledMessages) this.handledMessages = new Set();
    if (this.handledMessages.has(m.id)) return;
    this.handledMessages.add(m.id);
    if (this.handledMessages.size > 1000) {
      const it = this.handledMessages.values();
      for (let i = 0; i < 200; i++) this.handledMessages.delete(it.next().value);
    }

    log.info(`event: mentioned in message #${m.id} (channel ${m.channel_id})`);

    // Mention authorization. Only PM-tier users can direct an analyst.
    // Other org members get a polite explanation and no action. Roles
    // ride on the message payload via message.create's broadcast.
    const authorRoles = Array.isArray(m.author_user_roles) ? m.author_user_roles : [];
    const isPM = authorRoles.some(
      (r) => r === 'project_manager' || r === 'org_owner' || r === 'root'
    );
    if (!isPM) {
      log.info(`mention ${m.id} — author is not a PM (roles: ${authorRoles.join(',') || '(none)'}), posting polite ack`);
      this.politelyDeclineMention(m).catch((err) =>
        log.warn(`polite-ack post failed for mention ${m.id}: ${err.message}`)
      );
      return;
    }

    if (this.atCapacity()) {
      log.warn(`mention deferred — at task capacity (${this.activeTasks.size}/${this.config.max_concurrent_tasks})`);
      return;
    }

    // Use a pseudo-key so the capacity gate counts mention responders
    // alongside real task workers.
    const pseudoKey = `mention:${m.id}`;
    this.activeTasks.add(pseudoKey);
    this.runMentionResponder(m, e.projectId).finally(() => {
      this.activeTasks.delete(pseudoKey);
    });
  }

  // Direct a non-PM mention author to the right channel. Single-shot
  // portal_post_message — no LLM call, no worker spawn. Copy comes
  // from /api/agent/policies so the public agent doesn't ship the
  // proprietary acknowledgement language.
  async politelyDeclineMention(message) {
    const author = message.author_user_label || 'there';
    const body = substitute(this.policies.polite_ack_copy, { author_name: author });
    await this.portal.postMessage(message.channel_id, { body });
  }

  async runMentionResponder(message, projectId) {
    const worker = new TaskWorker({
      llm: this.llm,
      toolRunner: this.toolRunner,
      portal: this.portal,
      identity: this.identity,
      config: this.config,
      agent: this
    });
    const result = await worker.respondToMention(message, this.systemPrompt, { projectId });
    if (!result.success) {
      log.warn(`mention ${message.id} did not complete: ${result.error}`);
    }
  }

  // Cross-task research cache helpers — called by TaskWorker tool-loop
  // bookkeeping. recordRead is invoked after a successful repo / file
  // read; recentReadsFor returns the bounded, TTL-filtered list for a
  // given project so the next worker can mention it in its prompt.

  recordRead({ projectId, path, ref }) {
    if (!path) return;
    const RECENT_READS_MAX = 50;
    const ts = Date.now();
    // Drop any prior entry for the same (project, path, ref) so the
    // newest timestamp wins and we don't accumulate duplicates.
    this.recentReads = this.recentReads.filter((r) =>
      !(r.projectId === projectId && r.path === path && r.ref === (ref || null))
    );
    this.recentReads.push({ projectId, path, ref: ref || null, ts });
    if (this.recentReads.length > RECENT_READS_MAX) {
      this.recentReads = this.recentReads.slice(-RECENT_READS_MAX);
    }
  }

  recentReadsFor(projectId) {
    const TTL_MS = 60 * 60 * 1000; // 1 hour
    const cutoff = Date.now() - TTL_MS;
    // Filter side-effect: also prune expired entries from the master
    // list while we're walking it.
    const kept = [];
    const out = [];
    for (const r of this.recentReads) {
      if (r.ts < cutoff) continue;
      kept.push(r);
      if (r.projectId === projectId) out.push(r);
    }
    this.recentReads = kept;
    return out;
  }

  onNotificationEvent(_e) {
    // v0.2 stub. We'll route approval responses here once host-side
    // approval flow exists.
  }

  // ── Worker spawning ───────────────────────────────────────────────────

  atCapacity() {
    return this.activeTasks.size >= (this.config.max_concurrent_tasks || 1);
  }

  maybeWork(task) {
    if (!task || !task.id) return;
    if (this.activeTasks.has(task.id)) return;          // already working it
    if (this.atCapacity()) return;
    // Don't pick up terminal-state tasks even if they slip through a filter.
    if (task.status === 'Completed' || task.status === 'Cancelled') return;
    // Don't auto-engage on Backlog tasks. They're explicitly "not ready
    // to start" — a PM activates them to Queued when they want the agent
    // to begin. Otherwise the agent reacts to the task:created event
    // (which fires when the PM creates at Backlog before activating) and
    // burns an iter on a doomed Backlog→In Progress transition that the
    // server correctly rejects.
    if (task.status === 'Backlog') return;

    this.activeTasks.add(task.id);
    this.runWorker(task).finally(() => {
      this.activeTasks.delete(task.id);
    });
  }

  async runWorker(task) {
    const worker = new TaskWorker({
      llm: this.llm,
      toolRunner: this.toolRunner,
      portal: this.portal,
      identity: this.identity,
      config: this.config,
      agent: this
    });
    const result = await worker.execute(task, this.systemPrompt);
    if (!result.success) {
      log.warn(`task ${task.id} did not complete: ${result.error}`);
    }
  }
}

module.exports = Agent;
