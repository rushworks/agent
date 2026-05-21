"use strict";

// Project documents tools. Both roles can READ docs (developers ground
// their work in the analyst's pre-staged context); only analysts WRITE
// docs. Server enforces the role gate on write — these tool definitions
// match it so the LLM doesn't waste an iter trying.

module.exports = [
  {
    name: 'portal_list_documents',
    roles: ['analyst', 'developer'],
    description: "List all project documents (title + slug + source + audit metadata). Source = 'human' or 'agent'. Use this to discover what context docs exist before reading individual ones.",
    parameters: {
      type: 'object',
      required: ['project_id'],
      properties: { project_id: { type: 'integer' } }
    },
    async execute({ project_id }, { portal }) {
      const r = await portal.listDocuments(project_id);
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_read_document',
    roles: ['analyst', 'developer'],
    description: 'Read the full markdown body of a project document by its slug. Use after portal_list_documents to grab context for the task at hand.',
    parameters: {
      type: 'object',
      required: ['project_id', 'slug'],
      properties: {
        project_id: { type: 'integer' },
        slug:       { type: 'string', description: 'URL-safe identifier from portal_list_documents.' }
      }
    },
    async execute({ project_id, slug }, { portal }) {
      const r = await portal.readDocument(project_id, slug);
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_create_document',
    roles: ['analyst'],
    description: "Create a new project document. Use for things like codebase_background, architecture overviews, customer briefs, onboarding notes — long-form context that a developer agent can pull from before working a task. The slug is derived from the title if omitted; provide one explicitly if you want a specific URL identifier (e.g. 'codebase-background'). IMPORTANT: include the FULL markdown body in this single call — do NOT create an empty doc and then try to populate it via update. Keep bodies focused (a few thousand characters max); if a topic genuinely needs more, split into multiple linked docs.",
    parameters: {
      type: 'object',
      required: ['project_id', 'title', 'body'],
      properties: {
        project_id: { type: 'integer' },
        title:      { type: 'string', description: 'Human-readable title (≤200 chars).' },
        slug:       { type: 'string', description: "URL-safe identifier. Lowercase, hyphens. Defaults to title-derived." },
        body:       { type: 'string', description: 'Full markdown body. Required — pass the complete document content here in this one call.' }
      }
    },
    async execute({ project_id, title, slug, body }, { portal }) {
      const r = await portal.createDocument(project_id, { title, slug, body });
      return JSON.stringify(r);
    }
  },

  {
    name: 'portal_update_document',
    roles: ['analyst'],
    description: "Update an existing AGENT-sourced project document. Pass any subset of {title, body}. You cannot modify human-authored docs via the agent API — those are read-only on this surface.",
    parameters: {
      type: 'object',
      required: ['project_id', 'slug'],
      properties: {
        project_id: { type: 'integer' },
        slug:       { type: 'string' },
        title:      { type: 'string' },
        body:       { type: 'string', description: 'Replaces the entire body (this is a PUT-style overwrite, not a patch).' }
      }
    },
    async execute({ project_id, slug, title, body }, { portal }) {
      const r = await portal.updateDocument(project_id, slug, { title, body });
      return JSON.stringify(r);
    }
  }
];
