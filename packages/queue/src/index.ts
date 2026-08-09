import { Queue, type JobsOptions } from "bullmq";
import IORedis from "ioredis";
import { z } from "zod";

export const MEDIA_PROCESSING_QUEUE = "media-processing";

export const mediaProcessingJobSchema = z.object({
  recordingId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sourceObjectKey: z.string().min(1).max(1024),
  processingVersion: z.number().int().positive(),
});

export type MediaProcessingJob = z.infer<typeof mediaProcessingJobSchema>;

export function mediaProcessingJobId(
  recordingId: string,
  processingVersion: number,
): string {
  return `recording:${recordingId}:v${processingVersion}`;
}

export function createRedisConnection(redisUrl: string): IORedis {
  return new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

export function createMediaProcessingQueue(
  connection: IORedis,
): Queue<MediaProcessingJob> {
  return new Queue<MediaProcessingJob>(MEDIA_PROCESSING_QUEUE, { connection });
}

export function mediaProcessingJobOptions(
  recordingId: string,
  processingVersion: number,
): JobsOptions {
  return {
    jobId: mediaProcessingJobId(recordingId, processingVersion),
    attempts: 4,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { age: 7 * 24 * 60 * 60, count: 10_000 },
    removeOnFail: { age: 30 * 24 * 60 * 60, count: 10_000 },
  };
}
