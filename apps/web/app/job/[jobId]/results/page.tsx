"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

import { AudioPlayer } from "@/components/results/audio-player";
import { DownloadButtons } from "@/components/results/download-buttons";
import { ErrorDisplay } from "@/components/results/error-display";
import { JobStatus } from "@/components/shared/job-status";
import { useSessionStore } from "@/stores/session";
import { Loader2, Wand2 } from "lucide-react";
import Link from "next/link";
import type { JobError } from "@hushmark/shared";

export default function ResultsPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = use(params);
  const router = useRouter();
  const sessionId = useSessionStore((s) => s.sessionId);

  const job = useQuery(api.jobs.get, {
    jobId: jobId as Id<"jobs">,
    sessionId: sessionId || "",
  });

  const getDownloadUrls = useAction(api.storage.getMultipleDownloadUrls);
  const rerunJob = useMutation(api.jobs.rerun);

  const [downloadUrls, setDownloadUrls] = useState<Record<string, string> | null>(null);

  // Fetch download URLs when job succeeds
  useEffect(() => {
    if (
      job?.status === "succeeded" &&
      job.outputCleanKey &&
      job.outputRemovedKey &&
      !downloadUrls
    ) {
      const keys = [job.outputCleanKey, job.outputRemovedKey, job.outputVideoKey].filter(
        Boolean
      ) as string[];

      getDownloadUrls({ objectKeys: keys }).then(setDownloadUrls);
    }
  }, [job, downloadUrls, getDownloadUrls]);

  const handleRetry = useCallback(async () => {
    if (!sessionId) return;
    try {
      await rerunJob({
        jobId: jobId as Id<"jobs">,
        sessionId,
      });
    } catch (err) {
      console.error("Retry failed:", err);
    }
  }, [sessionId, jobId, rerunJob]);

  const handleEditPrompt = useCallback(() => {
    router.push(`/job/${jobId}/describe`);
  }, [router, jobId]);

  const handleMarkExamples = useCallback(() => {
    router.push(`/job/${jobId}/mark`);
  }, [router, jobId]);

  if (job === undefined) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (job === null) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="text-center space-y-4">
          <p className="text-muted-foreground">Job not found</p>
          <Link href="/upload" className="text-primary hover:underline">
            Upload a new file
          </Link>
        </div>
      </main>
    );
  }

  // Processing states
  if (job.status === "queued" || job.status === "running") {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-xl space-y-8 text-center">
          <div className="space-y-4">
            <Loader2 className="h-12 w-12 animate-spin text-primary mx-auto" />
            <h1 className="text-2xl font-bold">Processing Your Audio</h1>
            <p className="text-muted-foreground">
              {job.status === "queued"
                ? "Waiting in queue..."
                : "Removing the sound..."}
            </p>
            {job.promptNormalized && (
              <p className="text-sm text-muted-foreground">
                Removing: <span className="font-medium">{job.promptNormalized}</span>
              </p>
            )}
          </div>
          <JobStatus status={job.status} className="justify-center" />
        </div>
      </main>
    );
  }

  // Failed state
  if (job.status === "failed" && job.error) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-xl space-y-6">
          <div className="text-center">
            <h1 className="text-2xl font-bold">Processing Failed</h1>
          </div>
          <ErrorDisplay
            error={job.error as JobError}
            onRetry={handleRetry}
            onEditPrompt={handleEditPrompt}
            onMarkExamples={handleMarkExamples}
          />
        </div>
      </main>
    );
  }

  // Success state
  if (job.status === "succeeded" && downloadUrls) {
    const cleanUrl = job.outputCleanKey ? downloadUrls[job.outputCleanKey] : undefined;
    const removedUrl = job.outputRemovedKey
      ? downloadUrls[job.outputRemovedKey]
      : undefined;
    const videoUrl = job.outputVideoKey
      ? downloadUrls[job.outputVideoKey]
      : undefined;

    if (!cleanUrl || !removedUrl) {
      return (
        <main className="min-h-screen flex items-center justify-center p-4">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </main>
      );
    }

    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-xl space-y-8">
          <div className="text-center">
            <h1 className="text-2xl font-bold">Sound Removed</h1>
            <p className="mt-2 text-muted-foreground">
              Successfully removed: {job.promptNormalized}
            </p>
          </div>

          <AudioPlayer cleanUrl={cleanUrl} removedUrl={removedUrl} />

          <DownloadButtons
            cleanAudioUrl={cleanUrl}
            removedAudioUrl={removedUrl}
            cleanVideoUrl={videoUrl}
            isVideo={job.inputKind === "video"}
          />

          <div className="text-center">
            <Link
              href={`/job/${jobId}/mark`}
              className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
            >
              <Wand2 className="h-4 w-4" />
              Not perfect? Mark examples for better results
            </Link>
          </div>

          {job.compute?.rtf && (
            <p className="text-center text-xs text-muted-foreground">
              Processed in {job.compute.gpuSeconds?.toFixed(1)}s (
              {job.compute.rtf.toFixed(2)}x realtime)
            </p>
          )}
        </div>
      </main>
    );
  }

  // Loading download URLs
  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </main>
  );
}
