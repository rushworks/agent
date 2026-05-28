"use strict";

// Repo-browser tools. Read-only access to the project's GitHub repo via
// the portal (which uses the GitHub App installation token). Both
// analyst and developer roles get these — analysts use them to prep
// context docs; developers use them to ground their work in actual
// code without minting a git token unless they need to push.
//
// Repo write paths (open PR, mint git token) stay developer-only and
// live in tools/github.js.

module.exports = [
  {
    name: 'repo_get',
    roles: ['analyst', 'developer', 'devops'],
    description: "Read a path in the project's GitHub repo. The server resolves whether the path is a file or a directory and returns the matching shape. Response: { kind: 'dir', entries: [{name,type,path,size,sha}] } OR { kind: 'file', path, content, size, sha }. Use this for ANY repo read — files OR directories — instead of guessing wrong and retrying. Defaults to repo root when path is omitted.",
    parameters: {
      type: 'object',
      required: ['project_id'],
      properties: {
        project_id: { type: 'integer' },
        path:       { type: 'string', description: "Path relative to repo root. Omit or '' for root. May be a file or a directory — the server figures out which." },
        ref:        { type: 'string', description: 'Branch name, tag, or commit SHA. Defaults to repo default branch.' }
      }
    },
    async execute({ project_id, path, ref }, { portal }) {
      const r = await portal.repoGet(project_id, { path, ref });
      return JSON.stringify(r);
    }
  },

  {
    name: 'repo_search',
    roles: ['analyst', 'developer'],
    description: [
      "Search the project's GitHub repo for code via GitHub's code-search API. Returns matching file paths + URLs.",
      '',
      'Query syntax (GitHub code search, the `repo:owner/name` scope is appended automatically):',
      '- Plain keywords: `useState` or `class TaskWorker` — most common',
      '- Quoted exact phrase: `"function fetchTasks("` (escape quotes if the phrase contains them)',
      '- Path qualifier: `TODO path:src/`',
      '- Extension qualifier: `useSWR extension:tsx`',
      '- Language qualifier: `migrations language:sql`',
      '',
      'Avoid:',
      '- Leading dash on a token (e.g. `--no-cache`) — GitHub treats it as a NOT operator. Either drop the dash or wrap in quotes.',
      '- Embedding a full file path in the query body (use `path:` instead).',
      '- Multi-line strings or pipe characters.',
      '',
      'If a query fails with a parser error, simplify to a single keyword first; add qualifiers one at a time.'
    ].join('\n'),
    parameters: {
      type: 'object',
      required: ['project_id', 'q'],
      properties: {
        project_id: { type: 'integer' },
        q:          { type: 'string', description: "GitHub code-search query. See examples in tool description." },
        per_page:   { type: 'integer', description: 'Default 30, max 100.' }
      }
    },
    async execute({ project_id, q, per_page }, { portal }) {
      const r = await portal.repoSearch(project_id, { q, per_page });
      return JSON.stringify(r);
    }
  },

  {
    name: 'repo_log',
    roles: ['analyst', 'developer'],
    description: "Commit log for the project's GitHub repo. Optionally scope to a specific file path (history of that file) or branch. Useful for understanding why code is the way it is, or for summarizing recent activity in an area.",
    parameters: {
      type: 'object',
      required: ['project_id'],
      properties: {
        project_id: { type: 'integer' },
        branch:     { type: 'string', description: 'Branch name. Defaults to repo default branch.' },
        path:       { type: 'string', description: 'File or directory path to filter to. Optional.' },
        since:      { type: 'string', description: 'ISO 8601 timestamp; commits after this. Optional.' },
        until:      { type: 'string', description: 'ISO 8601 timestamp; commits before this. Optional.' },
        per_page:   { type: 'integer', description: 'Default 30, max 100.' }
      }
    },
    async execute({ project_id, branch, path, since, until, per_page }, { portal }) {
      const r = await portal.repoLog(project_id, { branch, path, since, until, per_page });
      return JSON.stringify(r);
    }
  }
];
