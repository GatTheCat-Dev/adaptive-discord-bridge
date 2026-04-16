import {
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import { mcp } from "@adaptive-ai/sdk/server";
import { db } from "@/api/db";
import { env } from "@/lib/env";
import { readFile } from "fs/promises";
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { randomUUID } from "crypto";
import path from "path";

// ---------- constants ----------
// BOT_APP_ID is resolved after login via client.user.id (auto-detected)
let BOT_APP_ID = "";
const STORAGE_DIR = "/home/computer/storage";
// CDN_BASE is derived from VITE_BASE_URL at runtime (e.g. "https://myhandle.adaptive.ai/cdn")
function getCdnBase(): string {
  try {
    // env is imported below after this file loads
    return `${env.VITE_BASE_URL.replace(/\/$/, "")}/cdn`;
  } catch {
    return `${process.env.VITE_BASE_URL?.replace(/\/$/, "") ?? ""}/cdn`;
  }
}
const ADB_MEMORY_DIR = "/home/computer/.memory/adb";
const ADB_INDEX_PATH = `${ADB_MEMORY_DIR}/_index.json`;

// ---------- concurrency guard ----------
// Key format: "user:{userId}" for DMs, "channel:{channelId}" for server channels
const inFlightKeys = new Set<string>();

// ---------- bot state ----------
let botClient: Client | null = null;
let botStartTime: number | null = null;
let activeSessionCount = 0;
let BOT_TOKEN = "";

// ============================================================
// Simple message classifier — DMs only
// ============================================================

const ACTION_WORDS = [
  "check", "build", "send", "create", "update", "show", "look",
  "find", "search", "run", "set", "delete", "remove", "install",
  "deploy", "fix", "help", "tell me about", "describe", "explain",
  "what is", "what are", "how do", "how does", "can you", "could you",
  "please", "make", "add", "change", "open", "read", "write",
];

function isSimpleMessage(content: string): boolean {
  const trimmed = content.toLowerCase().trim();
  if (trimmed.length === 0) return false;
  // Short messages with no question marks or action words → simple chat
  if (trimmed.length < 20 && !trimmed.includes("?")) {
    if (!ACTION_WORDS.some((w) => trimmed.includes(w))) {
      return true;
    }
  }
  return false;
}

// ============================================================
// Discord REST helpers
// ============================================================

async function discordApi(
  apiPath: string,
  options?: { method?: string; body?: Record<string, unknown> },
) {
  const method = options?.method ?? (options?.body ? "POST" : "GET");
  const res = await fetch(`https://discord.com/api/v10${apiPath}`, {
    method,
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[Discord API] ${method} ${apiPath} → ${res.status}: ${text}`);
    return null;
  }
  return res.json();
}

async function sendTyping(channelId: string) {
  await fetch(`https://discord.com/api/v10/channels/${channelId}/typing`, {
    method: "POST",
    headers: { Authorization: `Bot ${BOT_TOKEN}` },
  }).catch(() => {});
}

async function sendDiscordMessage(
  channelId: string,
  content: string,
  options?: { replyToId?: string; embeds?: DiscordEmbed[] },
) {
  const body: Record<string, unknown> = {};
  if (content) body.content = content;
  if (options?.replyToId) {
    body.message_reference = { message_id: options.replyToId };
  }
  if (options?.embeds?.length) {
    body.embeds = options.embeds;
  }
  return discordApi(`/channels/${channelId}/messages`, { body }) as Promise<{ id?: string } | null>;
}

interface DiscordEmbed {
  image?: { url: string };
  description?: string;
}

/** Send file attachments to a Discord channel via multipart/form-data */
async function sendDiscordFiles(
  channelId: string,
  filePaths: string[],
  content?: string,
): Promise<{ id?: string } | null> {
  const formData = new FormData();

  // Add payload_json with optional text content
  const payload: Record<string, unknown> = {};
  if (content) payload.content = content;
  formData.append("payload_json", JSON.stringify(payload));

  // Add each file
  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i];
    try {
      const fileBuffer = readFileSync(filePath);
      const fileName = path.basename(filePath);
      const blob = new Blob([fileBuffer]);
      formData.append(`files[${i}]`, blob, fileName);
    } catch (err) {
      console.error(`[Discord] Failed to read file ${filePath}:`, err);
    }
  }

  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
      },
      body: formData,
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[Discord API] POST /channels/${channelId}/messages (file) → ${res.status}: ${text}`);
      return null;
    }

    return await res.json() as { id?: string };
  } catch (err) {
    console.error("[Discord] Failed to send file:", err);
    return null;
  }
}

// ============================================================
// Name resolution cache
// ============================================================

const nameCache = new Map<string, { name: string; expiry: number }>();
const NAME_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function getGuildName(guildId: string): Promise<string> {
  const cached = nameCache.get(`guild:${guildId}`);
  if (cached && cached.expiry > Date.now()) return cached.name;

  const guild = await discordApi(`/guilds/${guildId}`) as { name: string } | null;
  const name = guild?.name ?? `guild-${guildId}`;
  nameCache.set(`guild:${guildId}`, { name, expiry: Date.now() + NAME_CACHE_TTL });
  return name;
}

async function getChannelName(channelId: string): Promise<string> {
  const cached = nameCache.get(`channel:${channelId}`);
  if (cached && cached.expiry > Date.now()) return cached.name;

  const channel = await discordApi(`/channels/${channelId}`) as { name?: string } | null;
  const name = channel?.name ?? `channel-${channelId}`;
  nameCache.set(`channel:${channelId}`, { name, expiry: Date.now() + NAME_CACHE_TTL });
  return name;
}

// ============================================================
// Slugify
// ============================================================

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "unknown";
}

// ============================================================
// _index.json read/write
// ============================================================

interface AdbIndex {
  guilds: Record<string, string>;
  channels: Record<string, { guild: string; slug: string }>;
}

function readIndex(): AdbIndex {
  try {
    if (!existsSync(ADB_INDEX_PATH)) return { guilds: {}, channels: {} };
    return JSON.parse(readFileSync(ADB_INDEX_PATH, "utf-8")) as AdbIndex;
  } catch {
    return { guilds: {}, channels: {} };
  }
}

function writeIndex(index: AdbIndex): void {
  writeFileSync(ADB_INDEX_PATH, JSON.stringify(index, null, 2));
}

// ============================================================
// Channel memory file templates
// ============================================================

function serverTemplate(guildName: string, guildId: string): string {
  return `# ${guildName}

## Server Info
- Discord ID: ${guildId}
- First interaction: ${new Date().toISOString().split("T")[0]}

## Active Channels
`;
}

function channelTemplate(channelName: string, serverName: string): string {
  return `# #${channelName} — ${serverName}

## Key Decisions
(none yet)

## Current Focus
(new channel — context will build as conversations happen)

## Active Participants
(none yet)

## Notes
- ${new Date().toISOString().split("T")[0]}: Channel first interacted with ADB
`;
}

function appendToServerIndex(serverFilePath: string, channelName: string, channelSlug: string): void {
  try {
    const existing = readFileSync(serverFilePath, "utf-8");
    writeFileSync(serverFilePath, existing + `- #${channelName} → ${channelSlug}.md\n`);
  } catch {
    // ignore if file doesn't exist yet
  }
}

// ============================================================
// ensureChannelMemory — auto-register server + channel
// ============================================================

async function ensureChannelMemory(guildId: string, channelId: string): Promise<string> {
  const index = readIndex();

  // Ensure ADB memory dir exists
  if (!existsSync(ADB_MEMORY_DIR)) {
    mkdirSync(ADB_MEMORY_DIR, { recursive: true });
  }

  // Resolve server
  let serverSlug = index.guilds[guildId];
  if (!serverSlug) {
    const guildName = await getGuildName(guildId);
    serverSlug = slugify(guildName);
    const serverDir = `${ADB_MEMORY_DIR}/${serverSlug}`;
    if (!existsSync(serverDir)) {
      mkdirSync(serverDir, { recursive: true });
    }
    writeFileSync(`${serverDir}/_server.md`, serverTemplate(guildName, guildId));
    index.guilds[guildId] = serverSlug;
    writeIndex(index);
    console.log(`[ADB] Registered new server: ${guildName} → ${serverSlug}/`);
  }

  // Resolve channel
  let channelEntry = index.channels[channelId];
  if (!channelEntry) {
    const channelName = await getChannelName(channelId);
    const channelSlug = slugify(channelName);
    const serverDir = `${ADB_MEMORY_DIR}/${serverSlug}`;
    const channelFile = `${serverDir}/${channelSlug}.md`;
    writeFileSync(channelFile, channelTemplate(channelName, serverSlug));
    appendToServerIndex(`${serverDir}/_server.md`, channelName, channelSlug);
    index.channels[channelId] = { guild: guildId, slug: channelSlug };
    writeIndex(index);
    console.log(`[ADB] Registered new channel: #${channelName} → ${serverSlug}/${channelSlug}.md`);
    channelEntry = index.channels[channelId];
  }

  return `${ADB_MEMORY_DIR}/${serverSlug}/${channelEntry.slug}.md`;
}

// ============================================================
// fetchChannelHistory — pull recent messages from Discord API
// ============================================================

interface DiscordApiMessage {
  id: string;
  content: string;
  author: { id: string; username: string; bot?: boolean };
  type: number; // 0 = default, 19 = reply, etc.
}

async function fetchChannelHistory(channelId: string, limit = 50): Promise<{ history: string; participants: string[] }> {
  const messages = await discordApi(`/channels/${channelId}/messages?limit=${limit}`) as DiscordApiMessage[] | null;

  if (!messages || messages.length === 0) {
    return { history: "(no messages yet)", participants: [] };
  }

  // Reverse to get chronological order (API returns newest first)
  const chronological = [...messages].reverse();

  const participantSet = new Set<string>();
  const lines: string[] = [];

  for (const msg of chronological) {
    // Skip system messages (type > 0 and not reply type 19)
    if (msg.type !== 0 && msg.type !== 19) continue;
    // Skip empty messages
    if (!msg.content?.trim()) continue;

    const isBot = msg.author.id === BOT_APP_ID || msg.author.bot;
    const displayName = isBot ? "Adaptive" : msg.author.username;

    if (!isBot) participantSet.add(msg.author.username);

    lines.push(`${displayName}: ${msg.content.trim()}`);
  }

  return {
    history: lines.length > 0 ? lines.join("\n") : "(no messages yet)",
    participants: Array.from(participantSet),
  };
}

// ============================================================
// Public status
// ============================================================

export function getBotStatus() {
  return {
    connected: botClient?.isReady() ?? false,
    uptime: botStartTime ? Math.floor((Date.now() - botStartTime) / 1000) : 0,
    activeSessions: activeSessionCount,
    username: botClient?.user?.tag ?? null,
  };
}

// ============================================================
// Proactive DM sending (callable from any agent/RPC)
// ============================================================

export async function sendDM(input: {
  userId: string;
  message: string;
  imageUrls?: string[];
}): Promise<{ success: boolean; error?: string }> {
  if (!BOT_TOKEN) {
    return { success: false, error: "Bot not initialized" };
  }

  try {
    const channel = await discordApi("/users/@me/channels", {
      body: { recipient_id: input.userId },
    }) as { id: string } | null;

    if (!channel?.id) {
      return { success: false, error: "Could not open DM channel" };
    }

    if (input.message) {
      const chunks = splitMessage(input.message);
      for (const chunk of chunks) {
        await sendDiscordMessage(channel.id, chunk);
      }
    }

    if (input.imageUrls?.length) {
      const embeds: DiscordEmbed[] = input.imageUrls.map((url) => ({
        image: { url },
      }));
      await sendDiscordMessage(channel.id, "", { embeds });
    }

    console.log(`[Discord] Proactive DM sent to ${input.userId}: ${input.message.slice(0, 80)}...`);
    return { success: true };
  } catch (err) {
    console.error("[Discord] Failed to send proactive DM:", err);
    return { success: false, error: String(err) };
  }
}

// ============================================================
// Message splitting (Discord 2000 char limit)
// ============================================================

function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= 2000) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", 2000);
    if (splitAt < 1000) splitAt = remaining.lastIndexOf(" ", 2000);
    if (splitAt < 1000) splitAt = 2000;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

// ============================================================
// Memory loading (global context — used by both paths)
// ============================================================

let cachedMemory: string | null = null;
let memoryCacheTime = 0;
const MEMORY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function loadMemoryContext(): Promise<string> {
  if (cachedMemory && Date.now() - memoryCacheTime < MEMORY_CACHE_TTL) {
    return cachedMemory;
  }

  const parts: string[] = [];

  try {
    const discordCap = await readFile(
      "/home/computer/.memory/capabilities/discord-bridge.md",
      "utf-8",
    );
    parts.push(`Discord Bridge Notes:\n${discordCap}`);
  } catch {
    // not available yet
  }

  const handle = env.ADAPTIVE_HANDLE ?? "the owner";
  parts.push(`User Context: The user's Adaptive handle is "${handle}". Communication style: mirror the user's tone — casual, brief, no emojis unless they use them.`);

  cachedMemory = parts.join("\n\n");
  memoryCacheTime = Date.now();
  return cachedMemory;
}

// ============================================================
// Conversation history — DMs only (DB-persisted)
// ============================================================

async function getConversationHistory(
  discordUserId: string,
  limit = 8,
): Promise<string> {
  const messages = await db.discordMessage.findMany({
    where: { discordUserId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  if (messages.length === 0) return "(no prior Discord conversation)";

  const chronological = messages.reverse();
  return chronological
    .map((m) => {
      const prefix = m.role === "user" ? "User" : "Adaptive";
      return `${prefix}: ${m.content}`;
    })
    .join("\n");
}

async function saveMessage(
  discordUserId: string,
  discordUsername: string,
  role: "user" | "assistant",
  content: string,
  discordMessageId?: string,
) {
  await db.discordMessage.create({
    data: {
      discordUserId,
      discordUsername,
      role,
      content,
      discordMessageId,
    },
  });
}

// ============================================================
// Image handling
// ============================================================

interface RawAttachment {
  id: string;
  filename: string;
  url: string;
  proxy_url: string;
  content_type?: string;
  size: number;
}

function extractImageUrls(attachments?: RawAttachment[]): string[] {
  if (!attachments?.length) return [];
  return attachments
    .filter((a) => a.content_type?.startsWith("image/"))
    .map((a) => a.proxy_url || a.url);
}

async function downloadToStorage(imageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    const ext = imageUrl.match(/\.(png|jpg|jpeg|gif|webp)/i)?.[1] ?? "png";
    const filename = `discord-${randomUUID()}.${ext}`;
    writeFileSync(path.join(STORAGE_DIR, filename), buffer);
    return `${getCdnBase()}/${filename}`;
  } catch (err) {
    console.error("[Discord] Failed to download image:", err);
    return null;
  }
}

// ============================================================
// Raw gateway event shape
// ============================================================

interface RawMessageData {
  id: string;
  channel_id: string;
  guild_id?: string | null;
  author: {
    id: string;
    username: string;
    bot?: boolean;
  };
  content: string;
  attachments?: RawAttachment[];
  mentions?: { id: string }[];
}

// ============================================================
// Should we respond to this message?
// ============================================================

function shouldRespond(d: RawMessageData): boolean {
  if (d.author.bot) return false;
  if (!d.guild_id) return true; // DMs — always respond
  if (d.mentions?.some((m) => m.id === BOT_APP_ID)) return true; // server — only on @mention
  return false;
}

function getChannel(d: RawMessageData): "dm" | "server" {
  return d.guild_id ? "server" : "dm";
}

function cleanContent(content: string): string {
  return content
    .replace(new RegExp(`<@!?${BOT_APP_ID}>`, "g"), "")
    .trim();
}

// ============================================================
// Core message handler
// ============================================================

async function handleRawMessage(d: RawMessageData) {
  if (!shouldRespond(d)) return;

  const channel = getChannel(d);
  const rawContent = d.content.trim();
  const content = channel === "server" ? cleanContent(rawContent) : rawContent;
  const imageUrls = extractImageUrls(d.attachments);

  if (!content && imageUrls.length === 0) return;

  const userId = d.author.id;
  const username = d.author.username;
  const channelId = d.channel_id;
  const guildId = d.guild_id ?? null;
  const discordMessageId = d.id;

  console.log(
    `[Discord] ${channel === "dm" ? "DM" : "Server mention"} from ${username} (${userId}): ${content || "(image only)"}${imageUrls.length ? ` [${imageUrls.length} image(s)]` : ""}`,
  );

  // ============================================================
  // SERVER CHANNEL PATH
  // ============================================================
  if (channel === "server" && guildId) {
    const inFlightKey = `channel:${channelId}`;

    if (inFlightKeys.has(inFlightKey)) {
      console.log(`[Discord] Skipping agent call for channel ${channelId} — already processing`);
      return;
    }
    inFlightKeys.add(inFlightKey);
    activeSessionCount++;

    await sendTyping(channelId);
    const typingInterval = setInterval(() => sendTyping(channelId), 8000);

    try {
      // Auto-register server/channel, get channel memory file path
      const channelMemoryPath = await ensureChannelMemory(guildId, channelId);

      // Fetch live channel history from Discord API
      const { history: channelHistory, participants } = await fetchChannelHistory(channelId, 50);

      // Read channel memory file
      let channelMemory = "(no channel memory yet)";
      try {
        channelMemory = readFileSync(channelMemoryPath, "utf-8");
      } catch {
        // file may not exist yet on very first interaction
      }

      // Load global memory context
      const memoryContext = await loadMemoryContext();

      // Resolve server/channel names for the prompt (cached)
      const guildName = await getGuildName(guildId);
      const channelName = await getChannelName(channelId);

      // Download images to storage so the agent can access them
      let imageContext = "";
      if (imageUrls.length > 0) {
        const storedUrls: string[] = [];
        for (const url of imageUrls) {
          const stored = await downloadToStorage(url);
          if (stored) storedUrls.push(stored);
        }
        if (storedUrls.length > 0) {
          imageContext = `\nThe user sent ${storedUrls.length} image(s):\n${storedUrls.map((u, i) => `- Image ${i + 1}: ${u}`).join("\n")}\nYou can view/analyze these images.`;
        }
      }

      const participantList = participants.length > 0
        ? participants.join(", ")
        : username;

      const serverDir = `${ADB_MEMORY_DIR}/${slugify(guildName)}`;

      const { response } = await mcp.promptAgent({
        message: `You are the user's Adaptive agent, responding through Discord. You are NOT a separate bot or personality — you are the same agent they talk to on adaptive.ai, just on a different channel. You have full access to the Adaptive computer: memory, tools, apps, integrations, everything.

CHANNEL: #${channelName} (in Server: ${guildName})
Triggered by: ${username} (Discord user ID: ${userId})
Participants in recent history: ${participantList}

${memoryContext}

=== Channel Memory ===
${channelMemory}

=== Recent Messages (last 50) ===
${channelHistory}
${imageContext}

Instructions:
- Respond naturally and conversationally. This is Discord, not a document.
- Keep messages concise. No markdown headers. Use bold/italic sparingly.
- This is a server channel where you were @mentioned. Others can see your response.
- You can see messages from all participants — not just the person who mentioned you. Use that context.
- If they ask you to do something on the computer (build, check, update, etc.), do it.
- If the user sent images, you can analyze them.
- If you want to send an image in your response, include the full CDN URL in your reply text, or add it to imageUrls to send as an embed.
- To send files (images, PDFs, code files, etc.) as downloadable attachments, save them to /home/computer/storage/ and include the full file path in the filePaths array.
- Other channel memory files for this server are available at ${serverDir}/. If the user references a discussion from another channel, read that channel's .md file.
- When important decisions, topic shifts, or notable outcomes occur in this conversation, update the channel memory file at ${channelMemoryPath}.

User's latest message: ${content || "(sent image(s) with no text)"}`,
        outputJsonSchema: {
          type: "object" as const,
          properties: {
            reply: {
              type: "string",
              description: "Your response. Keep it natural and Discord-appropriate. No markdown headers.",
            },
            imageUrls: {
              type: "array",
              items: { type: "string" },
              description: "Optional. CDN or public image URLs to send as inline image embeds.",
            },
            filePaths: {
              type: "array",
              items: { type: "string" },
              description: "Optional. Absolute file paths on the computer (e.g. /home/computer/storage/report.pdf) to send as downloadable Discord attachments.",
            },
          },
          required: ["reply"],
        },
      });

      const data = response as { reply?: string; imageUrls?: string[]; filePaths?: string[] };
      const reply = data?.reply ?? "Something went wrong. Try again?";
      const responseImageUrls = data?.imageUrls ?? [];
      const responseFilePaths = data?.filePaths ?? [];

      const chunks = splitMessage(reply);
      for (let i = 0; i < chunks.length; i++) {
        await sendDiscordMessage(channelId, chunks[i], {
          replyToId: i === 0 ? discordMessageId : undefined,
        });
      }

      if (responseImageUrls.length > 0) {
        const embeds: DiscordEmbed[] = responseImageUrls.map((url) => ({
          image: { url },
        }));
        await sendDiscordMessage(channelId, "", { embeds });
      }

      if (responseFilePaths.length > 0) {
        const validPaths = responseFilePaths.filter((fp) => existsSync(fp));
        if (validPaths.length > 0) {
          await sendDiscordFiles(channelId, validPaths);
        }
      }

    } catch (err) {
      console.error("[Discord] Error handling server message:", err);
      await sendDiscordMessage(channelId, "Hit a snag processing that. Give me a sec and try again.");
    } finally {
      clearInterval(typingInterval);
      inFlightKeys.delete(inFlightKey);
      activeSessionCount--;
    }

    return;
  }

  // ============================================================
  // DM PATH (unchanged from v1)
  // ============================================================

  const inFlightKey = `user:${userId}`;

  // Build the user message text (for DB and prompt)
  let userMessageText = content;
  if (imageUrls.length > 0) {
    const imageNote = imageUrls.map((url, i) => `[Image ${i + 1}: ${url}]`).join(" ");
    userMessageText = content ? `${content}\n${imageNote}` : imageNote;
  }

  // Save user message to DB
  await saveMessage(userId, username, "user", userMessageText, discordMessageId);

  if (inFlightKeys.has(inFlightKey)) {
    console.log(`[Discord] Skipping agent call for ${username} — already processing`);
    return;
  }
  inFlightKeys.add(inFlightKey);
  activeSessionCount++;

  await sendTyping(channelId);
  const typingInterval = setInterval(() => sendTyping(channelId), 8000);

  try {
    // ---- SIMPLE MESSAGE PATH (DMs only) ----
    if (isSimpleMessage(content) && imageUrls.length === 0) {
      const conversationHistory = await getConversationHistory(userId, 5);

      const { response } = await mcp.promptAgent({
        message: `You're chatting with a user on Discord. Keep it super brief and casual — 1-2 sentences max. No tools needed, just reply conversationally. Mirror their tone.

User: ${username}
Recent chat:
${conversationHistory}

Their message: ${content}`,
        outputJsonSchema: {
          type: "object" as const,
          properties: {
            reply: {
              type: "string",
              description: "Brief, casual Discord reply. 1-2 sentences max.",
            },
          },
          required: ["reply"],
        },
      });

      const data = response as { reply?: string };
      const reply = data?.reply ?? "yo 👋";

      const result = await sendDiscordMessage(channelId, reply, {
        replyToId: discordMessageId,
      });
      await saveMessage(userId, username, "assistant", reply, result?.id);
      return;
    }

    // ---- FULL DM PATH (with tools + context) ----
    const [memoryContext, conversationHistory] = await Promise.all([
      loadMemoryContext(),
      getConversationHistory(userId, 8),
    ]);

    let imageContext = "";
    if (imageUrls.length > 0) {
      const storedUrls: string[] = [];
      for (const url of imageUrls) {
        const stored = await downloadToStorage(url);
        if (stored) storedUrls.push(stored);
      }
      if (storedUrls.length > 0) {
        imageContext = `\nThe user sent ${storedUrls.length} image(s):\n${storedUrls.map((u, i) => `- Image ${i + 1}: ${u}`).join("\n")}\nYou can view/analyze these images. They are stored on the computer at the CDN URLs above.`;
      }
    }

    const { response } = await mcp.promptAgent({
      message: `You are the user's Adaptive agent, responding through Discord. You are NOT a separate bot or personality — you are the same agent they talk to on adaptive.ai, just on a different channel. You have full access to the Adaptive computer: memory, tools, apps, integrations, everything.

CHANNEL: Discord DM
The user messaging you:
- Adaptive handle: ${env.ADAPTIVE_HANDLE ?? "the owner"}
- Discord username: ${username}
- Discord user ID: ${userId}

${memoryContext}

=== Discord Conversation History ===
${conversationHistory}
${imageContext}

Instructions:
- Respond naturally and conversationally. This is Discord, not a document.
- Keep messages concise. No markdown headers. Use bold/italic sparingly.
- If they ask you to do something on the computer (build, check, update, etc.), do it.
- If they ask about their apps, calendar, email, or anything you have access to, help them.
- You have continuity from the conversation history above. Reference past messages when relevant.
- If the user sent images, you can analyze them.
- If you want to send an image in your response, include the full CDN URL in your reply text, or add it to imageUrls to send as an embed.
- To send files (images, PDFs, code files, etc.) as downloadable attachments, save them to /home/computer/storage/ and include the full file path in the filePaths array.

User's latest message: ${content || "(sent image(s) with no text)"}`,
      outputJsonSchema: {
        type: "object" as const,
        properties: {
          reply: {
            type: "string",
            description: "Your response to the user. Keep it natural and Discord-appropriate. No markdown headers.",
          },
          imageUrls: {
            type: "array",
            items: { type: "string" },
            description: "Optional. Array of image URLs to send as inline image embeds.",
          },
          filePaths: {
            type: "array",
            items: { type: "string" },
            description: "Optional. Absolute file paths on the computer (e.g. /home/computer/storage/report.pdf) to send as downloadable Discord attachments.",
          },
        },
        required: ["reply"],
      },
    });

    const data = response as { reply?: string; imageUrls?: string[]; filePaths?: string[] };
    const reply = data?.reply ?? "Something went wrong processing that. Try again?";
    const responseImageUrls = data?.imageUrls ?? [];
    const responseFilePaths = data?.filePaths ?? [];

    const chunks = splitMessage(reply);
    let firstSentId: string | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const result = await sendDiscordMessage(channelId, chunks[i], {
        replyToId: i === 0 ? discordMessageId : undefined,
      });
      if (i === 0 && result?.id) firstSentId = result.id;
    }

    if (responseImageUrls.length > 0) {
      const embeds: DiscordEmbed[] = responseImageUrls.map((url) => ({
        image: { url },
      }));
      await sendDiscordMessage(channelId, "", { embeds });
    }

    if (responseFilePaths.length > 0) {
      const validPaths = responseFilePaths.filter((fp) => existsSync(fp));
      if (validPaths.length > 0) {
        await sendDiscordFiles(channelId, validPaths);
      }
    }

    const savedReply = responseImageUrls.length > 0
      ? `${reply}\n${responseImageUrls.map((u) => `[Sent image: ${u}]`).join(" ")}`
      : reply;
    await saveMessage(userId, username, "assistant", savedReply, firstSentId);

  } catch (err) {
    console.error("[Discord] Error handling DM:", err);
    await sendDiscordMessage(channelId, "Hit a snag processing that. Give me a sec and try again.");
  } finally {
    clearInterval(typingInterval);
    inFlightKeys.delete(inFlightKey);
    activeSessionCount--;
  }
}

// ============================================================
// Rename handlers — GUILD_UPDATE / CHANNEL_UPDATE
// ============================================================

function updateServerIndexChannelSlug(serverDir: string, oldSlug: string, newSlug: string, newName: string): void {
  const serverFilePath = `${serverDir}/_server.md`;
  try {
    const content = readFileSync(serverFilePath, "utf-8");
    const updated = content.replace(
      new RegExp(`- #[^\\n]* → ${oldSlug}\\.md`, "g"),
      `- #${newName} → ${newSlug}.md`,
    );
    writeFileSync(serverFilePath, updated);
  } catch {
    // ignore if file not found
  }
}

function handleGuildRename(guildId: string, newName: string): void {
  const index = readIndex();
  const oldSlug = index.guilds[guildId];
  if (!oldSlug) return; // server not tracked

  const newSlug = slugify(newName);
  if (oldSlug === newSlug) return; // slug unchanged

  const oldPath = `${ADB_MEMORY_DIR}/${oldSlug}`;
  const newPath = `${ADB_MEMORY_DIR}/${newSlug}`;

  if (!existsSync(oldPath)) return;

  try {
    renameSync(oldPath, newPath);
    index.guilds[guildId] = newSlug;
    writeIndex(index);
    nameCache.set(`guild:${guildId}`, { name: newName, expiry: Date.now() + NAME_CACHE_TTL });
    console.log(`[ADB] Server renamed: ${oldSlug}/ → ${newSlug}/`);
  } catch (err) {
    console.error(`[ADB] Failed to rename server folder:`, err);
  }
}

function handleChannelRename(channelId: string, guildId: string, newName: string): void {
  const index = readIndex();
  const channelEntry = index.channels[channelId];
  if (!channelEntry) return; // channel not tracked

  const newSlug = slugify(newName);
  if (channelEntry.slug === newSlug) return; // slug unchanged

  const serverSlug = index.guilds[guildId];
  if (!serverSlug) return; // server not tracked

  const serverDir = `${ADB_MEMORY_DIR}/${serverSlug}`;
  const oldFile = `${serverDir}/${channelEntry.slug}.md`;
  const newFile = `${serverDir}/${newSlug}.md`;

  if (!existsSync(oldFile)) return;

  try {
    renameSync(oldFile, newFile);
    updateServerIndexChannelSlug(serverDir, channelEntry.slug, newSlug, newName);
    index.channels[channelId] = { guild: guildId, slug: newSlug };
    writeIndex(index);
    nameCache.set(`channel:${channelId}`, { name: newName, expiry: Date.now() + NAME_CACHE_TTL });
    console.log(`[ADB] Channel renamed: ${channelEntry.slug}.md → ${newSlug}.md`);
  } catch (err) {
    console.error(`[ADB] Failed to rename channel file:`, err);
  }
}

// ============================================================
// Keep-alive self-ping
// ============================================================

function startKeepAlive() {
  const localUrl = `http://localhost:${env.PORT}`;
  const ping = async () => {
    try {
      const res = await fetch(localUrl);
      if (!res.ok) throw new Error(`status ${res.status}`);
    } catch (err) {
      console.warn(`[Keep-Alive] Ping failed: ${err}. Retrying in 10s...`);
      setTimeout(async () => {
        try {
          await fetch(localUrl);
        } catch (retryErr) {
          console.error(`[Keep-Alive] Retry also failed: ${retryErr}`);
        }
      }, 10_000);
    }
  };
  setInterval(ping, 2 * 60 * 1000);
  console.log(`[Keep-Alive] Pinging ${localUrl} every 2 minutes`);
}

// ============================================================
// Main bot startup
// ============================================================

export async function startDiscordBot(token: string) {
  BOT_TOKEN = token;

  process.on("unhandledRejection", (reason) => {
    console.error("[Discord] Unhandled rejection:", reason);
  });

  process.on("uncaughtException", (err) => {
    console.error("[Discord] Uncaught exception:", err);
    // Don't exit — let the bot try to keep running
  });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.once("ready", (c) => {
    BOT_APP_ID = c.user.id; // auto-detect — no hardcoding needed
    console.log(`[Discord] Logged in as ${c.user.tag} (ID: ${c.user.id})`);
    console.log(`[Discord] Bot ready. Listening for DMs + @mentions.`);
    botStartTime = Date.now();
  });

  client.on("error", (err) => {
    console.error("[Discord] Client error:", err.message);
  });

  client.on("shardDisconnect", (event, shardId) => {
    console.warn(`[Discord] Shard ${shardId} disconnected (code ${event.code}). discord.js will attempt reconnection.`);
  });

  client.on("shardReconnecting", (shardId) => {
    console.log(`[Discord] Shard ${shardId} reconnecting...`);
  });

  client.on("shardResume", (shardId, replayedEvents) => {
    console.log(`[Discord] Shard ${shardId} resumed. Replayed ${replayedEvents} events.`);
  });

  client.on("shardError", (err, shardId) => {
    console.error(`[Discord] Shard ${shardId} error:`, err.message);
  });

  client.on("raw", (packet: { t: string; d?: unknown }) => {
    if (packet.t === "MESSAGE_CREATE" && packet.d) {
      handleRawMessage(packet.d as RawMessageData).catch((err) => {
        console.error("[Discord] Error in raw message handler:", err);
      });
    }

    // Rename handling
    if (packet.t === "GUILD_UPDATE" && packet.d) {
      const d = packet.d as { id: string; name: string };
      handleGuildRename(d.id, d.name);
    }

    if (packet.t === "CHANNEL_UPDATE" && packet.d) {
      const d = packet.d as { id: string; guild_id?: string; name?: string };
      if (d.guild_id && d.name) {
        handleChannelRename(d.id, d.guild_id, d.name);
      }
    }
  });

  await client.login(token);
  console.log(`[Discord] Bot login initiated.`);

  botClient = client;
  startKeepAlive();

  const shutdown = () => {
    console.log("[Discord] Shutting down bot...");
    client.destroy();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return client;
}
