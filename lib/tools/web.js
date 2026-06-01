"use strict";

// Web tools — search the web and fetch pages. Available to all three
// roles (analyst, developer, devops) when the PM has enabled web_access
// for the agent via the project Team tab.
//
// web_search uses DuckDuckGo HTML search (no API key required).
// web_fetch does a plain HTTP GET and strips HTML to readable text.

const log = require('../Log');

const MAX_FETCH_BYTES = 100 * 1024;
const SEARCH_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 30_000;

function getWebAccess(context) {
  const cfg = context.developer_config
    || context.analyst_config
    || context.devops_config;
  return !!(cfg && cfg.web_access);
}

function stripHtml(html) {
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;/gi, ' ');
  text = text.replace(/&amp;/gi, '&');
  text = text.replace(/&lt;/gi, '<');
  text = text.replace(/&gt;/gi, '>');
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#39;/gi, "'");
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n/g, '\n\n');
  return text.trim();
}

function parseDDGResults(html) {
  const results = [];
  const linkPattern = /<a[^>]+class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

  const links = [];
  let m;
  while ((m = linkPattern.exec(html)) !== null) {
    links.push({ url: m[1], title: m[2].replace(/<[^>]+>/g, '').trim() });
  }
  const snippets = [];
  while ((m = snippetPattern.exec(html)) !== null) {
    snippets.push(m[1].replace(/<[^>]+>/g, '').trim());
  }

  for (let i = 0; i < links.length; i++) {
    if (!links[i].url || links[i].url.startsWith('/')) continue;
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] || ''
    });
  }
  return results;
}

module.exports = [
  {
    name: 'web_search',
    roles: ['analyst', 'developer', 'devops'],
    description: 'Search the web for a query. Returns top results with title, URL, and snippet. Requires web_access to be enabled by the PM. Use for looking up API documentation, error messages, library references, best practices, or current information.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query:       { type: 'string', description: 'Search query.' },
        max_results: { type: 'integer', description: 'Max results to return. Default 10, max 20.' }
      }
    },
    async execute({ query, max_results }, context) {
      if (!getWebAccess(context)) {
        throw new Error('web access not enabled — ask the PM to enable it via the project Team tab');
      }
      if (!query || typeof query !== 'string' || !query.trim()) {
        throw new Error('query is required');
      }
      const maxResults = Math.min(Math.max(parseInt(max_results, 10) || 10, 1), 20);

      const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query.trim())}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; RushworksAgent/1.0)',
          'Accept': 'text/html'
        },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
      });
      if (!res.ok) {
        throw new Error(`search failed: HTTP ${res.status}`);
      }
      const html = await res.text();
      const results = parseDDGResults(html).slice(0, maxResults);

      log.info({ query: query.trim(), resultCount: results.length }, 'web_search');
      return JSON.stringify({ query: query.trim(), results, count: results.length });
    }
  },

  {
    name: 'web_fetch',
    roles: ['analyst', 'developer', 'devops'],
    description: 'Fetch a web page by URL and return its readable text content (HTML stripped). Requires web_access to be enabled by the PM. Capped at 100KB of text. Use when you know the specific URL you need.',
    parameters: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'The URL to fetch.' }
      }
    },
    async execute({ url: targetUrl }, context) {
      if (!getWebAccess(context)) {
        throw new Error('web access not enabled — ask the PM to enable it via the project Team tab');
      }
      if (!targetUrl || typeof targetUrl !== 'string') {
        throw new Error('url is required');
      }
      const trimmed = targetUrl.trim();
      if (!/^https?:\/\//i.test(trimmed)) {
        throw new Error('url must start with http:// or https://');
      }

      const res = await fetch(trimmed, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; RushworksAgent/1.0)',
          'Accept': 'text/html, application/json, text/plain'
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow'
      });
      if (!res.ok) {
        throw new Error(`fetch failed: HTTP ${res.status} ${res.statusText}`);
      }

      const ct = res.headers.get('content-type') || '';
      const raw = await res.text();
      const isHtml = ct.includes('text/html');
      const content = isHtml ? stripHtml(raw) : raw;
      const truncated = content.length > MAX_FETCH_BYTES;
      const output = truncated ? content.slice(0, MAX_FETCH_BYTES) : content;

      log.info({ url: trimmed, bytes: output.length, truncated }, 'web_fetch');
      return JSON.stringify({
        url: trimmed,
        content_type: ct.split(';')[0].trim(),
        content: output,
        bytes: output.length,
        truncated
      });
    }
  }
];
