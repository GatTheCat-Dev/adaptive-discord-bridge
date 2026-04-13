# Discord Bridge

**Purpose**: Bridge between Discord DMs and the Adaptive agent — same brain, different channel.

**Type**: utility (persistent bot service)

**Status**: active

## What It Does

- Connects to Discord as a bot and listens for DMs
- Forwards every DM to the Adaptive agent via `mcp.promptAgent()`
- Returns the agent's response back to Discord
- Maintains multi-turn conversation continuity per user via `previousSessionId`
- This is NOT a separate personality — it's the same Adaptive agent, just on Discord

## Bot Details

- **Discord Tag**: Adaptive#2858
- **Application ID**: 1493680806256836668
- **Token Location**: `/home/computer/.memory/accounts/discord-bot.md`
- **Invite URL**: `https://discord.com/oauth2/authorize?client_id=1493680806256836668&scope=bot&permissions=3072`

## Architecture

- `src/bot/discord-bot.ts` — Discord gateway client, message handling, promptAgent bridge
- `src/api/server.ts` — Hono HTTP server + bot startup
- `src/api/procedures.ts` — RPC endpoints (health, botStatus)

## Functions

- `health()` — Standard health check (db status, env, timestamp)
- `botStatus()` — Bot connection status, uptime (seconds), active session count, username

## Integrates With

- **Internal**: Adaptive agent via `mcp.promptAgent()` — full computer access

## Notes

- MessageContent privileged intent is NOT enabled — DMs work without it
- Bot uses discord.js v14 with Partials for DM channel support
- Session continuity per Discord user via Map of sessionIds
- Self-pings every 3 minutes to prevent watchdog auto-shutdown
- Splits long messages to respect Discord's 2000 char limit
- Shows typing indicator while agent processes
