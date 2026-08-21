"use strict";

// Portal tools — calls into the RushworksAI portal via the agent REST API.
// Available to BOTH roles (analyst and developer). Each tool returns either
// a JSON string the LLM will parse, or a human-readable status line.

module.exports = [
  {
    name: 'portal_list_updates',
    roles: ['analyst', 'developer', 'devops'],
    description: 'List the Updates ASSIGNED TO YOU that are ready to work (activated + sanctioned + open). An Update is a branch-backed unit of work; its status is derived from the repo, so you never set status — you claim it, work its branch, and open a PR.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: 'Optional project filter' }
      }
    },
    async execute(input, { portal }) {
      const r = await portal.listMyUpdates(input || {});
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_get_update',
    roles: ['analyst', 'developer', 'devops'],
    description: 'Get the full detail of an Update (title, branch_name, wish, status, PR link).',
    parameters: {
      type: 'object',
      required: ['update_id'],
      properties: { update_id: { type: 'integer' } }
    },
    async execute({ update_id }, { portal }) {
      const r = await portal.getUpdate(update_id);
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_claim_update',
    roles: ['developer', 'devops'],
    description: 'Claim an Update assigned to you (start work). Succeeds only if it is assigned to you, activated, and sanctioned. This is a soft lease that says "I am working this now"; it does NOT set status — your commits and PR drive status.',
    parameters: {
      type: 'object',
      required: ['update_id'],
      properties: { update_id: { type: 'integer' } }
    },
    async execute({ update_id }, { portal }) {
      const r = await portal.claimUpdate(update_id);
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_release_update',
    roles: ['developer', 'devops'],
    description: 'Release your claim on an Update (you are stepping away). Does not change status.',
    parameters: {
      type: 'object',
      required: ['update_id'],
      properties: { update_id: { type: 'integer' } }
    },
    async execute({ update_id }, { portal }) {
      const r = await portal.releaseUpdate(update_id);
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_create_update',
    roles: ['analyst'],
    description: 'Decompose a CONFIRMED wish into an Update (a branch-backed work order). Analysts only. The Update is born Requested + sanctioned; pass activate=true and assignee_agent_id to release it to a developer in one step. Developers cannot create Updates.',
    parameters: {
      type: 'object',
      required: ['project_id', 'title'],
      properties: {
        project_id:        { type: 'integer' },
        title:             { type: 'string', description: 'Short work-order title (≤255 chars)' },
        wish_id:           { type: 'integer', description: 'The confirmed wish this Update ladders under. Strongly recommended.' },
        branch_name:       { type: 'string', description: 'Optional; defaults to a slug of the title. The branch the worker commits to.' },
        assignee_agent_id: { type: 'integer', description: 'Optional: route to a developer agent on the project (id from the briefing).' },
        activate:          { type: 'boolean', description: 'Set true to activate immediately so the assignee can claim it.' }
      }
    },
    async execute({ project_id, ...rest }, { portal }) {
      const r = await portal.createUpdate(project_id, rest);
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_activate_update',
    roles: ['analyst'],
    description: 'Activate a Requested Update so its assignee can claim it (the hard go-ahead gate). Analysts only.',
    parameters: {
      type: 'object',
      required: ['update_id'],
      properties: { update_id: { type: 'integer' } }
    },
    async execute({ update_id }, { portal }) {
      const r = await portal.activateUpdate(update_id);
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_assign_update',
    roles: ['analyst'],
    description: 'Route an Update to a worker (a developer agent or a user), or clear its assignee. Analysts only. Use agent ids from the briefing.',
    parameters: {
      type: 'object',
      required: ['update_id'],
      properties: {
        update_id: { type: 'integer' },
        kind:      { type: 'string', enum: ['agent', 'user'], description: 'Omit (with id) and set clear=true to unassign.' },
        id:        { type: 'integer', description: 'The agent id or user id to assign.' },
        clear:     { type: 'boolean', description: 'Set true to clear the assignee.' }
      }
    },
    async execute({ update_id, kind, id, clear }, { portal }) {
      const r = await portal.assignUpdate(update_id, clear ? { clear: true } : { kind, id });
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
    description: 'Fetch the orientation packet for a project — meta, your open Updates, branch/PR conventions.',
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
