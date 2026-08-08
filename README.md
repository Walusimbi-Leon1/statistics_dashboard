# 🎮 Game Statistics Dashboard

Daily Cloudflare request statistics for **all our games** (Workers + Pages) across **both Cloudflare accounts** — automatically collected every day and rendered into a beautiful dashboard.

**Live dashboard:** https://walusimbi-leon1.github.io/statistics_dashboard/

## How it works

| Piece | What it does |
|---|---|
| **GitHub Actions** (`daily-stats.yml`) | Runs every day at 06:00 UTC (+ manual trigger) |
| **collect.mjs** | Queries the Cloudflare GraphQL Analytics API for per-script daily request counts (Workers invocations + Pages function invocations) on both accounts, merges into `data/history.json` |
| **big-pickle** (opencode.ai) | Turns the raw JSON into a polished, self-contained dashboard (`index.html`) — tables, bar charts, trends |
| **GitHub Pages** | Serves the dashboard for free |

## Accounts covered

- **Account 1** — walusimbileon1 (bible-trivia, quran-trivia, trivia-rumble-elite, bluff-dice, dice-arena, audiobooks, opencode-proxy, youstream-proxy)
- **Account 2** — walusimbileon2 (bible-game-telegram, casino, pop-party, pop-the-balloon, snakeworld1, snakeworld1-telegram-bot, trivia-rumble-3, voice-vibes, youtrivia, wstest-probe2 + Pages projects)

## Secrets (GitHub Actions)

| Secret | Purpose |
|---|---|
| `CF_ACCOUNT1` / `CF_TOKEN_ACCOUNT1` | Account 1 ID + API token |
| `CF_ACCOUNT2` / `CF_TOKEN_ACCOUNT2` | Account 2 ID + API token |
| `OPENCODE_API_KEY` | big-pickle model access (opencode.ai) |

## Local dev

```bash
CF_ACCOUNT1=... CF_TOKEN_ACCOUNT1=... CF_ACCOUNT2=... CF_TOKEN_ACCOUNT2=... node scripts/collect.mjs
OPENCODE_API_KEY=... node scripts/generate.mjs
```

The generator is resilient: if big-pickle fails, a deterministic fallback dashboard is written so the site never breaks.
