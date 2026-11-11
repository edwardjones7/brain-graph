# KeepOS agent

An always-on personal agent: Claude Code running headless inside your Obsidian vault, reachable from Telegram. See the [top-level README](../README.md) for the design.

## Setup

You need:
- Node 22 or newer.
- [Claude Code](https://docs.claude.com/en/docs/claude-code), installed and logged in (`claude` on your PATH). Runs use your Claude subscription.
- A Telegram bot token from [@BotFather](https://t.me/BotFather), and your own Telegram user id (from [@userinfobot](https://t.me/userinfobot)).

```bash
npm install
cp .env.example .env
```

Fill in `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID`. `VAULT_DIR` starts out pointing at `example-vault/`, so you can try everything before you point it at your own notes.

Try one turn from the terminal, then start the bot:

```bash
npm run ask -- "who's on your team, and what does each one do?"
npm start
```

## Your vault

Point `VAULT_DIR` at your Obsidian vault and add three notes at its root. They're read fresh on every run, so an edit applies to the next message:

| File | What it's for |
| --- | --- |
| `IDENTITY.md` | Who the agent is, and how the vault is organized: where tasks, projects and ideas go. |
| `SOUL.md` | How it talks and behaves. |
| `USER.md` | Who you are. |

Set `GIT_SYNC=true` if the vault is a git repo with a remote. The agent then pulls before every run and commits and pushes after, so your laptop, phone and the agent stay in step, and every change it makes is a commit you can read or revert.

## Specialists

A specialist is a folder in `Agents/` with a note of the same name:

```markdown
---
description: Research specialist. Hand Scout anything that needs reading around the web.
model: sonnet
tools: Read, Grep, Glob, WebSearch, WebFetch   # optional allowlist
parent: Lead                                    # optional: reports to another specialist
vault: false                                    # optional: no vault access, for agents that read untrusted pages
---
# Scout

Personality and job description, in plain words.
```

The main agent sees every specialist's `description` and hands off through Claude Code's Agent tool. Each specialist keeps `Agents/<Name>/Memory.md` up to date itself. Talk to one directly with `/talk scout` in Telegram, and `/talk` on its own to come back.

## Scheduled jobs

A job is a file in `jobs/`:

```markdown
---
schedule: 0 7 * * *   # cron, in TZ_NAME
enabled: true
model: haiku          # optional
---
What to do, in plain words. End with when to stay quiet: "otherwise output exactly NOTHING_TO_SEND".
```

Run one now with `npm run job -- daily-note`, or `/run daily-note` in Telegram. If a job hits the usage limit, it retries after the limit resets instead of being skipped.

## The live browser

With `BROWSER=true` the agent gets a browser through [Playwright MCP](https://github.com/microsoft/playwright-mcp). By default it's headless and forgets everything after each run.

With `BROWSER_LIVE=true` as well, it drives its own Chromium with a saved profile instead, and gets a `need_human` tool. When a site shows a captcha, wants a login or sends a verification code, the agent calls it, and you get a Telegram message with a link to `/live`. That page shows the agent's tab as it is. Tap to click, type into fields, scroll and zoom, then press Done. The agent waits up to `HANDOFF_WAIT_MS` (5 minutes by default), and the run's timeout pauses while it does.

- Install Chromium once: `npx playwright install chromium`.
- Bind `WEB_HOST` to a private address. A [Tailscale](https://tailscale.com) IP is the easy way to reach it from your phone. The link carries a random secret (kept in `data/live-token`); anyone with the link can drive the browser.
- Logins stick between runs, which is the point and also the risk: a page the agent opens can act with them. Keep it to the sites the agent works on, and never sign into email or banking in it.

## Commands

| Telegram | |
| --- | --- |
| *(any message)* | Talk to the agent, or to the specialist you picked with `/talk` |
| `/new` | End the conversation. It files what matters into the vault first. |
| `/talk <name>` | Talk to a specialist directly; `/talk` alone comes back |
| `/team` | List the specialists |
| `/jobs`, `/run <job>` | List jobs, run one now |
| `/status` | Whether it's busy |

| Terminal | |
| --- | --- |
| `npm run ask -- "..."` | One turn, no Telegram |
| `npm run job -- <name>` | Run a job and print what it would send |
| `npm test`, `npm run typecheck` | Checks |

## Running it 24/7

Any always-on machine works: a home server, a small VPS, a Mac mini. On Linux, a systemd unit along these lines:

```ini
[Unit]
Description=KeepOS agent
After=network-online.target

[Service]
User=you
WorkingDirectory=/home/you/keepos/agent
ExecStart=/usr/bin/npm start
Restart=always

[Install]
WantedBy=multi-user.target
```

Only one process can poll a Telegram bot token, so use `npm run ask` for testing while the service is up.

## Security

The agent reads your notes and, depending on `PERMISSION_MODE`, can run commands. Read this before you widen it:

- The bot answers only `TELEGRAM_OWNER_ID` and ignores everyone else.
- `acceptEdits` (the default) lets it write files in the vault, but the shell is limited to the read-only commands listed in `src/claude.ts`. `bypassPermissions` lets it run anything as the service's user.
- Web pages and emails can carry instructions meant for the agent (prompt injection). Give specialists that read untrusted pages `vault: false` and a short `tools:` list.
- `.env` holds your bot token. `data/` holds session ids, the `/live` secret and the browser profile. Neither belongs in git.
