# KeepOS

An always-on personal agent that lives in your notes.

KeepOS runs Claude Code headless inside an Obsidian vault, on your own machine, and you talk to it from Telegram. The vault is its memory: it reads your notes before it answers and writes to them before it finishes, so everything it knows is a markdown file you can open, read and fix. It messages you on a schedule, hands work to specialist agents that keep their own memory, and, when a website wants a human, sends you a link to take over its browser from your phone.

> **This is the open-source version of Rook**, the personal agent I run every day on my own server. Rook does more than what's here, with more specialists, more tools and a full dashboard. This repo is the core it's built on, without my personal data, and you can run it yourself. How Rook works and what it does day to day is in **[the write-up on the Elenos blog](https://elenos.ai/blog/rook-personal-ai-agent/)**.

It's two parts:

| Folder | What |
| --- | --- |
| [`agent/`](agent/) | The agent: Telegram bot, headless Claude Code runner, conversations that file themselves into the vault, scheduled jobs, specialist agents and the live browser handoff. |
| [`brain-graph/`](brain-graph/) | Turn any Obsidian vault into a living 3D brain. Zero dependencies. |

![A brain-shaped 3D graph of notes and links](brain-graph/docs/preview.jpg)

## How it works

```mermaid
flowchart LR
  phone([Telegram]) -->|message| bot[Bot<br/>owner only]
  cron([Schedules<br/>jobs/*.md]) --> queue
  bot --> queue[Run queue<br/>one at a time]
  queue --> pull[git pull vault]
  pull --> claude["claude -p<br/>stream-json"]
  claude <-->|read / write| vault[(Obsidian vault<br/>IDENTITY · SOUL · USER<br/>Agents/*)]
  claude -->|Agent tool| spec[Specialists<br/>own prompt + Memory.md]
  claude -->|MCP| browser[Live Chromium]
  browser -.->|captcha / login| handoff[need_human]
  handoff -.->|link| phone
  claude --> commit[git commit + push]
  claude -->|reply / progress| bot
```

Every message and every scheduled job becomes one headless Claude Code run inside the vault. The service pulls the vault first, streams the run's tool calls to Telegram as live status lines ("reading Projects/Trip.md"), and commits whatever the run wrote. Runs go through a single queue, because every run touches the same files and the same git repo.

## Design decisions

**Claude Code is the runtime.** There's no agent framework here. `claude -p --output-format stream-json` already has the loop, the tools, subagents, MCP and permission modes, and it runs on a Claude subscription instead of per-token API billing. The service around it is under 2,000 lines, the /live page included: process management, memory, scheduling and a phone interface.

**The vault is the memory, not the chat log.** A conversation is a resumed Claude session while it's active. After a few idle hours it gets one last "wrap-up" turn that files every durable fact, decision and commitment into the right note, then it's retired. The next conversation starts small and reads what it needs. There's no vector database: the agent searches the notes with Grep and Glob, like you would.

**Personality is a file, read fresh every run.** `IDENTITY.md`, `SOUL.md` and `USER.md` are injected as the system prompt on every run, so editing one in Obsidian changes the next reply, and the core instructions never get buried under a long conversation. Anything that changes between runs (the time, recent notes) goes in the message instead, so the system prompt stays byte-identical and the prompt cache holds.

**Specialists are notes too.** `Agents/<Name>/<Name>.md` defines a specialist: a description that tells the main agent when to hand off, a model, an optional tool allowlist, and a personality. Each keeps its own `Memory.md`, which it's instructed to update before every run ends. Teams nest (`parent: Lead`), and an agent that reads untrusted web pages can be cut off from the vault entirely (`vault: false`).

**Proactive, but quiet.** Jobs are markdown files with a cron schedule. A job that finds nothing worth your attention answers `NOTHING_TO_SEND` and no message goes out. That rule is what keeps a proactive agent from turning into noise.

**Humans for what humans are for.** When the browser hits a captcha, a login or a verification code, the agent doesn't try to get around it. It calls `need_human`, you get a Telegram link, and the page shows its live tab (a DevTools screencast) that you drive with taps and typing. You press Done and it carries on. Logins persist in the browser profile, so it asks once per site.

**One owner, least privilege.** The bot answers one Telegram user and ignores everyone else. The default permission mode lets the agent write notes but limits the shell to read-only commands. The `/live` page needs a random secret from the link and should be bound to a private address such as a Tailscale IP.

## Get started

```bash
git clone https://github.com/edwardjones7/keepos.git
cd keepos/agent
npm install
cp .env.example .env   # add your Telegram bot token and user id
npm run ask -- "what's in this vault?"   # one turn from the terminal, against the example vault
npm start              # the bot, schedules and all
```

You need Node 22+ and [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and logged in. The full setup is in [`agent/README.md`](agent/README.md).

## License

MIT.

Built by [Edward Jones](https://github.com/edwardjones7) · [Elenos](https://elenos.ai) · [The Rook write-up](https://elenos.ai/blog/rook-personal-ai-agent/).
