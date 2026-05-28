"use strict";

// Portal tools — calls into the RushworksAI portal via the agent REST API.
// Available to BOTH roles (analyst and developer). Each tool returns either
// a JSON string the LLM will parse, or a human-readable status line.

const NEEDS_INPUT_KINDS = ['decision', 'review', 'clarification', 'access', 'other'];

module.exports = [
  {
    name: 'portal_list_tasks',
    roles: ['analyst', 'developer', 'devops'],
    description: 'List tasks ASSIGNED TO YOU. For backlog review, prioritization, or seeing what others are working on, use portal_list_project_tasks instead — it returns every task in a project regardless of assignee.',
    parameters: {
      type: 'object',
      properties: {
        status:     { type: 'string', description: 'Optional status filter' },
        project_id: { type: 'integer', description: 'Optional project filter' }
      }
    },
    async execute(input, { portal }) {
      const r = await portal.listTasks(input || {});
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_list_project_tasks',
    roles: ['analyst', 'developer', 'devops'],
    description: 'List ALL tasks in a project you are assigned to, regardless of who they are assigned to. Use this for backlog review, prioritization, triage, or building summaries of project state. The project_id is the one shown at the top of the current task prompt (the "Project ID:" line) or in the project briefing — it is NOT your agent id. If you do not have a project_id in scope, call portal_list_projects first to discover it.',
    parameters: {
      type: 'object',
      required: ['project_id'],
      properties: {
        project_id: { type: 'integer', description: 'The id of a project you are assigned to (from the task prompt or briefing). Distinct from your agent id.' },
        status:     { type: 'string', description: 'Backlog, Queued, In Progress, Ready, Completed, or Cancelled' },
        assignee:   { type: 'string', description: 'unassigned | human | agent | user:<id> | agent:<id>' },
        limit:      { type: 'integer', description: 'Default 100, max 500' }
      }
    },
    async execute({ project_id, status, assignee, limit }, { portal }) {
      const r = await portal.listProjectTasks(project_id, { status, assignee, limit });
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_get_task',
    roles: ['analyst', 'developer', 'devops'],
    description: 'Get the full detail of a task (description, events, linked PRs).',
    parameters: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'integer' } }
    },
    async execute({ task_id }, { portal }) {
      const r = await portal.getTask(task_id);
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_set_task_status',
    roles: ['analyst', 'developer', 'devops'],
    description: 'Move a task to a new status. Allowed: Queued, In Progress, Ready, Cancelled. You cannot mark a task Completed — that\'s the human acceptance moment.',
    parameters: {
      type: 'object',
      required: ['task_id', 'status'],
      properties: {
        task_id: { type: 'integer' },
        status:  { type: 'string', enum: ['Queued', 'In Progress', 'Ready', 'Cancelled'] }
      }
    },
    async execute({ task_id, status }, { portal }) {
      const r = await portal.setTaskStatus(task_id, status);
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_create_task',
    roles: ['analyst', 'developer', 'devops'],
    description: 'Create a new task in a project. Use this to split a big task into subtasks (via parent_task_id), to seed work from a conversation, or to capture follow-ups. Defaults to Backlog + unassigned. If you omit priority, the task is appended at the bottom of its column (lowest priority within the project + status).',
    parameters: {
      type: 'object',
      required: ['project_id', 'name'],
      properties: {
        project_id:     { type: 'integer' },
        name:           { type: 'string', description: 'Short title (≤200 chars)' },
        description:    { type: 'string' },
        priority:       { type: 'integer', description: 'Non-negative integer (lower = higher priority). Optional — omit to append at the bottom of the column.' },
        due_on:         { type: 'string',  description: 'ISO 8601 timestamp. Optional.' },
        parent_task_id: { type: 'integer', description: 'Set this for subtasks. Must be in the same project.' },
        assignee:       { type: 'string',  description: '"user:<id>" or "agent:<id>". Omit for unassigned.' },
        status:         { type: 'string',  enum: ['Backlog', 'Queued', 'In Progress', 'Ready'],
                          description: 'Default Backlog. Use Queued to put it directly on the active board.' }
      }
    },
    async execute({ project_id, ...rest }, { portal }) {
      const r = await portal.createTask(project_id, rest);
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_update_task',
    roles: ['analyst', 'developer'],
    description: 'Edit a task: rename, change description / priority / due date / parent task / assignee. Pass only the fields you want to change. Status changes use portal_set_task_status instead. Terminal-state tasks (Completed/Cancelled) cannot be edited.',
    parameters: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id:        { type: 'integer' },
        name:           { type: 'string' },
        description:    { type: 'string' },
        priority:       { type: 'integer', description: 'Non-negative integer (lower = higher priority). Required when present — null is rejected. To deprioritize, set a large number.' },
        due_on:         { type: 'string',  description: 'ISO 8601 timestamp; empty string to clear.' },
        parent_task_id: { type: 'integer', description: 'null to detach from parent; positive int to set.' },
        assignee:       { type: 'string',  description: '"user:<id>", "agent:<id>", or empty string to unassign.' }
      }
    },
    async execute({ task_id, ...changes }, { portal }) {
      const r = await portal.updateTask(task_id, changes);
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_comment_on_task',
    roles: ['analyst', 'developer', 'devops'],
    description: 'Post a comment on a task. The comment appears in the activity feed alongside status changes and PR links.',
    parameters: {
      type: 'object',
      required: ['task_id', 'body'],
      properties: {
        task_id: { type: 'integer' },
        body:    { type: 'string', description: 'Comment text (max 4000 chars)' }
      }
    },
    async execute({ task_id, body }, { portal }) {
      const r = await portal.commentOnTask(task_id, body);
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_request_input',
    roles: ['analyst', 'developer', 'devops'],
    description: 'Flag a task as needing input from a specific human. The task stays in its current status; the recipient gets a notification.',
    parameters: {
      type: 'object',
      required: ['task_id', 'from_user_id'],
      properties: {
        task_id:      { type: 'integer' },
        from_user_id: { type: 'integer' },
        kind:         { type: 'string', enum: NEEDS_INPUT_KINDS },
        note:         { type: 'string', description: 'What you need from them (≤1000 chars)' }
      }
    },
    async execute({ task_id, from_user_id, kind, note }, { portal }) {
      const r = await portal.requestInput(task_id, { from_user_id, kind, note });
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_resolve_input',
    roles: ['analyst', 'developer', 'devops'],
    description: 'Withdraw an input request you made earlier (e.g. you found the answer yourself).',
    parameters: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'integer' } }
    },
    async execute({ task_id }, { portal }) {
      const r = await portal.resolveInput(task_id);
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_list_projects',
    roles: ['analyst', 'developer', 'devops'],
    description: "List all projects you're assigned to.",
    parameters: { type: 'object', properties: {} },
    async execute(_input, { portal }) {
      const r = await portal.listProjects();
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_get_briefing',
    roles: ['analyst', 'developer', 'devops'],
    description: 'Fetch the orientation packet for a project — meta, your open tasks, branch/PR conventions.',
    parameters: {
      type: 'object',
      required: ['project_id'],
      properties: { project_id: { type: 'integer' } }
    },
    async execute({ project_id }, { portal }) {
      const r = await portal.getBriefing(project_id);
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_list_channels',
    roles: ['analyst', 'developer', 'devops'],
    description: 'List channels in a project (e.g. #general).',
    parameters: {
      type: 'object',
      required: ['project_id'],
      properties: { project_id: { type: 'integer' } }
    },
    async execute({ project_id }, { portal }) {
      const r = await portal.listChannels(project_id);
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_list_channel_messages',
    roles: ['analyst', 'developer', 'devops'],
    description: 'Read a channel\'s message history. Use before=<id> to paginate older messages; limit defaults to 50, max 100.',
    parameters: {
      type: 'object',
      required: ['channel_id'],
      properties: {
        channel_id: { type: 'integer' },
        before:     { type: 'integer' },
        limit:      { type: 'integer' }
      }
    },
    async execute({ channel_id, before, limit }, { portal }) {
      const r = await portal.listChannelMessages(channel_id, { before, limit });
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_post_message',
    roles: ['analyst', 'developer', 'devops'],
    description: 'Post a message to a channel. Pass thread_parent_id to reply in a thread.',
    parameters: {
      type: 'object',
      required: ['channel_id', 'body'],
      properties: {
        channel_id:       { type: 'integer' },
        body:             { type: 'string' },
        thread_parent_id: { type: 'integer' }
      }
    },
    async execute({ channel_id, body, thread_parent_id }, { portal }) {
      const r = await portal.postMessage(channel_id, { body, thread_parent_id });
      return JSON.stringify(r);
    }
  }
];
