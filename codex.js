// Keeps the Codex CLI's config in sync with the rotator — the Codex analog of
// settings.js (which does the same for Claude Code).
//
//   ~/.codex/config.toml : defines a [model_providers.rotator] table whose
//                          base_url points at our local proxy, and selects it
//                          via the root `model_provider` key.
//   ~/.codex/auth.json   : holds the active OPENAI_API_KEY (mirrored on rotation).
//
// config.toml is edited surgically (line-based) rather than re-serialized: it
// contains Windows paths in single-quoted strings, arrays and nested tables a
// naive TOML round-trip would mangle. We only ever touch our own provider block
// and the one root selector line.
const fs = require('fs');
const path = require('path');

const HOME = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || 'C:/Users/a', '.codex');
const CONFIG = path.join(HOME, 'config.toml');
const AUTH = path.join(HOME, 'auth.json');
const CONFIG_BAK = CONFIG + '.rotator-bak';
const AUTH_BAK = AUTH + '.rotator-bak';

const PROVIDER_ID = 'rotator'; // our dedicated [model_providers.rotator] table

function backupOnce(file, bak) {
  try {
    if (!fs.existsSync(bak) && fs.existsSync(file)) {
      fs.copyFileSync(file, bak);
      console.log('[codex] backup written ->', bak);
    }
  } catch (_) {}
}

// The provider table we own. Regenerated wholesale every time so a partial edit
// can never leave it half-written.
//
// We embed the key inline via `experimental_bearer_token` instead of `env_key`:
// Codex's env_key points at an OS environment variable (which would have to be
// set + the terminal restarted), whereas the bearer token lives right in the
// config. Our proxy overwrites the Authorization header with the live rotated
// token anyway, so this value only needs to be a valid fallback key.
function rotatorBlock(baseUrl, key) {
  return [
    `[model_providers.${PROVIDER_ID}]`,
    `name = "${PROVIDER_ID}"`,
    `base_url = "${baseUrl}"`,
    `wire_api = "responses"`,
    `experimental_bearer_token = "${key || ''}"`,
  ].join('\n');
}

// Drop our [model_providers.rotator] table (header until the next table / EOF).
function stripRotatorBlock(lines) {
  const start = lines.findIndex((l) => l.trim() === `[model_providers.${PROVIDER_ID}]`);
  if (start === -1) return lines;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  // also swallow one trailing blank separator line, if any
  if (lines[end - 1] !== undefined && lines[end - 1].trim() === '') end--;
  lines.splice(start, end - start);
  return lines;
}

// Ensure root key `model_provider = "rotator"`. Root keys must precede the first
// [table], so we only search/insert in the pre-table region.
function ensureRootSelector(lines) {
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const limit = firstTable === -1 ? lines.length : firstTable;
  for (let i = 0; i < limit; i++) {
    if (/^\s*model_provider\s*=/.test(lines[i])) {
      lines[i] = `model_provider = "${PROVIDER_ID}"`;
      return lines;
    }
  }
  lines.splice(0, 0, `model_provider = "${PROVIDER_ID}"`);
  return lines;
}

function writeConfig(baseUrl, key) {
  backupOnce(CONFIG, CONFIG_BAK);
  let lines;
  try {
    lines = fs.readFileSync(CONFIG, 'utf8').split('\n');
  } catch (_) {
    lines = []; // config.toml missing -> create a minimal one
  }
  lines = stripRotatorBlock(lines);
  lines = ensureRootSelector(lines);
  let text = lines.join('\n').replace(/\s+$/, '');
  text += '\n\n' + rotatorBlock(baseUrl, key) + '\n';
  fs.writeFileSync(CONFIG, text);
  return text;
}

// Point Codex at the local proxy. Called once Codex has at least one provider.
function ensureProvider(port, key) {
  const local = `http://localhost:${port}`;
  writeConfig(local, key);
  console.log('[codex] model_provider=rotator base_url ->', local);
}

// Update the inline bearer token in our config block to the active key (the auth
// Codex actually uses). Idempotent: only rewrites when the token changed, so the
// per-request proxy hook can call this freely. Also mirrors auth.json as a
// harmless fallback for the built-in openai provider.
function syncActiveKey(key) {
  if (!key) return;
  try {
    const lines = fs.readFileSync(CONFIG, 'utf8').split('\n');
    const start = lines.findIndex((l) => l.trim() === `[model_providers.${PROVIDER_ID}]`);
    if (start !== -1) {
      let end = start + 1;
      while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
      let found = false, changed = false;
      const desired = `experimental_bearer_token = "${key}"`;
      for (let i = start + 1; i < end; i++) {
        if (/^\s*experimental_bearer_token\s*=/.test(lines[i])) {
          found = true;
          if (lines[i] !== desired) { lines[i] = desired; changed = true; }
        }
      }
      if (!found) { lines.splice(end, 0, desired); changed = true; }
      if (changed) { backupOnce(CONFIG, CONFIG_BAK); fs.writeFileSync(CONFIG, lines.join('\n')); }
    }
  } catch (_) {}
  backupOnce(AUTH, AUTH_BAK);
  let auth = {};
  try { auth = JSON.parse(fs.readFileSync(AUTH, 'utf8')); } catch (_) {}
  if (auth.auth_mode !== 'apikey' || auth.OPENAI_API_KEY !== key) {
    auth.auth_mode = 'apikey';
    auth.OPENAI_API_KEY = key;
    fs.writeFileSync(AUTH, JSON.stringify(auth, null, 2));
  }
}

// On shutdown, repoint our provider block at the real upstream so Codex talks to
// it directly (with the last-good token inline) instead of a dead localhost:port
// — the Codex analog of settings.restoreBaseUrl.
function restoreUpstream(realUrl, key) {
  if (!realUrl) return;
  try {
    writeConfig(realUrl, key);
    console.log('[codex] base_url restored ->', realUrl);
  } catch (_) {}
}

module.exports = { ensureProvider, syncActiveKey, restoreUpstream, CONFIG, AUTH };
