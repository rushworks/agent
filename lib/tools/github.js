"use strict";

// GitHub tools. Write operations (mint token, open PR) are developer-only.
// Read operations (list/get PRs, commits, files) and PR comments are
// available to both analyst and developer roles so analysts can do code
// review, write release notes, and assess in-flight work.

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
    roles: ['analyst', 'developer'],
    description: 'Post a comment on an existing PR (e.g. code review feedback, status update, or summary).',
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
    roles: ['analyst', 'developer'],
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
    roles: ['analyst', 'developer'],
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
  },

  {
    name: 'github_get_pull_request',
    roles: ['analyst', 'developer'],
    description: 'Get full detail for a single PR: title, body/description, state, draft/merged status, diff stats (additions/deletions/changed_files), head/base branches, labels, and review comment count. Use after list_pull_requests to drill into a specific PR.',
    parameters: {
      type: 'object',
      required: ['project_id', 'pr_number'],
      properties: {
        project_id: { type: 'integer' },
        pr_number:  { type: 'integer' }
      }
    },
    async execute({ project_id, pr_number }, { portal }) {
      const r = await portal.getPullRequest(project_id, pr_number);
      return JSON.stringify(r);
    }
  },

  {
    name: 'github_list_pull_request_files',
    roles: ['analyst', 'developer'],
    description: 'List files changed in a PR with their status (added/modified/removed/renamed), line counts (additions/deletions), and unified diff patch. Use for code review or to understand the scope of a change.',
    parameters: {
      type: 'object',
      required: ['project_id', 'pr_number'],
      properties: {
        project_id: { type: 'integer' },
        pr_number:  { type: 'integer' },
        per_page:   { type: 'integer', description: 'default 100, max 300' }
      }
    },
    async execute({ project_id, pr_number, per_page }, { portal }) {
      const r = await portal.getPullRequestFiles(project_id, pr_number, { per_page });
      return JSON.stringify(r);
    }
  },

  {
    name: 'github_get_check_runs',
    roles: ['analyst', 'developer'],
    description: 'Get CI / check-run status for a git ref (branch name, tag, or SHA). Shows each check\'s name, status (queued/in_progress/completed), conclusion (success/failure/neutral/etc), and timing.',
    parameters: {
      type: 'object',
      required: ['project_id', 'ref'],
      properties: {
        project_id: { type: 'integer' },
        ref:        { type: 'string', description: 'Branch name, tag, or commit SHA' },
        per_page:   { type: 'integer', description: 'default 50, max 100' }
      }
    },
    async execute({ project_id, ref, per_page }, { portal }) {
      const r = await portal.getCheckRuns(project_id, ref, { per_page });
      return JSON.stringify(r);
    }
  },

  {
    name: 'github_list_pr_comments',
    roles: ['analyst', 'developer'],
    description: 'List conversation-level comments on a PR (the "Comments" tab, not inline review comments). Useful for reading discussion history on an open or closed PR.',
    parameters: {
      type: 'object',
      required: ['project_id', 'pr_number'],
      properties: {
        project_id: { type: 'integer' },
        pr_number:  { type: 'integer' },
        per_page:   { type: 'integer', description: 'default 100, max 100' }
      }
    },
    async execute({ project_id, pr_number, per_page }, { portal }) {
      const r = await portal.listPRComments(project_id, pr_number, { per_page });
      return JSON.stringify(r);
    }
  },

  {
    name: 'github_list_pr_reviews',
    roles: ['analyst', 'developer'],
    description: 'List reviews on a PR: who reviewed, their state (APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED), and the review body. Use to check approval status before merge.',
    parameters: {
      type: 'object',
      required: ['project_id', 'pr_number'],
      properties: {
        project_id: { type: 'integer' },
        pr_number:  { type: 'integer' },
        per_page:   { type: 'integer', description: 'default 100, max 100' }
      }
    },
    async execute({ project_id, pr_number, per_page }, { portal }) {
      const r = await portal.listPRReviews(project_id, pr_number, { per_page });
      return JSON.stringify(r);
    }
  },

  {
    name: 'github_list_issues',
    roles: ['analyst', 'developer'],
    description: 'List issues on the project repo (excludes pull requests). Defaults to open issues sorted by recently updated. Use labels param to filter by label.',
    parameters: {
      type: 'object',
      required: ['project_id'],
      properties: {
        project_id: { type: 'integer' },
        state:      { type: 'string', enum: ['open', 'closed', 'all'] },
        labels:     { type: 'string', description: 'Comma-separated label names to filter by' },
        per_page:   { type: 'integer', description: 'default 50, max 100' }
      }
    },
    async execute({ project_id, state, labels, per_page }, { portal }) {
      const r = await portal.listIssues(project_id, { state, labels, per_page });
      return JSON.stringify(r);
    }
  },

  {
    name: 'github_get_issue',
    roles: ['analyst', 'developer'],
    description: 'Get full detail for a single GitHub issue: title, body, state, labels, assignees, milestone, and comment count. Returns 400 if the number is a PR.',
    parameters: {
      type: 'object',
      required: ['project_id', 'issue_number'],
      properties: {
        project_id:   { type: 'integer' },
        issue_number: { type: 'integer' }
      }
    },
    async execute({ project_id, issue_number }, { portal }) {
      const r = await portal.getIssue(project_id, issue_number);
      return JSON.stringify(r);
    }
  }
];
