import { db } from "@/api/db";
import { env } from "@/lib/env";
import { getBotStatus, sendDM } from "@/bot/discord-bot";

export async function health() {
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    db: await db.$queryRaw`SELECT 1 as result`
      .then(() => "connected")
      .catch(() => "disconnected"),
    env: env.VITE_NODE_ENV,
  };
}

export async function botStatus() {
  return getBotStatus();
}

/**
 * Send a message to a Discord user's DMs.
 * Callable by any agent or RPC consumer on this computer.
 *
 * userId is required. Set DISCORD_OWNER_ID in .env to enable owner-targeted agent calls.
 */
export async function sendToDiscord(input: {
  message: string;
  userId?: string;
  imageUrls?: string[];
}) {
  const userId = input.userId ?? env.DISCORD_OWNER_ID;
  if (!userId) {
    return { success: false, error: "No userId provided and DISCORD_OWNER_ID is not set in environment." };
  }
  return sendDM({
    userId,
    message: input.message,
    imageUrls: input.imageUrls,
  });
}

/**
 * Get recent Discord conversation history for a user.
 */
export async function getDiscordHistory(input?: {
  userId?: string;
  limit?: number;
}) {
  const userId = input?.userId ?? env.DISCORD_OWNER_ID;
  if (!userId) {
    return [];
  }
  const limit = input?.limit ?? 20;

  const messages = await db.discordMessage.findMany({
    where: { discordUserId: userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return messages.reverse().map((m) => ({
    role: m.role,
    content: m.content,
    timestamp: m.createdAt.toISOString(),
  }));
}
