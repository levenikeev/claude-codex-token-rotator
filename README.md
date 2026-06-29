<div align="center">

# 🔄 Token Rotator — for Claude Code & Codex CLI

**Never get kicked out of a coding session by a rate limit again.**
A tiny local proxy that auto-rotates your API tokens the instant one hits its limit — for **Claude Code** and **Codex CLI** at the same time.

![Node](https://img.shields.io/badge/Node.js-18%2B-3c873a)
![No deps](https://img.shields.io/badge/dependencies-0-blue)
![Platforms](https://img.shields.io/badge/Claude%20Code%20%2B%20Codex-supported-7c9cff)
![License](https://img.shields.io/badge/license-MIT-green)
![PRs welcome](https://img.shields.io/badge/PRs-welcome-orange)

⭐ **If this saves your tokens (and your sanity), drop a star — it genuinely helps the project get found.**

</div>

---

## 😩 The problem

Free / community endpoints for Claude Code and Codex (freemodel, aerolink, bluesminds, …) hand you tokens — but every token burns through its usage limit fast. So you sit there:

- a request 429s mid-task → your agent dies,
- you alt-tab, paste the next key into a config file,
- restart the CLI, lose your context,
- … repeat 20 times a day. 💀

## ✅ The fix

`Token Rotator` is a localhost reverse proxy that sits between your CLI and the upstream. When a token hits a limit it **rotates to the next free one and retries the same request transparently** — your CLI never even notices. It tracks each token's reset time, auto-revives them, and shows everything on a live dashboard. One process drives **both** Claude Code and Codex, each on its own port with its own isolated token pool.

```
Claude Code ──▶ http://localhost:8787 ┐
Codex CLI   ──▶ http://localhost:8788 ┤  Token Rotator
                                      │
   per client: active provider + its own token pool
   catches 429 / 402  →  marks token + reset time
   →  picks next free token (same client)  →  retries request
   →  your CLI gets a clean answer and keeps going
        │
        ├─ claude ▶ capi.aerolink.lat │ cc.freemodel.dev │ …
        └─ codex  ▶ bluesminds.com │ …
```

## ✨ Features

- 🔁 **Mid-session rotation** — no restart, no lost context. Switches the key under the hood and retries.
- 👥 **Two clients at once** — Claude Code (`:8787`) and Codex CLI (`:8788`), fully isolated. A Claude key never serves a Codex request and vice-versa.
- 🧩 **Multiple providers per client** — group keys by endpoint, switch providers from the dashboard.
- ⏱️ **Smart reset tracking** — parses the upstream's reset time (or falls back), then auto-revives the token.
- 🛟 **Never bricks your CLI** — on shutdown it repoints each CLI back at the real upstream, so a stopped proxy never leaves you stranded.
- 🩹 **Crash-proof proxy** — a single bad upstream can't take the process down.
- 🖥️ **Live dashboard** — status, countdowns, add/remove keys & providers, one-click switch.
- 📦 **Zero dependencies** — pure Node.js. Just `node server.js`.

## 🚀 Quick start (Claude Code)

```bash
git clone https://github.com/levenikeev/claude-codex-token-rotator.git
cd claude-codex-token-rotator
# add your keys via the dashboard, or seed them:
cp tokens.txt.example tokens.txt   # then edit with your real keys (git-ignored)

# double-click start.bat  (or:)
node server.js
```

On first run it:
- backs up `~/.claude/settings.json` → `settings.json.rotator-bak`,
- points `ANTHROPIC_BASE_URL` at `http://localhost:8787`,
- migrates `tokens.json` (with a `tokens.json.bak`).

Then **restart Claude Code once** so it picks up the new base URL. Dashboard: **http://localhost:8787/**

> `~/.codex` is left completely untouched until you opt in by adding a Codex provider (below).

## 🤖 Connect Codex CLI

1. Open the dashboard → click the **Codex** tab.
2. **+ add provider** → name (e.g. `bluesminds`) + URL (e.g. `https://bluesminds.com`).
3. Add your `sk-…` token(s) for that provider.
4. The moment the first Codex provider exists, the rotator:
   - backs up `~/.codex/config.toml` and `~/.codex/auth.json` (`*.rotator-bak`),
   - adds `[model_providers.rotator]` (`base_url = http://localhost:8788`) and selects it,
   - writes the active key into `auth.json` (`OPENAI_API_KEY`).
5. **Restart Codex once.** From now on it rotates exactly like Claude.

## 🎛️ Dashboard

A **Claude / Codex** switch up top; everything below is scoped to the selected client:

- provider dropdown + URL + delete, and **+ add provider**,
- token table: account, status (🟢 free / 🔴 limited / ⚠️ error / ● active), reset countdown,
- **add key** form, plus per-token *make active / clear limit / delete*.

## ⚙️ Config & files

| File | Purpose |
|---|---|
| `server.js` | proxy (2 ports) + control API + serves the dashboard |
| `store.js` | token pool by client/provider, statuses, auto-recovery |
| `settings.js` | syncs `~/.claude/settings.json` (Claude) |
| `codex.js` | syncs `~/.codex/config.toml` + `auth.json` (Codex) |
| `dashboard.html` | the web UI |
| `tokens.txt.example` | seed-file format (copy to `tokens.txt`) |

Override ports with `ROTATOR_PORT` (Claude, default `8787`) and `ROTATOR_CODEX_PORT` (Codex, default `8788`).

## ↩️ Rollback

Stopping the bot auto-restores each CLI to its direct upstream. Full manual revert:

- **Claude:** copy `settings.json.rotator-bak` back to `~/.claude/settings.json`.
- **Codex:** copy `~/.codex/config.toml.rotator-bak` and `~/.codex/auth.json.rotator-bak` back.

---

## ❤️ Support the developer

This is a free, no-ads, zero-tracking weekend project. If it saved you time, a coffee is hugely appreciated:

> 💳 **`2200 7019 5279 1496`**

…and a ⭐ on the repo costs nothing but means a lot. Thank you! 🙏

---

<div align="center">

### 🇷🇺 Кратко по-русски

Локальный прокси, который **сам меняет токены при лимите** — для Claude Code и Codex сразу.
Ловит 429/402, переключается на следующий свободный ключ и повторяет запрос — сессия не падает.
Запуск: `node server.js` (или `start.bat`), потом перезапусти Claude Code один раз. Дашборд: `http://localhost:8787/`.
Codex подключается в дашборде на вкладке **Codex** (добавь провайдера + sk-ключи).

**Поставь ⭐, если пригодилось.**

</div>

<!--
keywords: claude code, codex cli, token rotator, api key rotation, rate limit,
anthropic proxy, openai proxy, llm proxy, round robin api keys, 429 retry,
free claude, claude code proxy, codex proxy, key rotation, load balancer
-->
