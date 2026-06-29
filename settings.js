// Keeps Claude Code's settings.json in sync with the rotator.
// - points ANTHROPIC_BASE_URL at the local proxy (once),
// - mirrors the active token into ANTHROPIC_API_KEY on every switch.
const fs = require('fs');
const path = require('path');

const SETTINGS = path.join(process.env.USERPROFILE || 'C:/Users/a', '.claude', 'settings.json');
const BAK = SETTINGS + '.rotator-bak';

function read() {
  return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
}

function write(obj) {
  fs.writeFileSync(SETTINGS, JSON.stringify(obj, null, 2));
}

function backupOnce() {
  if (!fs.existsSync(BAK) && fs.existsSync(SETTINGS)) {
    fs.copyFileSync(SETTINGS, BAK);
    console.log('[settings] backup written ->', BAK);
  }
}

// Point Claude at the proxy. Returns the previous base url so we know the upstream.
function ensureBaseUrl(port) {
  backupOnce();
  const s = read();
  s.env = s.env || {};
  const prev = s.env.ANTHROPIC_BASE_URL;
  const local = `http://localhost:${port}`;
  if (prev !== local) {
    s.env.ANTHROPIC_BASE_URL = local;
    write(s);
    console.log('[settings] ANTHROPIC_BASE_URL ->', local, '(was', prev + ')');
  }
  return prev;
}

// Restore the direct upstream base url (called on shutdown) so that when the
// rotator is NOT running, Claude Code talks to freemodel directly instead of a
// dead localhost:port. Without this, stopping the proxy bricks Claude.
function restoreBaseUrl(upstream) {
  if (!upstream) return;
  try {
    const s = read();
    s.env = s.env || {};
    if (s.env.ANTHROPIC_BASE_URL !== upstream) {
      s.env.ANTHROPIC_BASE_URL = upstream;
      write(s);
      console.log('[settings] ANTHROPIC_BASE_URL restored ->', upstream);
    }
  } catch (_) {}
}

function syncActiveKey(key) {
  if (!key) return;
  const s = read();
  s.env = s.env || {};
  if (s.env.ANTHROPIC_API_KEY !== key) {
    s.env.ANTHROPIC_API_KEY = key;
    write(s);
  }
}

module.exports = { ensureBaseUrl, restoreBaseUrl, syncActiveKey, SETTINGS };
