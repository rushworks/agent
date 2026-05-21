"use strict";

// GitHub tools — all developer-only. The server also enforces this with
// requireAgentRole('developer'), so an analyst hitting these gets 403.
// We never embed git credentials in tool output other than the minted
// install token that the agent immediately uses for a clone/push.

module.exports = [
  {
    name: 'github_mint_token',
    roles: ['developer'],
    description: 'Mint a short-lived (≤1 hour) GitHub install token + clone URL for a project. The token is single-use within the lifetime; if it expires, mint another.',
    parameters: {
      type: 'object',
      required: ['project_id'],
      properties: { project_id: { type: 'integer' } }
    },
    async execute({ project_id }, { portal }) {
      const r = await portal.mintGitToken(project_id);
      return JSON.stringify(r);
    }
  },

  {
    name: 'github_open_pull_request',
    roles: ['developer'],
    description: 'Open a pull request on the project\'s repo. Use a head branch like agent/<your-id>/<task-id>-<slug> so the PR auto-links to the task when you mark it Ready.',
    parameters: {
      type: 'object',
      required: ['project_id', 'title', 'head', 'base'],
      properties: {
        project_id: { type: 'integer' },
        title:      { type: 'string' },
        head:       { type: 'string', description: 'Branch you pushed' },
        base:       { type: 'string', description: 'Branch to merge into (typically "main")' },
        body:       { type: 'string', description: 'PR description; include "Closes task #<id>" to auto-link.' },
        draft:      { type: 'boolean' }
      }
    },
    async execute({ project_id, title, head, base, body, draft }, { portal }) {
      const r = await portal.openPullRequest(project_id, { title, head, base, body, draft });
      return JSON.stringify(r);
    }
  },

  {
    name: 'github_comment_on_pr',
    roles: ['developer'],
    description: 'Post a comment on an existing PR (e.g. a status update during long-running work).',
    parameters: {
      type: 'object',
      required: ['project_id', 'pr_number', 'body'],
      properties: {
        project_id: { type: 'integer' },
        pr_number:  { type: 'integer' },
        body:       { type: 'string' }
      }
    },
    async execute({ project_id, pr_number, body }, { portal }) {
      const r = await portal.commentOnPullRequest(project_id, pr_number, body);
      return JSON.stringify(r);
    }
  },

  {
    name: 'github_list_commits',
    roles: ['developer'],
    description: 'List recent commits on the default branch (or a specified branch).',
    parameters: {
      type: 'object',
      required: ['project_id'],
      properties: {
        project_id: { type: 'integer' },
        branch:     { type: 'string' },
        per_page:   { type: 'integer', description: 'default 50, max 100' }
      }
    },
    async execute({ project_id, branch, per_page }, { portal }) {
      const r = await portal.listCommits(project_id, { branch, per_page });
      return JSON.stringify(r);
    }
  },

  {
    name: 'github_list_pull_requests',
    roles: ['developer'],
    description: 'List pull requests on the project repo. State defaults to "open".',
    parameters: {
      type: 'object',
      required: ['project_id'],
      properties: {
        project_id: { type: 'integer' },
        state:      { type: 'string', enum: ['open', 'closed', 'all'] },
        per_page:   { type: 'integer' }
      }
    },
    async execute({ project_id, state, per_page }, { portal }) {
      const r = await portal.listPullRequests(project_id, { state, per_page });
      return JSON.stringify(r);
    }
  }
];
