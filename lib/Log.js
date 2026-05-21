"use strict";

const PREFIX = '[agent]';

// Patterns to redact from log output. The first line is the format the
// portal currently mints; the rest are common provider key shapes that
// might leak through tool output or HTTP error responses.
const REDACT_PATTERNS = [
  { pattern: /rwsk_[A-Za-z0-9_\-]+/g, replacement: 'rwsk_***' },
  { pattern: /sk-ant-[a-zA-Z0-9-]+/g, replacement: 'sk-ant-***' },
  { pattern: /sk-[a-zA-Z0-9]{20,}/g, replacement: 'sk-***' },
  { pattern: /(api[_-]?key|token|secret|password|authorization)['":\s=]+\S+/gi, replacement: '$1=***' }
];

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function sanitize(args) {
  return args.map((arg) => {
    if (typeof arg !== 'string') return arg;
    let cleaned = arg;
    for (const { pattern, replacement } of REDACT_PATTERNS) {
      cleaned = cleaned.replace(pattern, replacement);
    }
    return cleaned;
  });
}

module.exports = {
  info:  (...a) => console.log(  `${ts()} ${PREFIX}`,       ...sanitize(a)),
  warn:  (...a) => console.warn( `${ts()} ${PREFIX} WARN`,  ...sanitize(a)),
  error: (...a) => console.error(`${ts()} ${PREFIX} ERROR`, ...sanitize(a)),
  debug: (...a) => {
    if (process.env.DEBUG) console.log(`${ts()} ${PREFIX} DEBUG`, ...sanitize(a));
  }
};
