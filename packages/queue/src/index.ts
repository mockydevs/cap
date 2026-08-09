import { Queue, type JobsOptions } from "bullmq";
import IORedis from "ioredis";
import { z } from "zod";
import { aiJobSchema, type AiJob } from "@cap/ai";

export const MEDIA_PROCESSING_QUEUE = "media-processing";
export const TRANSCRIPTION_QUEUE = "transcription";
export const RENDER_QUEUE = "render";
export const AI_QUEUE = "ai";
export { aiJobSchema, type AiJob };
export const renderJobSchema = z.object({
  renderJobId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  projectId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
});
export type RenderJob = z.infer<typeof renderJobSchema>;

export const mediaProcessingJobSchema = z.object({
  recordingId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sourceObjectKey: z.string().min(1).max(1024),
  processingVersion: z.number().int().positive(),
});

export type MediaProcessingJob = z.infer<typeof mediaProcessingJobSchema>;
export const transcriptionJobSchema = mediaProcessingJobSchema
  .pick({ recordingId: true, workspaceId: true, processingVersion: true })
  .extend({ sourceObjectKey: z.string().min(1).max(1024) });
export type TranscriptionJob = z.infer<typeof transcriptionJobSchema>;

export function mediaProcessingJobId(
  recordingId: string,
  processingVersion: number,
): string {
  return `recording:${recordingId}:v${processingVersion}`;
}
export function createTranscriptionQueue(
  connection: IORedis,
): Queue<TranscriptionJob> {
  return new Queue<TranscriptionJob>(TRANSCRIPTION_QUEUE, { connection });
}
export function createRenderQueue(connection: IORedis): Queue<RenderJob> {
  return new Queue<RenderJob>(RENDER_QUEUE, { connection });
}
export function createAiQueue(connection: IORedis): Queue<AiJob> {
  return new Queue<AiJob>(AI_QUEUE, { connection });
}
export function aiJobOptions(jobId: string): JobsOptions {
  return {
    jobId: `ai:${jobId}`,
    attempts: 4,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { age: 604_800 },
    removeOnFail: { age: 2_592_000 },
  };
}
export function renderJobOptions(renderJobId: string): JobsOptions {
  return {
    jobId: `render:${renderJobId}`,
    attempts: 3,
    backoff: { type: "exponential", delay: 15_000 },
    removeOnComplete: { age: 604_800 },
    removeOnFail: { age: 2_592_000 },
  };
}
export function transcriptionJobOptions(
  recordingId: string,
  processingVersion: number,
): JobsOptions {
  return {
    jobId: `transcription:${recordingId}:v${processingVersion}`,
    attempts: 5,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { age: 604_800 },
    removeOnFail: { age: 2_592_000 },
  };
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
