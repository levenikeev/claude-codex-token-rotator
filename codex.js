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
function rotatorBlock(baseUrl) {
  return [
    `[model_providers.${PROVIDER_ID}]`,
    `name = "${PROVIDER_ID}"`,
    `base_url = "${baseUrl}"`,
    `env_key = "OPENAI_API_KEY"`,
    `requires_openai_auth = false`,
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

function writeConfig(baseUrl) {
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
  text += '\n\n' + rotatorBlock(baseUrl) + '\n';
  fs.writeFileSync(CONFIG, text);
  return text;
}

// Point Codex at the local proxy. Called once Codex has at least one provider.
function ensureProvider(port) {
  const local = `http://localhost:${port}`;
  writeConfig(local);
  console.log('[codex] model_provider=rotator base_url ->', local);
}

// Mirror the active token into auth.json so Codex sends it (the proxy rewrites it
// to whatever token actually serves, keeping this in sync on every rotation).
function syncActiveKey(key) {
  if (!key) return;
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
// it directly (with the last-good token in auth.json) instead of a dead
// localhost:port — the Codex analog of settings.restoreBaseUrl.
function restoreUpstream(realUrl) {
  if (!realUrl) return;
  try {
    writeConfig(realUrl);
    console.log('[codex] base_url restored ->', realUrl);
  } catch (_) {}
}

module.exports = { ensureProvider, syncActiveKey, restoreUpstream, CONFIG, AUTH };
