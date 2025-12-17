import { v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
  internalAction,
} from "./_generated/server";
import { internal } from "./_generated/api";

const TTL_DAYS = 7;
const MAX_RETRIES = 2;

function normalizePrompt(raw: string): string {
  let normalized = raw.trim();
  if (!normalized) return "";

  const patterns = [
    /^(remove|erase|delete|get rid of|filter out|take out)\s+/i,
    /^(the|a|an)\s+/i,
  ];
  for (const pattern of patterns) {
    normalized = normalized.replace(pattern, "");
  }

  return normalized.toLowerCase().trim();
}

function validateAnchors(
  anchors: Array<{ kind: string; start: number; end: number }>
) {
  const MIN_DURATION = 0.25;
  const MAX_DURATION = 5.0;
  const MAX_ANCHORS = 6;

  if (anchors.length > MAX_ANCHORS) {
    throw new Error(`Too many anchors (max ${MAX_ANCHORS})`);
  }

  for (const anchor of anchors) {
    if (anchor.end <= anchor.start) {
      throw new Error("Anchor end must be after start");
    }
    const duration = anchor.end - anchor.start;
    if (duration < MIN_DURATION) {
      throw new Error(`Anchor too short (min ${MIN_DURATION}s)`);
    }
    if (duration > MAX_DURATION) {
      throw new Error(`Anchor too long (max ${MAX_DURATION}s)`);
    }
  }
}

// ============================================================================
// PUBLIC MUTATIONS
// ============================================================================

export const create = mutation({
  args: {
    sessionId: v.string(),
    inputObjectKey: v.string(),
    inputFilename: v.string(),
    inputSizeBytes: v.number(),
    inputContentType: v.string(),
    inputKind: v.union(v.literal("audio"), v.literal("video")),
  },
  handler: async (ctx, args) => {
    const expiresAt = Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000;

    const jobId = await ctx.db.insert("jobs", {
      status: "created",
      sessionId: args.sessionId,
      inputKind: args.inputKind,
      inputObjectKey: args.inputObjectKey,
      inputFilename: args.inputFilename,
      inputSizeBytes: args.inputSizeBytes,
      inputContentType: args.inputContentType,
      anchors: [],
      expiresAt,
    });

    return jobId;
  },
});

export const setPromptAndRun = mutation({
  args: {
    jobId: v.id("jobs"),
    sessionId: v.string(),
    promptRaw: v.string(),
    anchors: v.array(
      v.object({
        kind: v.union(v.literal("present"), v.literal("absent")),
        start: v.number(),
        end: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Job not found");
    if (job.sessionId !== args.sessionId) throw new Error("Access denied");
    if (job.status !== "created" && job.status !== "failed") {
      throw new Error(`Cannot run job in ${job.status} state`);
    }

    if (!args.promptRaw.trim()) throw new Error("Prompt is required");
    validateAnchors(args.anchors);

    const promptNormalized = normalizePrompt(args.promptRaw);

    await ctx.db.patch(args.jobId, {
      status: "queued",
      promptRaw: args.promptRaw,
      promptNormalized,
      anchors: args.anchors,
      compute: {
        queuedAt: Date.now(),
      },
      error: undefined,
    });

    await ctx.scheduler.runAfter(0, internal.jobs.triggerWorker, {
      jobId: args.jobId,
    });

    return args.jobId;
  },
});

export const rerun = mutation({
  args: {
    jobId: v.id("jobs"),
    sessionId: v.string(),
    promptRaw: v.optional(v.string()),
    anchors: v.optional(
      v.array(
        v.object({
          kind: v.union(v.literal("present"), v.literal("absent")),
          start: v.number(),
          end: v.number(),
        })
      )
    ),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Job not found");
    if (job.sessionId !== args.sessionId) throw new Error("Access denied");

    const promptRaw = args.promptRaw ?? job.promptRaw;
    const anchors = args.anchors ?? job.anchors;

    if (!promptRaw) throw new Error("Prompt is required");
    validateAnchors(anchors);

    const promptNormalized = normalizePrompt(promptRaw);

    await ctx.db.patch(args.jobId, {
      status: "queued",
      promptRaw,
      promptNormalized,
      anchors,
      compute: {
        queuedAt: Date.now(),
      },
      error: undefined,
      retryCount: 0,
    });

    await ctx.scheduler.runAfter(0, internal.jobs.triggerWorker, {
      jobId: args.jobId,
    });

    return args.jobId;
  },
});

// ============================================================================
// PUBLIC QUERIES
// ============================================================================

export const get = query({
  args: {
    jobId: v.id("jobs"),
    sessionId: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    if (job.sessionId !== args.sessionId) return null;
    return job;
  },
});

export const listBySession = query({
  args: {
    sessionId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("jobs")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(50);
  },
});

// ============================================================================
// INTERNAL MUTATIONS
// ============================================================================

export const handleWorkerCallback = internalMutation({
  args: {
    jobId: v.id("jobs"),
    status: v.union(v.literal("succeeded"), v.literal("failed")),
    outputCleanKey: v.optional(v.string()),
    outputRemovedKey: v.optional(v.string()),
    outputVideoKey: v.optional(v.string()),
    metrics: v.optional(
      v.object({
        gpuSeconds: v.number(),
        rtf: v.number(),
        durationSec: v.number(),
      })
    ),
    error: v.optional(
      v.object({
        message: v.string(),
        step: v.optional(v.string()),
        detail: v.optional(v.string()),
        retryable: v.optional(v.boolean()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Job not found");

    const now = Date.now();

    if (args.status === "succeeded") {
      await ctx.db.patch(args.jobId, {
        status: "succeeded",
        outputCleanKey: args.outputCleanKey,
        outputRemovedKey: args.outputRemovedKey,
        outputVideoKey: args.outputVideoKey,
        compute: {
          ...job.compute,
          finishedAt: now,
          gpuSeconds: args.metrics?.gpuSeconds,
          rtf: args.metrics?.rtf,
          durationSec: args.metrics?.durationSec,
        },
      });
    } else {
      const retryCount = (job.retryCount ?? 0) + 1;
      const shouldRetry = args.error?.retryable && retryCount <= MAX_RETRIES;

      await ctx.db.patch(args.jobId, {
        status: shouldRetry ? "queued" : "failed",
        error: args.error,
        retryCount,
        compute: {
          ...job.compute,
          finishedAt: now,
        },
      });

      if (shouldRetry) {
        const delay = retryCount * 5000;
        await ctx.scheduler.runAfter(delay, internal.jobs.triggerWorker, {
          jobId: args.jobId,
        });
      }
    }
  },
});

export const setRunning = internalMutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return;

    await ctx.db.patch(args.jobId, {
      status: "running",
      compute: {
        ...job.compute,
        startedAt: Date.now(),
      },
    });
  },
});

export const getInternal = internalQuery({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.jobId);
  },
});

// ============================================================================
// INTERNAL ACTIONS
// ============================================================================

export const triggerWorker = internalAction({
  args: {
    jobId: v.id("jobs"),
  },
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(internal.jobs.getInternal, {
      jobId: args.jobId,
    });
    if (!job) throw new Error("Job not found");

    // Get presigned input URL
    const inputUrl = await ctx.runAction(internal.storage.getDownloadUrlInternal, {
      objectKey: job.inputObjectKey,
    });

    // Generate HMAC signature for callback
    const crypto = await import("crypto");
    const callbackSecret = process.env.WORKER_CALLBACK_SECRET!;
    const callbackPayload = JSON.stringify({ jobId: args.jobId });
    const signature = crypto
      .createHmac("sha256", callbackSecret)
      .update(callbackPayload)
      .digest("hex");

    const callbackUrl = `${process.env.CONVEX_SITE_URL}/worker/callback?jobId=${args.jobId}&sig=${signature}`;

    // Build output keys
    const cleanKey = `outputs/${args.jobId}/clean.wav`;
    const removedKey = `outputs/${args.jobId}/removed.wav`;
    const videoKey =
      job.inputKind === "video" ? `outputs/${args.jobId}/clean.mp4` : undefined;

    // Format anchors for worker
    const anchors = job.anchors.map(
      (a: { kind: string; start: number; end: number }) => ({
        kind: a.kind === "present" ? "+" : "-",
        start: a.start,
        end: a.end,
      })
    );

    // POST to Modal worker
    const workerUrl = process.env.MODAL_WORKER_URL!;
    const response = await fetch(`${workerUrl}/separate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        job_id: args.jobId,
        input_kind: job.inputKind,
        input_url: inputUrl,
        prompt: job.promptNormalized,
        anchors,
        output_bucket: process.env.R2_BUCKET,
        output_keys: {
          clean: cleanKey,
          removed: removedKey,
          video: videoKey,
        },
        callback_url: callbackUrl,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Worker request failed: ${error}`);
    }

    // Mark as running
    await ctx.runMutation(internal.jobs.setRunning, { jobId: args.jobId });
  },
});
