import { Hono } from "hono";
import { deserialize, serialize } from "superjson";
import { serve } from "@hono/node-server";
import {
  honoMiddleware,
  initializeServerEnvironment,
} from "@adaptive-ai/sdk/server";
import { env } from "@/lib/env";
import { readFile } from "fs/promises";
import { startDiscordBot } from "@/bot/discord-bot";

const INDEX_HTML = await readFile("./index.html", "utf-8");

const transcoder = { serialize, deserialize };

initializeServerEnvironment({
  baseUrl: env.VITE_BASE_URL,
  realtimeDomain: env.VITE_REALTIME_DOMAIN,
  guestServicesUrl: env.GUEST_SERVICES_URL,
  environment: env.VITE_NODE_ENV,
  apiKey: env.API_KEY,
  queueDbPath: env.QUEUE_DB_FILE_NAME,
  errorsDbPath: env.ERRORS_DB_FILE_NAME,
});

// Import these after initializing the environment
const { procedures, jobs } = await import("@/api");

const app = new Hono();

app.use(honoMiddleware({ procedures, jobs, transcoder }));

app.get("/", (c) => {
  return c.html(INDEX_HTML);
});

serve({
  fetch: app.fetch,
  port: Number(env.PORT),
});

// Delay bot startup to avoid tsx restart race condition.
// Prisma generate triggers tsx file watcher restarts — this delay
// ensures we only start the bot after the restart cycle settles.
setTimeout(() => {
  startDiscordBot(env.DISCORD_BOT_TOKEN, env.VITE_BASE_URL).catch((err) => {
    console.error("[Discord] Failed to start bot:", err);
  });
}, 8000);
