import {
  getQueue,
  type Job,
  type QueueHandlers,
} from "@adaptive-ai/sdk/server";

// Define all job handlers here
export const jobs = {
  debug: async (payload: { info: string }, job: Job) => {
    console.debug(`Debug handler info: ${payload.info}, job id: ${job.id}`);
  },
} satisfies QueueHandlers;

export const queue = getQueue<typeof jobs>();
