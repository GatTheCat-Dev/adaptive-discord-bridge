# ADB Setup Guide (Agent-Readable)

This guide is for an Adaptive agent installing ADB on behalf of a user.
Follow each step in order. Do not skip any step.

---

## What You're Installing

**Adaptive Discord Bridge (ADB)** — a utility app that connects a user's Adaptive computer
to Discord. The bot responds to DMs and @mentions in servers, with per-channel context memory.

---

## Prerequisites

- Adaptive computer running and accessible
- User has a Discord account and can create a bot at discord.com/developers

---

## Step 1 — Clone the Repo

```bash
git clone https://github.com/GatTheCat-Dev/adaptive-discord-bridge.git /home/computer/discord-bridge
cd /home/computer/discord-bridge
npm install
```

---

## Step 2 — Scaffold the App

Use the `scaffold_new_app` tool:

```
name: discord-bridge
displayName: Discord Bridge
description: Connects this Adaptive computer to Discord
slug: discord-bridge
kind: utility
```

This registers the project with the Adaptive platform and assigns it an app ID.

---

## Step 3 — Create a Discord Bot

Tell the user:

> "I need you to create a Discord bot. Go to https://discord.com/developers/applications and:
> 1. Click **New Application** — name it whatever you like (e.g. "Adaptive")
> 2. Go to **Bot** → click **Reset Token** → copy the token
> 3. Under **Privileged Gateway Intents**, enable:
>    - **Message Content Intent**
>    - **Server Members Intent** (optional but recommended)
> 4. Go to **OAuth2 → URL Generator** → check **bot** scope → permissions: **Send Messages**, **Read Message History**, **Attach Files**
> 5. Copy the generated URL, open it, and invite the bot to any servers you want

Once the user has the token, continue to Step 4.

---

## Step 4 — Configure Environment

Add the following to `/home/computer/discord-bridge/.env.development`:

```
DISCORD_BOT_TOKEN=<token from Step 3>
DISCORD_OWNER_ID=<user's Discord user ID — right-click their name in Discord → Copy User ID>
ADAPTIVE_HANDLE=<user's Adaptive handle, e.g. "Gat">
```

The platform injects `VITE_BASE_URL`, `PORT`, and other system vars automatically — do not add those.

---

## Step 5 — Run Migrations

```bash
cd /home/computer/discord-bridge
npx prisma migrate deploy
```

---

## Step 6 — Verify

Hit the health endpoint to confirm the app started and the bot connected:

```bash
curl http://localhost:<PORT>/rpc/health
curl http://localhost:<PORT>/rpc/botStatus
```

`botStatus` should return `{ "connected": true, "username": "YourBot#1234" }`.

---

## Step 7 — Test It

Have the user send a DM to the bot on Discord or @mention it in a server channel.
It should respond within a few seconds.

---

## Notes

- Channel memory files are stored at `/home/computer/.memory/adb/`
- `_index.json` at that path maps Discord IDs to slugs — do not delete it
- The bot auto-registers new servers and channels on first @mention
- To send a message to the user proactively, call the `sendToDiscord` RPC endpoint
