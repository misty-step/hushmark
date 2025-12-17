"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import crypto from "crypto";

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
