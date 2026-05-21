"use strict";

const fs = require('fs');
const path = require('path');
const log = require('./Log');

// Per-task LLM tool-use loop. Holds no state between executions — one
// worker per task per invocation, then garbage-collected. The Agent
// decides when to spawn workers based on WebSocket events or catchup.
//
// Lifecycle per task:
//   1. Set task to In Progress
//   2. Build prompt (briefing + task detail + CLAUDE.md context)
//   3. Loop: LLM call → execute tool_use blocks → feed results back
//   4. Stop on end_turn or max_iterations
//   5. Post final text as a comment + move task to Ready (success path)
//      or post error + leave at In Progress with needs_input (failure path)

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
  portal_list_tasks:             'Listing my tasks',
  portal_list_project_tasks:     'Reviewing the backlog',
  portal_get_task:               'Reading task detail',
  portal_set_task_status:        'Updating status',
  portal_create_task:            'Creating a task',
  portal_update_task:            'Editing a task',
  portal_comment_on_task:        'Posting a comment',
  portal_request_input:          'Asking for input',
  portal_resolve_input:          'Resolving input',
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
  system_list_dir:               'Listing files',
  system_read_file:              'Reading a file',
  system_write_file:             'Writing a file',
  system_edit_file:               'Editing a file',
  system_glob:                   'Searching for files',
  system_grep:                   'Searching code',
  system_bash:                   'Running a command'
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

class TaskWorker {
  constructor({ llm, toolRunner, portal, identity, config, agent }) {
    this.llm = llm;
    this.toolRunner = toolRunner;
    this.portal = portal;
    this.identity = identity;          // { id, display_name, role, ... }
    this.config = config || {};
    this.agent = agent || null;        // back-reference for cross-task caches
  }

  async execute(task, systemPrompt) {
    const taskId = task.id;
    log.info(`task ${taskId} (${task.name}) — starting`);

    try {
      // Move to In Progress (no-op if already there).
      if (task.status !== 'In Progress') {
        await this.portal.setTaskStatus(taskId, 'In Progress');
      }

      // Pull project briefing for inline context. Briefing includes
      // branch / PR conventions + my open task list so the LLM has a
      // sense of priority without a separate fetch.
      let briefing = null;
      if (task.project_id) {
        try { briefing = await this.portal.getBriefing(task.project_id); }
        catch (err) { log.warn(`briefing fetch failed: ${err.message}`); }
      }

      // CLAUDE.md / memory context — local-only, only if working_directory
      // is set. This lifts the project's accumulated knowledge into the
      // agent's prompt the same way Claude Code CLI does.
      const projectContext = this.loadProjectContext();
      const fullSystem = [
        systemPrompt,
        projectContext && '## Project conventions (CLAUDE.md and shared memory)\n\n' + projectContext
      ].filter(Boolean).join('\n\n---\n\n');

      const userPrompt = this.buildPrompt(task, briefing);
      const tools = this.toolRunner.definitions();
      const messages = [{ role: 'user', content: userPrompt }];

      const maxIters = this.config.max_iterations_per_task || 20;
      let iter = 0;
      let finalText = '';
      // Track the last few tool-call signatures so we can break out when
      // the LLM fixates on a failing call. Without this, a model that keeps
      // sending the same broken payload burns the whole iter budget before
      // giving up. Three identical failed iters in a row is the trigger.
      const recentFailures = [];
      // Parallel track on error-message prefixes. Devon's "no
      // working_directory configured" failure hit across system_bash,
      // system_list_dir, system_glob — different tool names + inputs,
      // so the signature-match guard never fired. Matching on error
      // prefix catches "same environmental problem, different attempts."
      const recentErrors = [];
      // Track which tool families the LLM exercised so the epilogue can
      // avoid duplicating work the LLM already did. This is the difference
      // between "old-school agent emits final text, harness posts it as the
      // deliverable" and "modern agent drives status + comments explicitly
      // via tools" — we want to support both without doubling up.
      const calledTools = new Set();
      // Same thing but scoped to THIS task. Without this we'd get fooled by
      // an LLM that comments on N sibling tasks but never on the one being
      // worked — the epilogue would assume a deliverable was posted and
      // skip the auto-comment.
      const calledOnThisTask = new Set();
      // The latest status the LLM set on THIS task, if any. Just knowing
      // "set_task_status was called" isn't enough — an LLM that moves
      // Queued → In Progress at the start then forgets to move to Ready
      // would have left the task in flight. The handoff is what matters.
      let lastStatusSetHere = null;
      // Did the LLM flag THIS task as needing input? When true, the task
      // is intentionally paused — leave it In Progress with the
      // needs_input fields set, and let the WS input_resolved event wake
      // a fresh worker when the human answers. Auto-Ready / auto-comment
      // both skip in this case.
      let requestedInputHere = false;
      // Total tool calls made across all iters. Used at the epilogue to
      // detect the "LLM did literally nothing" failure mode — empty
      // end_turn at iter 1 with no tools, no text. Without this we'd
      // auto-Ready a task that never got worked.
      let totalToolCalls = 0;

      while (iter < maxIters) {
        iter += 1;
        const res = await this.llm.chat({
          system: fullSystem,
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
          log.info(`task ${taskId} — iter ${iter}: end_turn (final text: ${finalText.length} chars)`);
          break;
        }

        // Surface output-cap truncation. When max_tokens is hit mid-tool-use,
        // the input JSON for the tool gets cut off — usually losing a long
        // string field like a doc body — and the call fails on the server
        // for "missing required field" / "nothing to update". Bumping
        // max_tokens (env RW_MAX_TOKENS) is the fix.
        if (res.stop_reason === 'max_tokens') {
          log.warn(`task ${taskId} — iter ${iter} HIT max_tokens cap (${this.llm.maxTokens}); tool input may be truncated`);
        }

        totalToolCalls += toolUses.length;

        // One log line per iter summarizing the tools the model called.
        // Args are compressed to one line; long string values get clipped at
        // 40 chars so a comment body doesn't blow up the log.
        const summary = toolUses.map((u) => `${u.name}(${summarizeToolArgs(u.input)})`).join(', ');
        log.info(`task ${taskId} — iter ${iter} → ${summary}`);

        // Fire-and-forget the human-readable activity line back to the
        // portal so the kanban card shows live progress. Never block the
        // tool loop on this — a failed write just means a momentarily
        // stale card.
        this.portal.setActivity(taskId, summarizeActivity(toolUses))
          .catch((err) => log.debug(`activity emit failed: ${err.message}`));

        messages.push({ role: 'assistant', content: res.content });

        const toolResults = [];
        for (const use of toolUses) {
          let payload;
          let isError = false;
          try {
            const name = this.toolRunner.fromApiName(use.name);
            calledTools.add(name);
            // Per-task tracking — only counts when the tool's task_id arg
            // matches the task we're working. portal_create_task and
            // portal_list_project_tasks don't take a task_id, so they
            // naturally fall out of this check.
            if (use.input && Number(use.input.task_id) === Number(taskId)) {
              calledOnThisTask.add(name);
              if (name === 'portal_set_task_status' && typeof use.input.status === 'string') {
                lastStatusSetHere = use.input.status;
              }
              if (name === 'portal_request_input') {
                requestedInputHere = true;
              }
            }
            payload = await this.toolRunner.execute(name, use.input, this.toolContext(task, briefing));
            // Cross-task research cache. After a successful repo_get
            // (or legacy repo_read_file) on a file, record the path
            // so sibling task workers can avoid re-exploring it. We
            // only record file reads, not directory listings — listings
            // are cheap and noisy.
            if (!isError && this.agent && use.input && use.input.path) {
              if (name === 'repo_get' || name === 'repo_read_file') {
                this.agent.recordRead({
                  projectId: use.input.project_id || task.project_id || null,
                  path: use.input.path,
                  ref: use.input.ref || null
                });
              }
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

        // Fixation-loop guard. Two parallel checks for "the model is stuck":
        //   (a) Same call signature repeated — classic loop on a broken
        //       payload. Fires fixation_loop intervention.
        //   (b) Same error prefix returned from different tools — an
        //       environmental problem (missing config, network down, role-
        //       forbidden) the model can't escape by trying different
        //       tool shapes. Fires stuck_on_error intervention.
        // Three strikes in a row triggers either one.
        const allErrored = toolResults.length > 0 && toolResults.every((r) => r.is_error);
        if (allErrored) {
          const sig = toolUses.map((u) => `${u.name}:${JSON.stringify(u.input || {}).slice(0, 200)}`).join('|');
          recentFailures.push(sig);
          if (recentFailures.length > 3) recentFailures.shift();

          const errPrefix = String(toolResults[0].content).slice(0, 120);
          recentErrors.push(errPrefix);
          if (recentErrors.length > 3) recentErrors.shift();

          if (recentFailures.length === 3 && recentFailures.every((s) => s === recentFailures[0])) {
            const names = toolUses.map((u) => u.name).join(', ');
            const lastErr = String(toolResults[0].content).slice(0, 300);
            const note = substitute(this.agent.policies.fixation_loop_diagnosis, {
              names, last_err: lastErr
            });
            await this.safeComment(taskId, '⚠️ ' + note);
            await this.flagIntervention(taskId, {
              kind: 'fixation_loop',
              reason: note
            });
            log.warn(`task ${taskId} — broke loop on 3x identical failure (${names})`);
            return { success: false, error: 'fixation_loop', diagnosis: note };
          }

          if (recentErrors.length === 3 && recentErrors.every((s) => s === recentErrors[0])) {
            const lastErr = String(toolResults[0].content).slice(0, 300);
            const note = substitute(this.agent.policies.stuck_on_error_diagnosis, {
              last_err: lastErr
            });
            await this.safeComment(taskId, '⚠️ ' + note);
            await this.flagIntervention(taskId, {
              kind: 'stuck_on_error',
              reason: note
            });
            log.warn(`task ${taskId} — broke loop on 3x identical error: ${errPrefix.slice(0, 80)}`);
            return { success: false, error: 'stuck_on_error', diagnosis: note };
          }
        } else {
          recentFailures.length = 0;
          recentErrors.length = 0;
        }
      }

      if (iter >= maxIters) {
        const note = `Hit max iterations (${maxIters}). Latest output:\n\n${finalText || '(no text output)'}`;
        await this.safeComment(taskId, '⚠️ ' + note);
        await this.flagIntervention(taskId, {
          kind: 'max_iterations',
          reason: `Reached the per-task iteration cap (${maxIters}) without finishing. The work may be too large for a single session, or the model is going in circles.`
        });
        log.warn(`task ${taskId} — max iterations reached`);
        return { success: false, error: 'max_iterations' };
      }

      // Paused-on-input path: the LLM flagged this task as needing human
      // input and ended the turn. Don't fill any gaps — the task is
      // intentionally in flight, the human will respond via the portal
      // UI, and the WS input_resolved event will wake a fresh worker.
      // Auto-Ready here would silently bypass the human gate.
      if (requestedInputHere) {
        log.info(`task ${taskId} — paused awaiting input (no auto-transition, no auto-comment)`);
        return { success: true, output: finalText, paused: 'needs_input' };
      }

      // Empty-response guard. If the LLM ended without producing ANY
      // visible output — no tool calls, no final text — auto-Ready would
      // move the task to Ready with no deliverable visible to the PM,
      // hiding the failure. Flag intervention instead so the PM sees
      // the amber "Needs review" badge and can retry or rephrase.
      if (totalToolCalls === 0 && !finalText.trim()) {
        const note = 'The agent ended the task without producing any output — no tool calls and no text. This is usually a model flake or an ambiguous task description.';
        await this.safeComment(taskId, '⚠️ ' + note);
        await this.flagIntervention(taskId, {
          kind: 'empty_response',
          reason: note
        });
        log.warn(`task ${taskId} — empty response, intervention flagged (no tools, no text)`);
        return { success: false, error: 'empty_response' };
      }

      // Success path. The LLM may have driven everything itself (modern
      // agent style) or it may have just produced text (old-school style).
      // Only fill gaps the LLM left on THIS task — not get fooled by it
      // having operated on sibling tasks. An analyst can spend a whole
      // session commenting on N peer tasks; if it never comments on the
      // spawn task itself, the spawn deserves the auto-post.
      const didCommentHere = calledOnThisTask.has('portal_comment_on_task');

      if (!didCommentHere && finalText.trim()) {
        await this.safeComment(taskId, finalText);
        log.info(`task ${taskId} — posted final text as comment (LLM did not comment on this task)`);
      } else if (didCommentHere && finalText.trim()) {
        // She drove the deliverable on this task. The end_turn text is
        // just a closing remark — log it for the operator but don't post
        // duplicate noise.
        log.debug(`task ${taskId} — end_turn text (not posted, LLM already commented on this task): ${finalText.slice(0, 80)}…`);
      }

      // Status epilogue. The LLM may have moved through statuses (Queued
      // → In Progress → Ready) or may have only set the start state.
      // Auto-move to Ready unless the final status the LLM set is a
      // terminal-handoff (Ready) or terminal (Completed). Cancelled is
      // server-rejected for agents but we treat it as terminal too.
      const ACTIVE_IN_FLIGHT = new Set(['Queued', 'In Progress', null]);
      if (ACTIVE_IN_FLIGHT.has(lastStatusSetHere)) {
        await this.portal.setTaskStatus(taskId, 'Ready');
        log.info(`task ${taskId} — auto-moved to Ready (LLM left status as ${lastStatusSetHere || 'unchanged'})`);
      } else {
        log.info(`task ${taskId} — finished (LLM drove status to ${lastStatusSetHere}, no auto-transition)`);
      }
      return { success: true, output: finalText };

    } catch (err) {
      log.error(`task ${taskId} — failed: ${err.message}`);
      await this.safeComment(taskId,
        `⚠️ Agent error: ${err.message}\n\nLeaving task in its current status for review.`)
        .catch(() => {});
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

      const promptText = [
        '# You were @-mentioned in a channel',
        '',
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
              devops_config: (mentionBriefing && mentionBriefing.devops_config) || null
            });
            if (!isError && (name === 'portal_post_message' || name === 'portal_create_task')) {
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
      // Post a fallback ack so every mention has a visible response.
      // Copy comes from /api/agent/policies so the public agent doesn't
      // ship the proprietary acknowledgement language.
      if (!didSomethingVisible) {
        log.warn(`mention ${mid} — LLM produced no visible action; posting fallback ack`);
        try {
          await this.portal.postMessage(message.channel_id, {
            body: this.agent.policies.silence_ack_copy
          });
        } catch (err) {
          log.warn(`mention ${mid} fallback ack failed: ${err.message}`);
        }
      }

      return { success: true, output: finalText, didSomethingVisible };
    } catch (err) {
      log.error(`mention ${mid} — failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  toolContext(task, briefing) {
    return {
      portal: this.portal,
      identity: this.identity,
      task,
      working_directory: this.config.working_directory || null,
      // Lock all per-project tool calls to this task's project for the
      // duration of the worker. See ToolRunner.execute for enforcement.
      sessionProjectId: task && task.project_id ? task.project_id : null,
      // Devops-only: per-project log allowlist + DB connection details.
      // Pulled from the project briefing; null on roles that don't have
      // a devops_config field in their briefing response.
      devops_config: (briefing && briefing.devops_config) || null
    };
  }

  buildPrompt(task, briefing) {
    const lines = [];
    lines.push(`# Task #${task.id}: ${task.name}`);
    // Project ID up top — most portal tools need it. Calling it out here
    // prevents the LLM from confusing it with the agent's own id when both
    // are small integers in scope.
    if (task.project_id) lines.push(`Project ID: ${task.project_id}`);
    if (task.status) lines.push(`Status: ${task.status}`);
    if (task.priority !== null && task.priority !== undefined) {
      lines.push(`Priority: ${task.priority}`);
    }
    if (task.due_on) lines.push(`Due: ${task.due_on}`);
    if (task.description) {
      lines.push('');
      lines.push('## Description');
      lines.push(task.description);
    }
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
      if (briefing.my_open_tasks && briefing.my_open_tasks.length > 0) {
        lines.push('');
        lines.push(`### Your other open tasks (${briefing.my_open_tasks.length})`);
        for (const t of briefing.my_open_tasks.slice(0, 10)) {
          lines.push(`- #${t.id} [${t.status}] ${t.name}`);
        }
      }
    }
    // Cross-task research cache — files this same agent process read
    // for sibling tasks within the last hour. Lets the LLM skip
    // re-exploration when the same files are likely relevant. Cap at
    // 15 lines so we don't blow up the prompt budget. Preamble text
    // comes from /api/agent/policies so the public agent doesn't bake
    // in the proprietary cache-usage instructions.
    if (this.agent && task.project_id) {
      const recents = this.agent.recentReadsFor(task.project_id);
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
    // Task lifecycle contract (move to Ready on completion etc.) lives
    // portal-side in agent-policies.js, fetched once at boot.
    lines.push('');
    lines.push(this.agent.policies.task_epilogue);
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

  async safeComment(taskId, body) {
    // 16k mirrors the portal's accepted comment body limit. Anything
    // longer gets truncated silently — the alternative (failing the
    // call) wastes an iter while the model figures out it needs to
    // split, which is worse than a quietly clipped tail.
    try { await this.portal.commentOnTask(taskId, body.slice(0, 16384)); }
    catch (err) { log.warn(`comment failed on task ${taskId}: ${err.message}`); }
  }

  async flagIntervention(taskId, { reason, kind }) {
    try { await this.portal.flagIntervention(taskId, { reason, kind }); }
    catch (err) { log.warn(`intervention flag failed on task ${taskId}: ${err.message}`); }
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

module.exports = TaskWorker;
