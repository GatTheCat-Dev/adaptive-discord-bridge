# ADB Update Guide (Agent-Readable)

This guide is for an Adaptive agent updating ADB to the latest version.
Local data is preserved. Config is not overwritten.

---

## What Is Safe to Overwrite

- All files tracked by git (source code, config templates, docs)

## What Must NOT Be Overwritten

- `.env.development` — contains the bot token and owner config
- `*.db`, `*.db-shm`, `*.db-wal` — local SQLite databases
- `/home/computer/.memory/adb/` — channel memory files (outside repo, safe)

---

## Update Steps

### 1 — Pull latest code

```bash
cd /home/computer/discord-bridge
git fetch origin
git pull origin main
```

If there are local uncommitted changes to tracked files, stash them first:

```bash
git stash
git pull origin main
git stash pop
```

### 2 — Install any new dependencies

```bash
npm install
```

### 3 — Run migrations (if any)

```bash
npx prisma migrate deploy
```

Prisma will skip migrations that have already been applied — safe to run every time.

### 4 — Restart the app

The Adaptive platform restarts utility apps automatically on next request.
If the bot was running, it will reconnect on next incoming message.

To force an immediate restart, use the platform's app restart mechanism
or kill and restart the dev server process.

### 5 — Verify

```bash
curl http://localhost:<PORT>/rpc/botStatus
```

Should return `{ "connected": true }`.

---

## Rollback

If the update breaks something:

```bash
cd /home/computer/discord-bridge
git log --oneline -10        # find the last good commit
git checkout <commit-hash>   # revert to it
npm install
npx prisma migrate deploy
```

Your `.env.development` and databases are untouched.
