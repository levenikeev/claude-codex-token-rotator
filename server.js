// token-rotator
// Local reverse proxy that injects the active token into every request, catches
// rate-limit (429/402) errors, rotates to the next free token and retries
// transparently. Serves a dashboard on the Claude port.
//
// Two clients are driven independently, each on its own port:
//   claude -> PORT       (also serves the dashboard + control API)
//   codex  -> CODEX_PORT (proxy only)
// The listening port decides which client a request belongs to, so Claude Code
// and Codex can both rotate at the same time without stepping on each other.
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const store = require('./store');
const settings = require('./settings');
const codex = require('./codex');

const PORT = Number(process.env.ROTATOR_PORT) || 8787;
const CODEX_PORT = Number(process.env.ROTATOR_CODEX_PORT) || (PORT + 1);
const UPSTREAM_FILE = path.join(__dirname, 'upstream.txt');
const ONE_HOUR = 60 * 60 * 1000;

store.load();

// Per-client wiring: the proxy port and the config-writer that mirrors the
// active token into that client's CLI (settings.json for Claude, ~/.codex for
// Codex). syncKey keeps the on-disk key matching whatever token actually served,
// so stopping the rotator leaves each CLI with a working key.
const CLIENTS = {
  claude: { port: PORT, syncKey: settings.syncActiveKey },
  codex: { port: CODEX_PORT, syncKey: codex.syncActiveKey },
};

// Point Claude Code at the proxy (localhost). Provider-agnostic: all Claude
// traffic goes through us regardless of which provider is active.
settings.ensureBaseUrl(PORT);
// Only hijack ~/.codex once the user has opted into Codex by adding a provider.
if (store.clientProviderCount('codex') > 0) {
  codex.ensureProvider(CODEX_PORT, store.activeKey('codex'));
  codex.syncActiveKey(store.activeKey('codex'));
}
// Mirror the active Claude upstream for human reference / safe restore.
try { fs.writeFileSync(UPSTREAM_FILE, store.activeUpstream('claude')); } catch (_) {}
console.log('[rotator] claude upstream =', store.activeUpstream('claude'));
console.log('[rotator] codex upstream  =', store.activeUpstream('codex') || '(none)');

// Re-sync a client's CLI config after a dashboard mutation changed its active
// token/provider. Codex stays untouched until it actually has a provider.
function syncClientConfig(client) {
  if (client === 'codex') {
    if (store.clientProviderCount('codex') > 0) {
      codex.ensureProvider(CODEX_PORT, store.activeKey('codex'));
      codex.syncActiveKey(store.activeKey('codex'));
    }
  } else {
    settings.syncActiveKey(store.activeKey('claude'));
  }
}

// ---- helpers ---------------------------------------------------------------

function log(...a) {
  console.log(new Date().toLocaleTimeString(), ...a);
}

// True once the client response can no longer be written to — the guard that
// stops a mid-stream upstream reset + retry from crashing the process with
// ERR_HTTP_HEADERS_SENT (which would take BOTH clients down).
function sent(res) {
  return res.headersSent || res.writableEnded || res.destroyed;
}

// Append the raw limit response to rotations.log so we can verify the format.
function logLimit(account, code, text, reset, parsed) {
  const line =
    `${new Date().toISOString()} | ${account} | HTTP ${code} | parsed=${parsed} | ` +
    `reset=${reset.toISOString()} | body=${String(text).replace(/\s+/g, ' ').slice(0, 400)}\n`;
  try { fs.appendFileSync(path.join(__dirname, 'rotations.log'), line); } catch (_) {}
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

function json(res, code, obj) {
  if (sent(res)) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Decompress an error body for inspection (gzip/br/deflate), else plain utf8.
function decode(buf, enc) {
  try {
    if (enc === 'gzip') return zlib.gunzipSync(buf).toString('utf8');
    if (enc === 'br') return zlib.brotliDecompressSync(buf).toString('utf8');
    if (enc === 'deflate') return zlib.inflateSync(buf).toString('utf8');
  } catch (_) {}
  return buf.toString('utf8');
}

// Does this error body mean "this token hit its limit"?
function isLimitText(text) {
  return /usage limit|limit reached|rate.?limit|too many requests|quota|insufficient|exhausted/i.test(text);
}

// Normalise "7:06 PM" / "7:06PM" / "19:06" -> 24h {hh, mm}. Returns null if unparseable.
function parseClock(hhStr, mmStr, apStr) {
  let hh = +hhStr;
  if (!Number.isFinite(hh) || hh < 0 || hh > 23) return null;
  const mm = +mmStr;
  if (!Number.isFinite(mm) || mm < 0 || mm > 59) return null;
  const ap = (apStr || '').toLowerCase();
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  if (hh > 23) return null;
  return { hh, mm };
}

// Convert (year, month, day, hh, mm) in a UTC±offset zone -> UTC Date.
function zonedToUtc(y, mo, d, hh, mm, offMin) {
  const utc = Date.UTC(y, mo, d, hh, mm) - offMin * 60 * 1000;
  if (utc < Date.now() - 60000) return new Date(utc + 86400000);
  return new Date(utc);
}

// Today's date components in the given UTC offset (for "today at HH:MM (UTC+8)").
function dateInOffset(offMin, dayOffset = 0) {
  const tzMs = Date.now() + offMin * 60 * 1000;
  const z = new Date(tzMs);
  return { y: z.getUTCFullYear(), mo: z.getUTCMonth(), d: z.getUTCDate() + dayOffset };
}

// Parse a reset time out of the limit message (freemodel-style). Returns a Date,
// or null if nothing recognized.
function parseResetFromBody(text) {
  // 1) "today at HH:MM [AM/PM]" / "tomorrow ..." with optional (UTC±N[:MM])
  let m = text.match(
    /\b(today|tomorrow)\s*,?\s*at\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?\s*(?:\(\s*(?:UTC|GMT)\s*([+-]\d{1,2})(?::?(\d{2}))?\s*\))?/i
  );
  if (m) {
    const clk = parseClock(m[2], m[3], m[4]);
    if (clk) {
      const dayOffset = m[1].toLowerCase() === 'tomorrow' ? 1 : 0;
      if (m[5] !== undefined) {
        const offH = +m[5];
        const offM = m[6] ? +m[6] : 0;
        const offMin = offH * 60 + (offH < 0 ? -offM : offM);
        const { y, mo, d } = dateInOffset(offMin, dayOffset);
        return zonedToUtc(y, mo, d, clk.hh, clk.mm, offMin);
      }
      const offMin = 8 * 60; // No tz -> assume UTC+8 (freemodel default).
      const { y, mo, d } = dateInOffset(offMin, dayOffset);
      return zonedToUtc(y, mo, d, clk.hh, clk.mm, offMin);
    }
  }

  // 2) absolute date "Jun 24 [2026,] at HH:MM [AM/PM] [(UTC±N)]"
  m = text.match(
    /\breset(?:s)?(?:\s+on)?\s+([A-Za-z]{3,})\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:\s+at)?\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?(?:\s*\(\s*(?:UTC|GMT)\s*([+-]\d{1,2})(?::?(\d{2}))?\s*\))?/i
  );
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon !== undefined) {
      const clk = parseClock(m[4], m[5], m[6]);
      if (clk) {
        const day = +m[2];
        const hasYear = !!m[3];
        const year = hasYear ? +m[3] : new Date().getFullYear();
        if (m[7] !== undefined) {
          const offH = +m[7];
          const offM = m[8] ? +m[8] : 0;
          const offMin = offH * 60 + (offH < 0 ? -offM : offM);
          let utc = Date.UTC(year, mon, day, clk.hh, clk.mm) - offMin * 60 * 1000;
          if (!hasYear && utc < Date.now() - 60000) utc = Date.UTC(year + 1, mon, day, clk.hh, clk.mm) - offMin * 60 * 1000;
          return new Date(utc);
        }
        const offMin = 8 * 60; // No tz -> assume UTC+8.
        let utc = Date.UTC(year, mon, day, clk.hh, clk.mm) - offMin * 60 * 1000;
        if (!hasYear && utc < Date.now() - 60000) utc = Date.UTC(year + 1, mon, day, clk.hh, clk.mm) - offMin * 60 * 1000;
        return new Date(utc);
      }
    }
  }

  // 3) relative duration "in 3 hours 12 minutes" / "in 3h 12m" / "in 45m" / "in 2h"
  m = text.match(/\breset(?:s|ting)?\s+in\s+((?:\d+\s*[hm](?:ours?|rs?|in(?:utes?)?)?\s*)+)/i);
  if (m) {
    const parts = m[1].toLowerCase().match(/(\d+)\s*([hm])/g) || [];
    let totalMin = 0;
    for (const p of parts) {
      const [, n, u] = p.match(/(\d+)\s*([hm])/) || [];
      if (!n) continue;
      totalMin += u === 'h' ? +n * 60 : +n;
    }
    if (totalMin > 0) return new Date(Date.now() + totalMin * 60 * 1000);
  }

  return null;
}

// Derive reset time from upstream headers. Capped to 12h because a generic
// retry-after sometimes overshoots the real usage-limit reset by hours.
function parseReset(headers) {
  const MAX_FALLBACK = 12 * ONE_HOUR;
  const retry = headers['retry-after'];
  if (retry && /^\d+$/.test(String(retry).trim())) {
    const sec = Math.min(Number(retry), MAX_FALLBACK / 1000);
    return new Date(Date.now() + sec * 1000);
  }
  const unified = headers['anthropic-ratelimit-unified-reset'] || headers['x-ratelimit-reset'];
  if (unified && /^\d+$/.test(String(unified).trim())) {
    const n = Number(unified);
    const d = new Date(n > 1e12 ? n : n * 1000); // ms vs seconds
    const cap = Date.now() + MAX_FALLBACK;
    return d.getTime() > cap ? new Date(cap) : d;
  }
  return new Date(Date.now() + ONE_HOUR);
}

// ---- proxy -----------------------------------------------------------------

function proxy(req, res, bodyBuf, client) {
  const up = store.activeUpstream(client);
  if (!up) {
    return json(res, 503, { error: { type: 'rotator_no_provider', message: client + ' has no provider configured — add one in the dashboard.' } });
  }
  const base = new URL(up);
  const budget = store.activeCount(client); // retry only across this client's tokens
  const syncKey = CLIENTS[client].syncKey;

  function attempt(tries) {
    const token = store.selectActive(client);
    if (!token) {
      log(`!! no available tokens for ${client}`);
      return json(res, 503, { error: { type: 'rotator_no_tokens', message: `All ${client} tokens are rate-limited or unavailable.` } });
    }

    const target = new URL(req.url, base);
    const headers = { ...req.headers };
    headers.host = base.host;
    headers['x-api-key'] = token.key;
    headers.authorization = 'Bearer ' + token.key;
    delete headers['content-length'];
    if (bodyBuf && bodyBuf.length) headers['content-length'] = Buffer.byteLength(bodyBuf);

    const lib = base.protocol === 'http:' ? http : https;
    const upReq = lib.request(
      { hostname: base.hostname, port: base.port || (base.protocol === 'http:' ? 80 : 443), path: target.pathname + target.search, method: req.method, headers },
      (upRes) => {
        const code = upRes.statusCode;

        // Success -> stream straight through (keeps SSE / streaming intact).
        if (code >= 200 && code < 300) {
          syncKey(token.key);
          if (sent(res)) return upRes.resume();
          res.writeHead(code, upRes.headers);
          return upRes.pipe(res);
        }

        // Error -> buffer it (errors are small) so we can read the limit message.
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => {
          const raw = Buffer.concat(chunks);
          const text = decode(raw, upRes.headers['content-encoding']);
          const isLimit = code === 429 || code === 402 || isLimitText(text);
          const isAuth = code === 401 || code === 403;

          // Rate / usage limit -> mark + reset time, rotate, retry same request.
          if (isLimit && tries < budget) {
            const parsedReset = parseResetFromBody(text);
            const reset = parsedReset || parseReset(upRes.headers);
            logLimit(token.account, code, text, reset, !!parsedReset);
            store.markExhausted(token.id, reset);
            log(`[${client}] ${code} limit on ${token.account} -> reset ${reset.toLocaleString()} (${parsedReset ? 'parsed' : 'FALLBACK'}), rotating`);
            syncKey((store.selectActive(client) || {}).key);
            return attempt(tries + 1);
          }

          // Bad/expired token -> skip it (no auto-recover) and try next.
          if (isAuth && tries < budget) {
            store.markError(token.id, 'auth ' + code);
            log(`[${client}] ${code} on ${token.account} -> marked error, rotating`);
            syncKey((store.selectActive(client) || {}).key);
            return attempt(tries + 1);
          }

          // Give up / non-limit error -> forward the original response unchanged.
          syncKey(token.key);
          if (sent(res)) return;
          res.writeHead(code, upRes.headers);
          res.end(raw);
        });
        upRes.on('error', () => { if (!sent(res)) { try { res.writeHead(502); res.end(); } catch (_) {} } });
      }
    );

    upReq.on('error', (e) => {
      log(`[${client}] upstream error:`, e.message);
      if (tries < budget && !sent(res)) {
        store.markError(token.id, e.message);
        return attempt(tries + 1);
      }
      json(res, 502, { error: { type: 'rotator_upstream_error', message: e.message } });
    });

    if (bodyBuf && bodyBuf.length) upReq.end(bodyBuf);
    else upReq.end();
  }

  attempt(0);
}

// ---- dashboard API ---------------------------------------------------------

async function api(req, res, bodyBuf) {
  const url = req.url;

  if (req.method === 'GET' && url === '/api/tokens') {
    return json(res, 200, store.snapshot());
  }

  let payload = {};
  if (bodyBuf && bodyBuf.length) {
    try { payload = JSON.parse(bodyBuf.toString('utf8')); } catch (_) {}
  }
  const client = store.CLIENTS.includes(payload.client) ? payload.client : 'claude';

  if (req.method === 'POST' && url === '/api/tokens') {
    const r = store.addToken(payload.key, payload.account, client);
    if (r.ok) syncClientConfig(client);
    return json(res, 200, r);
  }
  if (req.method === 'POST' && url === '/api/activate') {
    const r = store.activate(client, payload.id);
    if (r.ok) syncClientConfig(client);
    return json(res, 200, r);
  }
  if (req.method === 'POST' && url === '/api/delete') {
    const r = store.deleteToken(payload.id);
    if (r.ok) syncClientConfig(client);
    return json(res, 200, r);
  }
  if (req.method === 'POST' && url === '/api/reset') {
    return json(res, 200, store.resetStatus(payload.id));
  }

  // ---- provider routes ----
  if (req.method === 'POST' && url === '/api/provider') {
    const r = store.addProvider(payload.name, payload.baseUrl, client);
    if (r.ok) syncClientConfig(client);
    return json(res, 200, r);
  }
  if (req.method === 'POST' && url === '/api/provider/activate') {
    const r = store.setActiveProvider(client, payload.id);
    if (r.ok) {
      syncClientConfig(r.client);
      if (r.client === 'claude') {
        try { fs.writeFileSync(UPSTREAM_FILE, store.activeUpstream('claude')); } catch (_) {}
      }
      log(`[${r.client}] provider ->`, payload.id, '(' + store.activeUpstream(r.client) + ')');
    }
    return json(res, 200, r);
  }
  if (req.method === 'POST' && url === '/api/provider/delete') {
    const r = store.deleteProvider(payload.id);
    if (r.ok) {
      if (r.client === 'claude') {
        try { fs.writeFileSync(UPSTREAM_FILE, store.activeUpstream('claude')); } catch (_) {}
        settings.syncActiveKey(store.activeKey('claude'));
      } else if (r.empty) {
        // Codex lost its last provider -> point its config back at the upstream
        // we just removed so Codex isn't left aimed at a dead localhost port.
        codex.restoreUpstream(r.removedBaseUrl);
      } else {
        syncClientConfig('codex');
      }
    }
    return json(res, 200, r);
  }
  return json(res, 404, { error: 'unknown api route' });
}

// ---- routers ---------------------------------------------------------------

// Claude port: dashboard + control API + Claude proxy traffic.
const claudeServer = http.createServer(async (req, res) => {
  const url = req.url || '/';

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  if (url === '/favicon.ico') { res.writeHead(204); return res.end(); }

  if (url.startsWith('/api/')) {
    const body = req.method === 'POST' ? await readBody(req) : null;
    return api(req, res, body);
  }

  const body = await readBody(req);
  proxy(req, res, body, 'claude');
});

// Codex port: proxy only.
const codexServer = http.createServer(async (req, res) => {
  const body = await readBody(req);
  proxy(req, res, body, 'codex');
});

// On shutdown, point each CLI back at its direct upstream so a stopped/crashed
// rotator never leaves a config aimed at a dead localhost:port.
let restored = false;
function restoreAndExit(code) {
  if (!restored) {
    restored = true;
    settings.restoreBaseUrl(store.activeUpstream('claude'));
    if (store.clientProviderCount('codex') > 0) codex.restoreUpstream(store.activeUpstream('codex'), store.activeKey('codex'));
  }
  process.exit(code);
}
process.on('SIGINT', () => restoreAndExit(0));
process.on('SIGTERM', () => restoreAndExit(0));
process.on('SIGHUP', () => restoreAndExit(0));
process.on('uncaughtException', (e) => { console.error('[rotator] fatal:', e); restoreAndExit(1); });

claudeServer.listen(PORT, () => {
  console.log('========================================================');
  console.log(`  token-rotator running`);
  console.log(`  dashboard:    http://localhost:${PORT}/`);
  console.log(`  claude proxy: http://localhost:${PORT}  ->  ${store.activeUpstream('claude')}`);
  console.log(`  codex proxy:  http://localhost:${CODEX_PORT} ->  ${store.activeUpstream('codex') || '(no provider yet)'}`);
  console.log(`  tokens:       ${store.count()} (claude: ${store.activeCount('claude')}, codex: ${store.activeCount('codex')})`);
  console.log('  ВАЖНО: перезапусти Claude Code (и Codex, если настроен), чтобы подхватить base_url');
  console.log('========================================================');
});
codexServer.listen(CODEX_PORT);
