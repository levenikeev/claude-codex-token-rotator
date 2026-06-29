// Token store: single source of truth for the rotation pool.
// Imports the original tokens.txt once, then maintains tokens.json.
//
// Two dimensions structure the pool:
//   client   — which CLI the tokens drive: 'claude' or 'codex'. Each client has
//              its own active provider + active key and is rotated independently
//              (a Claude key must never serve a Codex request and vice-versa).
//   provider — a base URL + token pool *within* a client. Switching providers
//              stays inside the current client.
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const FILE = path.join(DIR, 'tokens.json');
const BAK = path.join(DIR, 'tokens.json.bak');
const TXT = path.join(DIR, 'tokens.txt');
const UPSTREAM_FILE = path.join(DIR, 'upstream.txt');

const ONE_HOUR = 60 * 60 * 1000;
const ERROR_COOLDOWN = 5 * 60 * 1000; // auto-recover error tokens after 5 min

const CLIENTS = ['claude', 'codex'];

// The original (pre-provider) pool was all freemodel Claude tokens. Migration
// tags every existing token/provider with the claude client so nothing breaks.
const DEFAULT_PROVIDER_ID = 'freemodel';
const DEFAULT_PROVIDER_URL = 'https://cc.freemodel.dev';

// state shape (tokens.json):
//   providers: [{ id, name, baseUrl, client }]    — provider scoped to a client
//   clients:   { claude: { activeProvider, activeId }, codex: { ... } }
//   tokens:    [{ id, key, account, provider, status, resetAt, lastError, ... }]
//              (a token's client is derived from its provider; identity is `id`,
//               NOT `key`, so the same key may appear in several provider pools)
let state = { providers: [], clients: { claude: { activeProvider: null, activeId: null }, codex: { activeProvider: null, activeId: null } }, tokens: [] };

// Strip trailing slashes so "https://x/" and "https://x" are the same upstream.
function normUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

// kebab-ish id from a display name, used when adding providers from the UI.
function slug(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'provider';
}

// Short unique token id (identity for activate/delete/rotate). Collision-checked
// against the current pool so duplicate keys still get distinct rows.
function uid() {
  let id;
  do { id = Math.random().toString(36).slice(2, 10); } while (state.tokens.some((t) => t.id === id));
  return id;
}

// ---- persistence -----------------------------------------------------------

function save() {
  try {
    if (fs.existsSync(FILE)) fs.copyFileSync(FILE, BAK); // keep last good copy
  } catch (_) {}
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

function load() {
  if (fs.existsSync(FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (e) {
      console.error('[store] tokens.json corrupted, restoring backup:', e.message);
      if (fs.existsSync(BAK)) state = JSON.parse(fs.readFileSync(BAK, 'utf8'));
    }
  } else if (fs.existsSync(TXT)) {
    importTxt();
  }
  if (!Array.isArray(state.tokens)) state.tokens = [];
  migrate();
  recover();
  for (const c of CLIENTS) ensureActive(c);
  save();
}

// ---- client model helpers --------------------------------------------------

function clientState(client) {
  if (!state.clients[client]) state.clients[client] = { activeProvider: null, activeId: null };
  return state.clients[client];
}

// Resolve a client's active token id to its key (for mirroring into CLI config).
function activeKey(client) {
  const t = state.tokens.find((x) => x.id === clientState(client).activeId);
  return t ? t.key : null;
}

// Which client does a provider id belong to? (defaults to claude for safety).
function providerClient(pid) {
  const p = state.providers.find((x) => x.id === pid);
  return p ? p.client || 'claude' : 'claude';
}

function providersFor(client) {
  return state.providers.filter((p) => (p.client || 'claude') === client);
}

function clientProviderCount(client) {
  return providersFor(client).length;
}

// ---- provider migration / model -------------------------------------------
// Backfills the client+provider model onto pre-client data so upgrades are
// seamless: every existing provider/token becomes 'claude', the old top-level
// activeProvider/activeKey move into clients.claude, and an empty codex client
// is seeded (the user opts into Codex by adding a provider from the dashboard).
function migrate() {
  if (!Array.isArray(state.providers)) state.providers = [];

  // Tag any provider missing a client as claude (pre-client data).
  for (const p of state.providers) if (!p.client) p.client = 'claude';

  // Seed a single claude provider if none exists (base URL from upstream.txt so
  // the user's current working upstream is preserved).
  if (providersFor('claude').length === 0) {
    let seedUrl = DEFAULT_PROVIDER_URL;
    try {
      if (fs.existsSync(UPSTREAM_FILE)) {
        seedUrl = normUrl(fs.readFileSync(UPSTREAM_FILE, 'utf8')) || DEFAULT_PROVIDER_URL;
      }
    } catch (_) {}
    state.providers.push({ id: DEFAULT_PROVIDER_ID, name: 'freemodel', baseUrl: normUrl(seedUrl), client: 'claude' });
  }

  // Build the clients structure, migrating legacy top-level active* into claude.
  if (!state.clients || typeof state.clients !== 'object') state.clients = {};
  if (!state.clients.claude) {
    state.clients.claude = { activeProvider: state.activeProvider || null, activeKey: state.activeKey || null };
  }
  if (!state.clients.codex) state.clients.codex = { activeProvider: null, activeKey: null };
  delete state.activeProvider; // drop legacy top-level fields
  delete state.activeKey;

  // Make sure each client's activeProvider actually belongs to that client.
  for (const c of CLIENTS) {
    const cs = clientState(c);
    const provs = providersFor(c);
    if (!provs.some((p) => p.id === cs.activeProvider)) {
      cs.activeProvider = (provs[0] || {}).id || null;
    }
  }

  // Orphan tokens (unknown/missing provider) fall back to the first claude provider.
  const known = new Set(state.providers.map((p) => p.id));
  const fallback = (providersFor('claude')[0] || state.providers[0] || {}).id || null;
  for (const t of state.tokens) {
    if (!t.provider || !known.has(t.provider)) t.provider = fallback;
  }

  // Give every token a stable unique id (identity for activate/delete/rotate),
  // so the same key can live in several provider/client pools.
  for (const t of state.tokens) if (!t.id) t.id = uid();

  // Migrate each client's legacy activeKey -> activeId (first matching token).
  for (const c of CLIENTS) {
    const cs = clientState(c);
    if (cs.activeId === undefined) {
      const match = state.tokens.find((t) => t.key === cs.activeKey);
      cs.activeId = match ? match.id : null;
    }
    delete cs.activeKey;
  }
}

// Base URL the proxy should forward to for this client right now.
function activeUpstream(client) {
  const cs = clientState(client);
  const p = state.providers.find((x) => x.id === cs.activeProvider);
  return p ? p.baseUrl : (client === 'claude' ? DEFAULT_PROVIDER_URL : '');
}

function tokensForActive(client) {
  const ap = clientState(client).activeProvider;
  return state.tokens.filter((t) => t.provider === ap);
}

// ---- tokens.txt import -----------------------------------------------------
// Format per line:  <key> - <account> <DD.MM.YYYY> <H:MM:SS>
//                or <key> - <account> -          (no active limit)

function parseRu(dateStr, timeStr) {
  const [dd, mm, yyyy] = String(dateStr).split('.').map(Number);
  const [h, mi, s] = String(timeStr).split(':').map(Number);
  if (!dd || !mm || !yyyy) return null;
  return new Date(yyyy, mm - 1, dd, h || 0, mi || 0, s || 0);
}

function importTxt() {
  const lines = fs.readFileSync(TXT, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const sep = line.indexOf(' - ');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const rest = line.slice(sep + 3).trim().split(/\s+/);
    const account = rest[0] || '';
    let status = 'available';
    let resetAt = null;
    if (rest[1] && rest[1] !== '-') {
      const d = parseRu(rest[1], rest[2] || '0:0:0');
      if (d && d.getTime() > Date.now()) {
        status = 'exhausted';
        resetAt = d.toISOString();
      }
    }
    // provider is filled in by migrate() (first claude provider).
    state.tokens.push({ key, account, provider: null, status, resetAt, lastError: null, addedAt: new Date().toISOString() });
  }
}

// ---- recovery / selection --------------------------------------------------

// Flip exhausted tokens back to available once their reset time has passed.
// Also re-enable error tokens (auth/network glitches) after a cooldown so
// they get tried again instead of staying dead until manual reset.
function recover() {
  const now = Date.now();
  let changed = false;
  for (const t of state.tokens) {
    if (t.status === 'exhausted' && t.resetAt && new Date(t.resetAt).getTime() <= now) {
      console.log(`[store] token recovered: ${t.account || t.key.slice(0, 12)}... -> available`);
      t.status = 'available';
      t.resetAt = null;
      t.lastError = null;
      changed = true;
    }
    if (t.status === 'error') {
      // Older records (or ones errored before lastErrorAt existed) have no
      // timestamp -> stamp one now so they get a cooldown instead of being
      // stuck in 'error' forever.
      if (!t.lastErrorAt) t.lastErrorAt = new Date(now - ERROR_COOLDOWN).toISOString();
      const elapsed = now - new Date(t.lastErrorAt).getTime();
      if (elapsed >= ERROR_COOLDOWN) {
        console.log(`[store] error cooldown elapsed (${Math.round(elapsed/1000)}s): ${t.account || t.key.slice(0, 12)}... -> retrying`);
        t.status = 'available';
        t.lastError = null;
        t.lastErrorAt = null;
        changed = true;
      }
    }
  }
  return changed;
}

// Usable means available AND belonging to this client's active provider —
// rotation never crosses providers or clients.
function isUsable(t, client) {
  const cs = clientState(client);
  return t.status === 'available' && t.provider === cs.activeProvider;
}

function firstAvailable(client) {
  return state.tokens.find((t) => isUsable(t, client)) || null;
}

function ensureActive(client) {
  const cs = clientState(client);
  const active = state.tokens.find((t) => t.id === cs.activeId);
  if (!active || !isUsable(active, client)) {
    const next = firstAvailable(client);
    cs.activeId = next ? next.id : null;
  }
}

// Returns the token that this client's proxy requests should use now (or null).
function selectActive(client) {
  const cs = clientState(client);
  const prev = cs.activeId;
  recover();
  ensureActive(client);
  if (cs.activeId !== prev) save();
  return state.tokens.find((t) => t.id === cs.activeId) || null;
}

// ---- mutations -------------------------------------------------------------

function markExhausted(id, resetDate) {
  const t = state.tokens.find((x) => x.id === id);
  if (!t) return;
  t.status = 'exhausted';
  // Clamp absurdly long reset times (some upstreams send retry-after: 86400 for soft 429).
  const d = resetDate instanceof Date ? resetDate : new Date(Date.now() + ONE_HOUR);
  const maxReset = Date.now() + 24 * ONE_HOUR;
  t.resetAt = (d.getTime() > maxReset ? new Date(maxReset) : d).toISOString();
  t.lastError = 'rate limit';
  t.lastErrorAt = null;
  const c = providerClient(t.provider);
  if (clientState(c).activeId === id) ensureActive(c);
  save();
}

function markError(id, message) {
  const t = state.tokens.find((x) => x.id === id);
  if (!t) return;
  t.status = 'error';
  t.lastError = message;
  t.lastErrorAt = new Date().toISOString();
  const c = providerClient(t.provider);
  if (clientState(c).activeId === id) ensureActive(c);
  save();
}

function addToken(key, account, client) {
  key = (key || '').trim();
  if (!key) return { ok: false, error: 'empty key' };
  client = CLIENTS.includes(client) ? client : 'claude';
  // Add to the client's active provider (so "Add key" targets whatever provider
  // you're currently looking at within the selected client). Duplicate keys are
  // allowed — each row gets its own id, so the same key can live in many pools.
  const pid = clientState(client).activeProvider;
  if (!pid) return { ok: false, error: 'no provider for ' + client + ' — add a provider first' };
  state.tokens.push({
    id: uid(),
    key,
    account: (account || '').trim(),
    provider: pid,
    status: 'available',
    resetAt: null,
    lastError: null,
    addedAt: new Date().toISOString(),
  });
  ensureActive(client);
  save();
  return { ok: true };
}

function deleteToken(id) {
  const t = state.tokens.find((x) => x.id === id);
  const c = t ? providerClient(t.provider) : null;
  const before = state.tokens.length;
  state.tokens = state.tokens.filter((x) => x.id !== id);
  if (c && clientState(c).activeId === id) ensureActive(c);
  save();
  return { ok: state.tokens.length < before };
}

function activate(client, id) {
  const t = state.tokens.find((x) => x.id === id);
  if (!t) return { ok: false, error: 'not found' };
  client = CLIENTS.includes(client) ? client : providerClient(t.provider);
  if (!isUsable(t, client)) {
    t.status = 'available'; // manual activation force-clears limit
    t.resetAt = null;
    t.lastError = null;
    t.lastErrorAt = null;
  }
  clientState(client).activeId = id;
  save();
  return { ok: true };
}

function resetStatus(id) {
  const t = state.tokens.find((x) => x.id === id);
  if (!t) return { ok: false };
  t.status = 'available';
  t.resetAt = null;
  t.lastError = null;
  t.lastErrorAt = null;
  save();
  return { ok: true };
}

// ---- provider mutations ----------------------------------------------------

function addProvider(name, baseUrl, client) {
  baseUrl = normUrl(baseUrl);
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return { ok: false, error: 'baseUrl must start with http(s)://' };
  client = CLIENTS.includes(client) ? client : 'claude';
  let id = slug(name || baseUrl);
  // de-dup id so two providers named the same don't collide
  if (state.providers.some((p) => p.id === id)) {
    let n = 2;
    while (state.providers.some((p) => p.id === id + '-' + n)) n++;
    id = id + '-' + n;
  }
  state.providers.push({ id, name: (name || id).trim(), baseUrl, client });
  // First provider for a client becomes its active provider automatically.
  const cs = clientState(client);
  if (!cs.activeProvider) cs.activeProvider = id;
  save();
  return { ok: true, id };
}

function deleteProvider(id) {
  const c = providerClient(id);
  const provider = state.providers.find((p) => p.id === id);
  if (!provider) return { ok: false, error: 'not found' };
  // Keep claude always functional — never let it reach zero providers.
  if (c === 'claude' && providersFor('claude').length <= 1) {
    return { ok: false, error: 'cannot delete the last claude provider' };
  }
  state.providers = state.providers.filter((p) => p.id !== id);
  // Orphaned tokens go with their provider — keep the pool tidy.
  state.tokens = state.tokens.filter((t) => t.provider !== id);
  const cs = clientState(c);
  if (cs.activeProvider === id) {
    cs.activeProvider = (providersFor(c)[0] || {}).id || null;
    ensureActive(c);
  }
  save();
  return { ok: true, client: c, activeProvider: cs.activeProvider, empty: providersFor(c).length === 0, removedBaseUrl: provider.baseUrl };
}

// Switch which provider rotation is scoped to within a client. Recomputes the
// client's active token; the caller mirrors that key into the client's config.
function setActiveProvider(client, id) {
  client = CLIENTS.includes(client) ? client : providerClient(id);
  const provider = state.providers.find((p) => p.id === id && (p.client || 'claude') === client);
  if (!provider) return { ok: false, error: 'not found' };
  const cs = clientState(client);
  cs.activeProvider = id;
  recover();
  ensureActive(client);
  save();
  return { ok: true, client, baseUrl: provider.baseUrl, activeId: cs.activeId };
}

// ---- snapshot / counts -----------------------------------------------------

function snapshot() {
  recover();
  const clients = {};
  for (const c of CLIENTS) {
    const cs = clientState(c);
    clients[c] = { activeProvider: cs.activeProvider, activeId: cs.activeId, baseUrl: activeUpstream(c) };
  }
  return {
    tokens: state.tokens,
    providers: state.providers,
    clients,
    now: Date.now(),
  };
}

function count() {
  return state.tokens.length;
}

// Tokens belonging to a client's active provider — the rotation retry budget so
// a request only retries across tokens it can actually use.
function activeCount(client) {
  return tokensForActive(client).length;
}

module.exports = {
  CLIENTS, load, save, selectActive, markExhausted, markError,
  addToken, deleteToken, activate, resetStatus, snapshot, count, activeCount,
  addProvider, deleteProvider, setActiveProvider, activeUpstream,
  activeKey, clientProviderCount, providerClient,
};
