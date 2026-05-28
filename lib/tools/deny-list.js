"use strict";

const HARD_DENY_PATTERNS = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /\.(key|pem|p12|pfx|crt|cer)$/i,
  /(^|\/)id_rsa(\.|$)/,
  /(^|\/)id_ed25519(\.|$)/,
  /(^|\/)id_ecdsa(\.|$)/,
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /^\/etc\/shadow$/,
  /^\/etc\/sudoers(\.|$)/,
  /^\/etc\/passwd$/,
  /^\/root(\/|$)/
];

function hardDeny(absPath) {
  for (const pat of HARD_DENY_PATTERNS) {
    if (pat.test(absPath)) return true;
  }
  return false;
}

module.exports = { HARD_DENY_PATTERNS, hardDeny };
