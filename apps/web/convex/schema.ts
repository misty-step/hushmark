import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const anchorValidator = v.object({
  kind: v.union(v.literal("present"), v.literal("absent")),
  start: v.number(),
  end: v.number(),
});

const computeValidator = v.object({
  queuedAt: v.optional(v.number()),
  startedAt: v.optional(v.number()),
  finishedAt: v.optional(v.number()),
  gpuSeconds: v.optional(v.number()),
  rtf: v.optional(v.number()),
  durationSec: v.optional(v.number()),
});

const errorValidator = v.object({
  message: v.string(),
  step: v.optional(v.string()),
  detail: v.optional(v.string()),
  retryable: v.optional(v.boolean()),
});

export default defineSchema({
  jobs: defineTable({
    status: v.union(
      v.literal("created"),
      v.literal("queued"),
      v.literal("running"),
      v.literal("succeeded"),
      v.literal("failed")
    ),

    sessionId: v.string(),
    userId: v.optional(v.string()),

    inputKind: v.union(v.literal("audio"), v.literal("video")),
    inputObjectKey: v.string(),
    inputFilename: v.string(),
    inputSizeBytes: v.number(),
    inputContentType: v.string(),

    promptRaw: v.optional(v.string()),
    promptNormalized: v.optional(v.string()),
    anchors: v.array(anchorValidator),

    outputCleanKey: v.optional(v.string()),
    outputRemovedKey: v.optional(v.string()),
    outputVideoKey: v.optional(v.string()),

    compute: v.optional(computeValidator),
    error: v.optional(errorValidator),
    retryCount: v.optional(v.number()),

    expiresAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_status", ["status"])
    .index("by_expires", ["expiresAt"]),
});
