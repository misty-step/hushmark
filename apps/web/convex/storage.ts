import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function getR2Client() {
  return new S3Client({
    region: "auto",
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

const EXT_MAP: Record<string, string> = {
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/m4a": ".m4a",
  "audio/mp4": ".m4a",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
};

// ============================================================================
// PUBLIC ACTIONS
// ============================================================================

export const getUploadUrl = action({
  args: {
    jobId: v.string(),
    filename: v.string(),
    contentType: v.string(),
  },
  handler: async (_ctx, args) => {
    const r2 = getR2Client();
    const ext = EXT_MAP[args.contentType] || "";
    const objectKey = `inputs/${args.jobId}/source${ext}`;

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: objectKey,
      ContentType: args.contentType,
    });

    const uploadUrl = await getSignedUrl(r2, command, { expiresIn: 3600 });

    return {
      objectKey,
      uploadUrl,
      expiresAt: Date.now() + 3600 * 1000,
    };
  },
});

export const getDownloadUrl = action({
  args: {
    objectKey: v.string(),
  },
  handler: async (_ctx, args) => {
    const r2 = getR2Client();

    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: args.objectKey,
    });

    const downloadUrl = await getSignedUrl(r2, command, { expiresIn: 3600 });

    return downloadUrl;
  },
});

export const getMultipleDownloadUrls = action({
  args: {
    objectKeys: v.array(v.string()),
  },
  handler: async (_ctx, args) => {
    const r2 = getR2Client();
    const bucket = process.env.R2_BUCKET!;

    const urls: Record<string, string> = {};

    for (const key of args.objectKeys) {
      if (key) {
        const command = new GetObjectCommand({ Bucket: bucket, Key: key });
        urls[key] = await getSignedUrl(r2, command, { expiresIn: 3600 });
      }
    }

    return urls;
  },
});

// ============================================================================
// INTERNAL ACTIONS
// ============================================================================

export const getDownloadUrlInternal = internalAction({
  args: {
    objectKey: v.string(),
  },
  handler: async (_ctx, args) => {
    const r2 = getR2Client();

    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: args.objectKey,
    });

    return await getSignedUrl(r2, command, { expiresIn: 3600 });
  },
});
