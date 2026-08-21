"use strict";

const fs = require('fs');
const path = require('path');
const log = require('./Log');

// Per-Update LLM tool-use loop. Holds no state between executions — one worker
// per Update per invocation, then garbage-collected. The Agent decides when to
// spawn workers based on its assigned+activated queue (poll/catchup).
//
// Lifecycle per Update (status is REPO-DERIVED — the agent never sets it):
//   1. Claim the Update (soft lease; fails unless assigned + activated + sanctioned)
//   2. Build prompt (briefing + Update detail + branch_name + CLAUDE.md context)
//   3. Loop: LLM call → execute tool_use blocks → feed results back
//   4. Stop on end_turn or max_iterations
//   5. Success = a PR was opened on the Update's branch (webhook -> In Review);
//      post a sign-off to the channel and release. Failure paths post a
//      diagnostic to the channel and release.

// Minimum gap between feed events from one worker. The directive's floor is
// 5s; a worker iterates faster than that when tools are cheap.
const ACTIVITY_MIN_INTERVAL_MS = parseInt(process.env.RW_ACTIVITY_MIN_INTERVAL_MS, 10) || 5000;

const SENSITIVE_KEYS = new Set([
  'api_key', 'apikey', 'token', 'secret', 'password', 'authorization', 'credentials'
]);

// {{placeholder}} substitution for policy templates fetched from the
// portal. Mirrors the helper in Agent.js. Kept tiny on purpose —
// duplication is cheaper than a circular import.
function substitute(template, vars) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m;
  });
}

// Human-readable label for the activity line shown on the kanban card.
// Keep these short — the card has ~40 chars before it ellipsises.
const TOOL_LABELS = {
  portal_list_updates:           'Listing my Updates',
  portal_get_update:             'Reading Update detail',
  portal_claim_update:           'Claiming an Update',
  portal_release_update:         'Releasing an Update',
  portal_create_update:          'Creating an Update',
  portal_activate_update:        'Activating an Update',
  portal_assign_update:          'Routing an Update',
  portal_list_projects:          'Listing projects',
  portal_get_briefing:           'Reading project briefing',
  portal_list_channels:          'Listing channels',
  portal_list_channel_messages:  'Reading channel',
  portal_post_message:           'Posting to channel',
  github_mint_token:             'Getting git credentials',
  github_open_pull_request:      'Opening a pull request',
  github_comment_on_pr:          'Commenting on a PR',
  github_list_commits:           'Reading commits',
  github_list_pull_requests:     'Reading pull requests',
  github_get_pull_request:       'Reviewing a pull request',
  github_list_pull_request_files: 'Reading PR changes',
  github_get_check_runs:         'Checking CI status',
  github_list_pr_comments:       'Reading PR comments',
  github_list_pr_reviews:        'Reading PR reviews',
  github_list_issues:            'Reading issues',
  github_get_issue:              'Reading an issue',
  system_list_dir:               'Listing files',
  system_read_file:              'Reading a file',
  system_write_file:             'Writing a file',
  system_edit_file:               'Editing a file',
  system_glob:                   'Searching for files',
  system_grep:                   'Searching code',
  system_bash:                   'Running a command',
  system_screenshot:             'Taking a screenshot',
  web_search:                    'Searching the web',
  web_fetch:                     'Fetching a web page',
  code_definition:               'Finding definition',
  code_references:               'Finding references',
  code_diagnostics:              'Checking diagnostics'
};

function summarizeActivity(toolUses) {
  if (!toolUses || toolUses.length === 0) return 'Thinking…';
  var primary = TOOL_LABELS[toolUses[0].name] || toolUses[0].name.replace(/^portal_|^system_|^github_/, '').replace(/_/g, ' ');
  if (toolUses.length === 1) return primary;
  return `${primary} (+${toolUses.length - 1} more)`;
}

// One-line summary of a tool's input args for the per-iter log line. Long
// strings get clipped so a multi-paragraph comment body doesn't unfurl the
// log; sensitive keys get redacted.
function summarizeToolArgs(input) {
  if (!input || typeof input !== 'object') return '';
  return Object.entries(input).slice(0, 5).map(([k, v]) => {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) return `${k}=***`;
    if (typeof v === 'string') {
      const clipped = v.length > 40 ? `${v.slice(0, 40)}…` : v;
      return `${k}="${clipped}"`;
    }
    if (v === null) return `${k}=null`;
    if (typeof v === 'object') return `${k}=${JSON.stringify(v).slice(0, 40)}`;
    return `${k}=${v}`;
  }).join(', ');
}

class UpdateWorker {
  constructor({ llm, toolRunner, portal, identity, config, agent }) {
    this.llm = llm;
    this.toolRunner = toolRunner;
    this.portal = portal;
    this.identity = identity;          // { id, display_name, role, ... }
    this.config = config || {};
    this.agent = agent || null;        // back-reference for cross-update caches
    this._channelId = undefined;       // lazily-resolved project channel for notify()
  }

  async execute(update, systemPrompt) {
    const updateId = update.id;
    log.info(`update ${updateId} (${update.title}) — starting`);

    try {
      // Claim the Update (soft lease). Fails unless it's assigned to me,
      // activated, and sanctioned — the forward gates. Status is NOT set here;
      // it derives from the repo (commits / PR).
      try {
        await this.portal.claimUpdate(updateId);
      } catch (err) {
        log.warn(`update ${updateId} — could not claim (${err.message}); skipping`);
        return { success: false, error: 'claim_failed' };
      }
      // Milestone: the trail should open with who picked this up.
      this._postMilestone(updateId,
        `Started work order #${updateId}: ${update.title}`, 'update');

      let briefing = null;
      if (update.project_id) {
        try { briefing = await this.portal.getBriefing(update.project_id); }
        catch (err) { log.warn(`briefing fetch failed: ${err.message}`); }
      }

      // CLAUDE.md / memory context — local-only, only if working_directory is set.
      const projectContext = this.loadProjectContext();
      const fullSystem = [
        systemPrompt,
        projectContext && '## Project conventions (CLAUDE.md and shared memory)\n\n' + projectContext
      ].filter(Boolean).join('\n\n---\n\n');

      const userPrompt = this.buildPrompt(update, briefing);
      const tools = this.toolRunner.definitions();
      const messages = [{ role: 'user', content: userPrompt }];

      const maxIters = this.config.max_iterations_per_task || 20;
      let iter = 0;
      let finalText = '';
      let totalToolCalls = 0;
      // Success signal: the agent opened a PR on this Update's branch. Opening a
      // PR is the deliverable AND the status signal (the webhook moves the Update
      // to In Review). There is no agent-driven status transition.
      let openedPR = false;
      // Fixation guards — same two checks as before ("stuck on a broken call" and
      // "stuck on an environmental error"), 3 identical strikes in a row.
      const recentFailures = [];
      const recentErrors = [];

      while (iter < maxIters) {
        iter += 1;
        const res = await this.llm.chat({
          system: fullSystem, messages, tools, cacheSystem: true, cacheTools: true
        });

        const toolUses = [];
        const texts = [];
        for (const block of res.content) {
          if (block.type === 'tool_use') toolUses.push(block);
          else if (block.type === 'text') texts.push(block.text);
        }
        if (texts.length > 0) finalText = texts.join('\n');

        if (toolUses.length === 0 || res.stop_reason === 'end_turn') {
          log.info(`update ${updateId} — iter ${iter}: end_turn (final text: ${finalText.length} chars)`);
          break;
        }
        if (res.stop_reason === 'max_tokens') {
          log.warn(`update ${updateId} — iter ${iter} HIT max_tokens cap; tool input may be truncated`);
        }
        totalToolCalls += toolUses.length;

        const summary = toolUses.map((u) => `${u.name}(${summarizeToolArgs(u.input)})`).join(', ');
        log.info(`update ${updateId} — iter ${iter} → ${summary}`);

        // Two different things, deliberately not merged:
        //
        // 1. setActivity — overwrites the single "what I'm doing now" line and
        //    REFRESHES THE CLAIM HEARTBEAT. Must fire every iteration: the
        //    portal's lease sweeper releases work orders whose heartbeat goes
        //    stale, so throttling this would get us released mid-work.
        // 2. postActivity — appends a durable, client-visible event to the
        //    Workspace feed. Throttled, because that feed is read by humans
        //    and one row per tool call would bury the narrative.
        const activityLabel = summarizeActivity(toolUses);
        this.portal.setActivity(updateId, activityLabel)
          .catch((err) => log.debug(`activity emit failed: ${err.message}`));
        this._postActivityThrottled(updateId, activityLabel);

        messages.push({ role: 'assistant', content: res.content });

        const toolResults = [];
        for (const use of toolUses) {
          let payload;
          let isError = false;
          try {
            const name = this.toolRunner.fromApiName(use.name);
            payload = await this.toolRunner.execute(name, use.input, this.toolContext(update, briefing));
            // A successful PR-open is the completion signal for this Update.
            if (name === 'github_open_pull_request') {
              openedPR = true;
              this._postMilestone(updateId, `Opened a pull request for work order #${updateId}`, 'pr');
            }
            // Cross-update research cache (file reads only).
            if (this.agent && use.input && use.input.path && (name === 'repo_get' || name === 'repo_read_file')) {
              this.agent.recordRead({
                projectId: use.input.project_id || update.project_id || null,
                path: use.input.path,
                ref: use.input.ref || null
              });
            }
          } catch (err) {
            payload = `Error: ${err.message}`;
            isError = true;
            log.warn(`tool ${use.name} failed: ${err.message}`);
          }
          toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: payload, is_error: isError });
        }
        messages.push({ role: 'user', content: toolResults });

        const allErrored = toolResults.length > 0 && toolResults.every((r) => r.is_error);
        if (allErrored) {
          const sig = toolUses.map((u) => `${u.name}:${JSON.stringify(u.input || {}).slice(0, 200)}`).join('|');
          recentFailures.push(sig); if (recentFailures.length > 3) recentFailures.shift();
          const errPrefix = String(toolResults[0].content).slice(0, 120);
          recentErrors.push(errPrefix); if (recentErrors.length > 3) recentErrors.shift();

          if (recentFailures.length === 3 && recentFailures.every((s) => s === recentFailures[0])) {
            const names = toolUses.map((u) => u.name).join(', ');
            const lastErr = String(toolResults[0].content).slice(0, 300);
            const note = substitute(this.agent.policies.fixation_loop_diagnosis, { names, last_err: lastErr });
            await this.abandon(update, briefing, '⚠️ ' + note);
            log.warn(`update ${updateId} — broke loop on 3x identical failure (${names})`);
            return { success: false, error: 'fixation_loop', diagnosis: note };
          }
          if (recentErrors.length === 3 && recentErrors.every((s) => s === recentErrors[0])) {
            const lastErr = String(toolResults[0].content).slice(0, 300);
            const note = substitute(this.agent.policies.stuck_on_error_diagnosis, { last_err: lastErr });
            await this.abandon(update, briefing, '⚠️ ' + note);
            log.warn(`update ${updateId} — broke loop on 3x identical error`);
            return { success: false, error: 'stuck_on_error', diagnosis: note };
          }
        } else {
          recentFailures.length = 0;
          recentErrors.length = 0;
        }
      }

      if (iter >= maxIters) {
        await this.abandon(update, briefing,
          `⚠️ Hit max iterations (${maxIters}) on Update #${updateId} without opening a PR. Latest output:\n\n${finalText || '(no text output)'}`);
        log.warn(`update ${updateId} — max iterations reached`);
        return { success: false, error: 'max_iterations' };
      }

      if (totalToolCalls === 0 && !finalText.trim()) {
        await this.abandon(update, briefing,
          `⚠️ The agent produced no output on Update #${updateId} — no tool calls and no text (likely a model flake).`);
        log.warn(`update ${updateId} — empty response`);
        return { success: false, error: 'empty_response' };
      }

      // Outcome. Status is repo-derived — the agent never sets it. Success means
      // a PR was opened on the Update's branch (the webhook then moves it to In
      // Review). Either way we release the claim and post a sign-off to the
      // project channel.
      const sign = finalText.trim() ? `\n\n${finalText.trim().slice(0, 1500)}` : '';
      if (openedPR) {
        this._postMilestone(updateId,
          `Finished work order #${updateId} — handed off for review`, 'update');
        await this.notify(update, briefing, `Opened a PR for Update #${updateId} (${update.title}).${sign}`);
        await this.portal.releaseUpdate(updateId).catch(() => {});
        log.info(`update ${updateId} — PR opened; released (status derives from the repo)`);
        return { success: true, output: finalText, openedPR: true };
      }
      // No PR — incomplete. Release; Agent.js holds a short cooldown so the
      // Update isn't immediately re-picked.
      await this.notify(update, briefing, `Worked Update #${updateId} but did not open a PR.${sign}`);
      await this.portal.releaseUpdate(updateId).catch(() => {});
      log.info(`update ${updateId} — finished without a PR (incomplete)`);
      return { success: false, error: 'no_pr', output: finalText, incomplete: true };

    } catch (err) {
      log.error(`update ${updateId} — failed: ${err.message}`);
      await this.portal.releaseUpdate(updateId).catch(() => {});
      try { await this.notify(update, null, `⚠️ Agent error on Update #${updateId}: ${err.message}`); } catch (_) {}
      return { success: false, error: err.message };
    }
  }

  // Ad-hoc invocation: an @-mention in a channel. Runs a short LLM loop
  // with channel + task tools available, no task lifecycle, no epilogue.
  // The LLM decides what to do: reply inline, create a task, ask a
  // clarifying question, or stay silent. Mentions can fire in
  // high-volume chatter, so we cap iters lower than a real task.
  //
  // ctx.projectId: the project the channel belongs to. Provided so the
  // LLM doesn't waste an iter on portal_list_projects() to discover it.
  async respondToMention(message, systemPrompt, ctx = {}) {
    const mid = message.id;
    log.info(`mention ${mid} — responding (channel ${message.channel_id}${ctx.projectId ? ', project ' + ctx.projectId : ''})`);

    try {
      const author =
        message.author_user_label || message.author_agent_label || 'someone';
      const selfRef = `agent:${this.identity.id}`;

      // Fetch the project briefing if we have a project in scope. The
      // briefing carries devops_config (when role=devops) which the
      // devops tools need. For analyst + developer the briefing is
      // lightweight and worth fetching for the conventions block but
      // it's not load-bearing here — the historyBlock + triage prompt
      // are the primary context. Errors don't block the mention.
      let mentionBriefing = null;
      if (ctx.projectId) {
        try { mentionBriefing = await this.portal.getBriefing(ctx.projectId); }
        catch (err) { log.warn(`mention ${mid} — briefing fetch failed: ${err.message}`); }
      }
      // Fetch recent channel history so the LLM has conversational
      // continuity. Without this, a follow-up mention ("OK, do that now")
      // arrives with no idea what "that" refers to. Cap at 10 messages
      // BEFORE the triggering one; each gets clipped to ~240 chars so a
      // single long thread doesn't blow up the prompt budget.
      let historyBlock = null;
      try {
        const resp = await this.portal.listChannelMessages(
          message.channel_id,
          { before: message.id, limit: 10 }
        );
        const msgs = Array.isArray(resp && resp.messages) ? resp.messages : [];
        if (msgs.length > 0) {
          const lines = msgs
            .slice()
            .reverse() // server returns newest-first; flip to chronological
            .map((m) => {
              const who = m.author_user_label
                || (m.author_agent_label ? m.author_agent_label + ' (agent)' : 'system');
              const body = String(m.body || '').replace(/\s+/g, ' ').slice(0, 240);
              return `- **${who}:** ${body}`;
            });
          historyBlock = lines.join('\n');
        }
      } catch (err) {
        // Don't fail the mention if history fetch fails — just proceed
        // without the context block. The triage prompt still works.
        log.warn(`mention ${mid} — history fetch failed (continuing without context): ${err.message}`);
      }

      // Triage option list + header + closer all come from the policy
      // bundle fetched at boot. Each option may reference {{self_ref}}
      // — substitute that to this agent's own assignee handle here.
      const policies = this.agent.policies;
      const triageOptions = (policies.mention_triage_options || []).map(
        (opt) => substitute(opt, { self_ref: selfRef })
      );

      const isImplicit = !!message._implicit_mention;
      const promptText = [
        isImplicit
          ? '# PM posted in channel (you are monitoring as their assistant)'
          : '# You were @-mentioned in a channel',
        '',
        isImplicit
          ? 'This message was NOT addressed to you by name. The PM posted in the project channel and you are reading it as their assistant. If the message is a direct question or instruction that needs your help, respond fully. If it is general commentary, a note to the team, or clearly directed at a human, reply with a brief acknowledgment (e.g. "Got it." or "OK, noted.") so the PM knows you are tracking.'
          : null,
        isImplicit ? '' : null,
        `**Channel ID:** ${message.channel_id}`,
        ctx.projectId ? `**Project ID:** ${ctx.projectId}` : null,
        `**From:** ${author}`,
        `**Your role:** ${this.identity.role}`,
        '**Message:**',
        '',
        message.body || '(empty)',
        '',
        historyBlock ? '---' : null,
        historyBlock ? '' : null,
        historyBlock ? '**Recent channel history** (most recent last, for conversational context):' : null,
        historyBlock,
        '',
        '---',
        '',
        policies.mention_triage_header,
        '',
        ...triageOptions,
        '',
        policies.mention_triage_closer
      ].filter((line) => line !== null).join('\n');

      const messages = [{ role: 'user', content: promptText }];
      const tools = this.toolRunner.definitions();
      // Mentions should be short — cap iters lower than a full task.
      const maxIters = Math.min(this.config.max_iterations_per_task || 20, 10);
      let iter = 0;
      let finalText = '';
      // Track whether the LLM took an action that produces visible
      // feedback in the channel — posting a message or creating a task.
      // If neither happens by the time the loop exits, we post a fallback
      // ack so the mention never goes silent.
      let didSomethingVisible = false;

      while (iter < maxIters) {
        iter += 1;
        const res = await this.llm.chat({
          system: systemPrompt,
          messages,
          tools,
          cacheSystem: true,
          cacheTools: true
        });

        const toolUses = [];
        const texts = [];
        for (const block of res.content) {
          if (block.type === 'tool_use') toolUses.push(block);
          else if (block.type === 'text') texts.push(block.text);
        }
        if (texts.length > 0) finalText = texts.join('\n');

        if (toolUses.length === 0 || res.stop_reason === 'end_turn') {
          log.info(`mention ${mid} — iter ${iter}: end_turn (final text: ${finalText.length} chars)`);
          break;
        }

        const summary = toolUses.map((u) => `${u.name}(${summarizeToolArgs(u.input)})`).join(', ');
        log.info(`mention ${mid} — iter ${iter} → ${summary}`);

        messages.push({ role: 'assistant', content: res.content });
        const toolResults = [];
        for (const use of toolUses) {
          let payload;
          let isError = false;
          try {
            const name = this.toolRunner.fromApiName(use.name);
            payload = await this.toolRunner.execute(name, use.input, {
              portal: this.portal,
              identity: this.identity,
              working_directory: this.config.working_directory || null,
              // Lock all per-project tool calls during this mention to the
              // project the mention's channel belongs to. Closes the abuse
              // case where the @-mention author asks the agent to operate
              // on a different project.
              sessionProjectId: ctx.projectId || null,
              // Devops-only: per-project log allowlist + DB connection.
              // Pulled from the mention's project briefing; null on roles
              // that don't have a devops_config field.
              devops_config: (mentionBriefing && mentionBriefing.devops_config) || null,
              developer_config: (mentionBriefing && mentionBriefing.developer_config) || null,
              analyst_config: (mentionBriefing && mentionBriefing.analyst_config) || null
            });
            if (!isError && (name === 'portal_post_message' || name === 'portal_create_update')) {
              didSomethingVisible = true;
            }
          } catch (err) {
            payload = `Error: ${err.message}`;
            isError = true;
            log.warn(`tool ${use.name} failed: ${err.message}`);
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: payload,
            is_error: isError
          });
        }
        messages.push({ role: 'user', content: toolResults });
      }

      if (iter >= maxIters) {
        log.warn(`mention ${mid} — max iterations (${maxIters}) reached, giving up`);
      }

      // Silence guard. If the LLM never posted to the channel and never
      // created a task, the author of the @-mention sees nothing happen.
      // This commonly happens when the model spends its whole iter budget
      // researching and never synthesizes — so before falling back to the
      // canned ack, give it ONE final tool-less turn to answer from what it
      // already gathered (the messages array holds all that context). Only
      // if that yields nothing do we post the generic ack. The canned copy
      // comes from /api/agent/policies so the public agent doesn't ship the
      // proprietary acknowledgement language.
      if (!didSomethingVisible) {
        let answer = '';
        try {
          messages.push({
            role: 'user',
            content: 'You are out of research budget for this mention. Do NOT call any tools. Using only what you have already gathered above, write a concise, direct answer now as plain text. If you could not determine something, say so briefly.'
          });
          const synth = await this.llm.chat({ system: systemPrompt, messages, tools: [], cacheSystem: true });
          answer = (synth.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        } catch (err) {
          log.warn(`mention ${mid} — synthesis turn failed: ${err.message}`);
        }
        const body = answer || this.agent.policies.silence_ack_copy;
        log.warn(`mention ${mid} — no visible action in loop; posting ${answer ? 'synthesized answer' : 'fallback ack'}`);
        try {
          await this.portal.postMessage(message.channel_id, { body });
          if (answer) { finalText = answer; didSomethingVisible = true; }
        } catch (err) {
          log.warn(`mention ${mid} fallback post failed: ${err.message}`);
        }
      }

      return { success: true, output: finalText, didSomethingVisible };
    } catch (err) {
      log.error(`mention ${mid} — failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // Throttled feed emitter. Per-worker state, so the window is per work order
  // in flight rather than global — two workers on two work orders each narrate
  // their own progress. Fire-and-forget: a feed write must never interrupt the
  // tool loop, and losing a breadcrumb is strictly better than stalling work.
  _postActivityThrottled(updateId, label) {
    const now = Date.now();
    if (this._lastActivityPostAt && (now - this._lastActivityPostAt) < ACTIVITY_MIN_INTERVAL_MS) return;
    this._lastActivityPostAt = now;
    this.portal.postActivity(updateId, label, 'tool')
      .catch((err) => log.debug(`feed activity post failed: ${err.message}`));
  }

  // Milestones bypass the throttle: they are the events that make the trail
  // legible ("claimed", "opened a PR"), and there are only a handful per run.
  _postMilestone(updateId, label, kind) {
    this._lastActivityPostAt = Date.now();
    this.portal.postActivity(updateId, label, kind)
      .catch((err) => log.debug(`feed milestone post failed: ${err.message}`));
  }

  toolContext(update, briefing) {
    return {
      portal: this.portal,
      identity: this.identity,
      update,
      working_directory: this.config.working_directory || null,
      // Lock all per-project tool calls to this Update's project for the
      // duration of the worker. See ToolRunner.execute for enforcement.
      sessionProjectId: update && update.project_id ? update.project_id : null,
      // Devops-only: per-project log allowlist + DB connection details.
      // Pulled from the project briefing; null on roles that don't have
      // a devops_config field in their briefing response.
      devops_config: (briefing && briefing.devops_config) || null,
      developer_config: (briefing && briefing.developer_config) || null,
      analyst_config: (briefing && briefing.analyst_config) || null
    };
  }

  buildPrompt(update, briefing) {
    const lines = [];
    lines.push(`# Update #${update.id}: ${update.title}`);
    // Project ID up top — most portal tools need it. Calling it out here
    // prevents the LLM from confusing it with the agent's own id.
    if (update.project_id) lines.push(`Project ID: ${update.project_id}`);
    if (update.status) lines.push(`Status (repo-derived): ${update.status}`);
    // The branch IS the work order. The agent commits here and opens a PR.
    if (update.branch_name) lines.push(`Branch: ${update.branch_name}`);
    if (update.wish) lines.push(`Wish: ${update.wish}`);
    if (update.pr_number) lines.push(`PR: #${update.pr_number}${update.pr_html_url ? ' ' + update.pr_html_url : ''}`);
    if (briefing && briefing.project) {
      lines.push('');
      lines.push('## Project briefing');
      lines.push(`**${briefing.project.name}** — ${briefing.project.description || '(no description)'}`);
      if (briefing.project.github_repo_url) {
        lines.push(`Repo: ${briefing.project.github_repo_url}`);
      }
      if (briefing.conventions) {
        lines.push('');
        lines.push('### Conventions');
        for (const [k, v] of Object.entries(briefing.conventions)) {
          lines.push(`- **${k}**: ${v}`);
        }
      }
      if (briefing.my_open_updates && briefing.my_open_updates.length > 0) {
        lines.push('');
        lines.push(`### Your other open Updates (${briefing.my_open_updates.length})`);
        for (const u of briefing.my_open_updates.slice(0, 10)) {
          lines.push(`- #${u.id} [${u.status}] ${u.title}${u.branch_name ? ' <' + u.branch_name + '>' : ''}`);
        }
      }
    }
    // Cross-update research cache — files this agent process read recently.
    if (this.agent && update.project_id) {
      const recents = this.agent.recentReadsFor(update.project_id);
      if (recents && recents.length > 0) {
        lines.push('');
        lines.push(`### Recently read files (this session, last hour)`);
        lines.push(this.agent.policies.cross_task_cache_intro);
        const recent = recents.slice(-15).reverse();
        for (const r of recent) {
          const refSuffix = r.ref ? ` @ ${r.ref}` : '';
          lines.push(`- \`${r.path}\`${refSuffix}`);
        }
      }
    }
    // Update lifecycle contract (work the branch, open a PR, never set status)
    // lives portal-side in agent-policies.js; fetched once at boot.
    lines.push('');
    lines.push(this.agent.policies.update_epilogue || this.agent.policies.task_epilogue || '');
    return lines.join('\n');
  }

  // CLAUDE.md / shared-memory loader. Mirrors how Claude Code CLI loads
  // project instructions — same files, same precedence — so an agent
  // shares the operator's accumulated context.
  loadProjectContext() {
    const wd = this.config.working_directory;
    if (!wd) return null;
    const parts = [];

    const claudeMd = path.join(wd, 'CLAUDE.md');
    if (fs.existsSync(claudeMd)) {
      try {
        const content = fs.readFileSync(claudeMd, 'utf8');
        parts.push(content);
        log.info(`loaded CLAUDE.md (${content.length} chars)`);
      } catch (err) { log.warn(`CLAUDE.md unreadable: ${err.message}`); }
    }

    const instructions = path.join(wd, '.claude', 'instructions.md');
    if (fs.existsSync(instructions)) {
      try { parts.push(fs.readFileSync(instructions, 'utf8')); }
      catch (err) { log.warn(`.claude/instructions.md unreadable: ${err.message}`); }
    }

    const memDir = this.findClaudeMemoryDir(wd);
    if (memDir) {
      const mem = this.loadMemoryDir(memDir);
      if (mem) {
        parts.push('## Shared project memory (from ~/.claude/projects/.../memory)\n\n' +
          'Accumulated notes from prior work. Respect known pitfalls and recent decisions.\n\n' + mem);
      }
    }

    return parts.length > 0 ? parts.join('\n\n---\n\n') : null;
  }

  findClaudeMemoryDir(projectDir) {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return null;
    const root = path.join(home, '.claude', 'projects');
    if (!fs.existsSync(root)) return null;
    // Only exact-escaped path matches. The previous version had a
    // substring fallback (`entry.includes(basename)`) that pulled in
    // memories from unrelated projects when the basename was a common
    // word like "work" or "src" — agents ended up reading notes from
    // someone else's codebase. Better to load no memory than the wrong
    // memory.
    const escaped = projectDir.replace(/\//g, '-');
    const candidates = [
      path.join(root, escaped, 'memory'),
      path.join(root, '-' + escaped, 'memory')
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return null;
  }

  loadMemoryDir(memDir) {
    const parts = [];
    try {
      const indexFile = path.join(memDir, 'MEMORY.md');
      if (fs.existsSync(indexFile)) parts.push(fs.readFileSync(indexFile, 'utf8'));
      const files = fs.readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
      for (const f of files) {
        try { parts.push(fs.readFileSync(path.join(memDir, f), 'utf8')); }
        catch (_) { /* ignore */ }
      }
      if (parts.length > 0) log.info(`loaded ${parts.length} memory file(s) from ${memDir}`);
    } catch (err) { log.warn(`memory dir read failed: ${err.message}`); }
    return parts.length > 0 ? parts.join('\n\n') : null;
  }

  // Updates have no comment thread — communication is on the project channel
  // (agents are first-class participants). Resolve + cache the channel to post to.
  async channelIdFor(projectId) {
    if (this._channelId !== undefined) return this._channelId;
    this._channelId = null;
    try {
      const r = await this.portal.listChannels(projectId);
      const chans = (r && r.channels) || (Array.isArray(r) ? r : []);
      const general = chans.find((c) => c.name === 'general') || chans[0];
      if (general) this._channelId = general.id;
    } catch (err) { log.warn(`channel lookup failed for project ${projectId}: ${err.message}`); }
    return this._channelId;
  }

  // Post a message to the project channel (sign-off, blocker, diagnostic).
  async notify(update, briefing, text) {
    const cid = await this.channelIdFor(update.project_id);
    if (!cid) { log.warn(`no channel to notify for project ${update.project_id}`); return; }
    try { await this.portal.postMessage(cid, { body: String(text).slice(0, 4000) }); }
    catch (err) { log.warn(`notify failed: ${err.message}`); }
  }

  // Give up on an Update: post a diagnostic to the channel and release the
  // claim so it surfaces for review (an unclaimed assigned Update is the
  // "needs attention" signal). Status stays repo-derived.
  async abandon(update, briefing, text) {
    await this.notify(update, briefing, text);
    await this.portal.releaseUpdate(update.id).catch(() => {});
  }

  // Used by tests / debugging. Not called in the hot path.
  sanitizeForLog(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const out = Array.isArray(obj) ? [] : {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) out[k] = '***';
      else if (typeof v === 'object' && v !== null) out[k] = this.sanitizeForLog(v);
      else if (typeof v === 'string' && v.length > 500) out[k] = v.slice(0, 500) + '...';
      else out[k] = v;
    }
    return out;
  }
}

module.exports = UpdateWorker;
