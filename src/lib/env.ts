import { z } from "zod";

const schema = z.object({
  PORT: z.string(),
  API_KEY: z.string(), // provided by system variables
  DB_FILE_NAME: z.string(),
  GUEST_SERVICES_URL: z.url(),
  VITE_APP_ID: z.string(),
  VITE_BASE_URL: z.url(),
  VITE_ROOT_URL: z.url(),
  VITE_REALTIME_DOMAIN: z.string(),
  VITE_BOX_ID: z.string(),
  VITE_NODE_ENV: z.enum(["development", "production"]).default("production"),
  QUEUE_DB_FILE_NAME: z.string(),
  ERRORS_DB_FILE_NAME: z.string(),
  DISCORD_BOT_TOKEN: z.string(),
  DISCORD_OWNER_ID: z.string().optional(),
  ADAPTIVE_HANDLE: z.string().optional(),
});

const parsed = schema.safeParse(process?.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error);
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;
