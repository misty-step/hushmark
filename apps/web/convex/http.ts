import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const http = httpRouter();

// Web Crypto API HMAC verification
async function verifyHmac(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const expectedSig = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return signature === expectedSig;
}

http.route({
  path: "/worker/callback",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const jobId = url.searchParams.get("jobId");
    const signature = url.searchParams.get("sig");

    if (!jobId || !signature) {
      return new Response("Missing jobId or signature", { status: 400 });
    }

    // Verify HMAC signature using Web Crypto API
    const callbackSecret = process.env.WORKER_CALLBACK_SECRET!;
    const expectedPayload = JSON.stringify({ jobId });
    const isValid = await verifyHmac(expectedPayload, signature, callbackSecret);

    if (!isValid) {
      return new Response("Invalid signature", { status: 401 });
    }

    const body = await request.json();

    await ctx.runMutation(internal.jobs.handleWorkerCallback, {
      jobId: jobId as Id<"jobs">,
      status: body.status,
      outputCleanKey: body.output_clean_key,
      outputRemovedKey: body.output_removed_key,
      outputVideoKey: body.output_video_key,
      metrics: body.metrics
        ? {
            gpuSeconds: body.metrics.gpu_seconds,
            rtf: body.metrics.rtf,
            durationSec: body.metrics.duration_sec,
          }
        : undefined,
      error: body.error
        ? {
            message: body.error.message,
            step: body.error.step,
            detail: body.error.detail,
            retryable: body.error.retryable,
          }
        : undefined,
    });

    return new Response("OK", { status: 200 });
  }),
});

http.route({
  path: "/worker/callback",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

export default http;
