# 📱 PlugStack Deploy Bot — Deploy Full Stacks from Telegram

**This is the product.** Deploy and manage entire application stacks — frontend, backend, Kafka, Postgres, anything — from your phone, with password auth, confirmation buttons, and a full audit trail.

```
You:  /deploy full-platform
Bot:  Deploy stack "full-platform"?   [🚀 Deploy] [✖ Cancel]
You:  taps 🚀
Bot:  ✅ Stack "full-platform" deployed:
        ✅ db — container up
        ✅ kafka — container up
        ✅ api — pid 4911, healthy
           http://localhost:4000
        ✅ web — pid 4919, healthy
           http://localhost:8080
```

Zero dependencies — pure Node.js, long polling (works behind NAT, no webhook server needed).

## Why people pay for this

| Free tools give you | Deploy Bot adds |
|---|---|
| `docker compose up` at a terminal | Deploy from your phone, anywhere |
| Whoever has SSH can do anything | Password gate + 5-minute lockout after 3 failures |
| No record of who deployed what | Append-only audit trail (`/audit`, `.plugstack/audit.jsonl`) |
| Fire-and-forget | Confirmation buttons before every deploy/stop |
| Logs on the server | `/logs <stack> <service>` in chat |

## Setup (2 minutes)

1. Create a bot with [@BotFather](https://t.me/botfather), copy the token.
2. Start the bot:

```bash
TELEGRAM_BOT_TOKEN="123:abc" PLUGSTACK_BOT_PASSWORD="choose-a-password" npm run deploy-bot
```

(It also reads `telegramBotToken` / `password` from the existing `config.json` if present.)

3. Message your bot, send the password once, and deploy.

## Commands

| Command | What it does |
|---|---|
| `/stacks` | List deployable stacks from `./stacks/` |
| `/deploy <stack>` | Deploy — asks for confirmation first |
| `/stop <stack>` | Stop — asks for confirmation first |
| `/status <stack>` | Live per-service running/healthy state |
| `/logs <stack> <service>` | Last 30 log lines in chat |
| `/audit` | Recent deploy history — who, what, when |
| `/logout` | Require the password again |

## Security model

- Every chat must authenticate with the password before any command works.
- 3 wrong attempts → 5-minute lockout for that chat.
- Authorized chats persist across restarts (`.plugstack/bot-auth.json`).
- Every auth attempt, deploy, and stop is written to the append-only audit log with the Telegram username.
- Destructive actions (deploy/stop) always require an explicit button press — no accidental deploys from a typo.

## Architecture

```
Telegram ⇆ telegram.js (long-poll client, zero deps)
              │
           bot.js (wiring)
              │
         commands.js (router — pure logic, fully unit tested)
          │        │
      auth.js   engine/api.js  ──►  PlugStack engine (resolver, runners, health)
          │
      audit.js (JSONL trail)
```

The router is pure logic with no network access, so the entire product flow — auth, lockout, confirmation, deploy, audit — is covered by `npm test`, including a real end-to-end deploy of a live stack.
