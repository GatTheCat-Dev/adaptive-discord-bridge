# Discord Bridge

**Purpose**: Bridge between Discord and the Adaptive agent — same brain, different channel.

**Type**: utility (persistent bot service)

**Status**: active (V2)

## What It Does

- Connects to Discord as a bot via discord.js gateway
- Responds to DMs with full conversation continuity (DB-persisted)
- Responds to server @mentions with per-channel context (API-fetched history + file-based memory)
- Forwards everything to the Adaptive agent via `mcp.promptAgent()`
- This is NOT a separate personality — it's the same Adaptive agent, just on Discord

## V2 Features

- Per-channel memory files at `/home/computer/.memory/adb/{server}/{channel}.md`
- `_index.json` maps Discord IDs to filesystem slugs
- Auto-registration of servers and channels on first @mention
- On-demand fetch of last 50 messages from Discord API (no passive logging)
- Multi-user attribution in agent prompts
- File/image sending via multipart/form-data
- GUILD_UPDATE / CHANNEL_UPDATE rename handlers
- Cross-channel awareness via file reads
- Smart DM message classification (simple chat vs full agent path)

## Architecture

- `src/bot/discord-bot.ts` — Discord gateway client, message handling, promptAgent bridge, channel memory
- `src/api/server.ts` — Hono HTTP server + bot startup
- `src/api/procedures.ts` — RPC endpoints (health, botStatus, sendToDiscord, getDiscordHistory)
- `src/lib/env.ts` — Environment validation (Zod)
- `schema.prisma` — DB schema for DM conversation history

## RPC Endpoints

- `health()` — Standard health check (db status, env, timestamp)
- `botStatus()` — Bot connection status, uptime, active sessions, username
- `sendToDiscord({ message, userId?, imageUrls? })` — Send proactive DM to a Discord user
- `getDiscordHistory({ userId?, limit? })` — Retrieve recent DM conversation history

## Environment Variables (ADB-specific)

- `DISCORD_BOT_TOKEN` — Required. The bot's Discord token.
- `DISCORD_OWNER_ID` — Optional. Default Discord user ID for sendToDiscord/getDiscordHistory.
- `ADAPTIVE_HANDLE` — Optional. User's Adaptive handle for prompt personalization.

## Integrates With

- **Internal**: Adaptive agent via `mcp.promptAgent()` — full computer access
- **External**: Discord API v10 (REST + Gateway)
