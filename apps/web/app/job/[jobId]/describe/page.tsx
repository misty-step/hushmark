"use client";

import { useState, useCallback, use } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

import { PromptInput } from "@/components/describe/prompt-input";
import { EraseButton } from "@/components/describe/erase-button";
import { FileInfo } from "@/components/upload/file-info";
import { useSessionStore } from "@/stores/session";
import { FileAudio, FileVideo, Wand2 } from "lucide-react";
import Link from "next/link";

export default function DescribePage({
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

  const setPromptAndRun = useMutation(api.jobs.setPromptAndRun);

  const [prompt, setPrompt] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    if (!prompt.trim() || !sessionId) return;

    setIsSubmitting(true);
    setError(null);

    try {
      await setPromptAndRun({
        jobId: jobId as Id<"jobs">,
        sessionId,
        promptRaw: prompt,
        anchors: [],
      });

      router.push(`/job/${jobId}/results`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start processing");
      setIsSubmitting(false);
    }
  }, [prompt, sessionId, jobId, setPromptAndRun, router]);

  if (job === undefined) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
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

  const Icon = job.inputKind === "video" ? FileVideo : FileAudio;

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-xl space-y-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight">Describe the Sound</h1>
          <p className="mt-2 text-muted-foreground">
            Tell us what you want to remove
          </p>
        </div>

        <div className="flex items-center gap-4 rounded-lg border bg-muted/30 p-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
            <Icon className="h-6 w-6 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="truncate font-medium">{job.inputFilename}</p>
            <p className="text-sm text-muted-foreground">
              {job.inputKind === "video" ? "Video" : "Audio"}
            </p>
          </div>
        </div>

        <div className="space-y-6">
          <PromptInput
            value={prompt}
            onChange={setPrompt}
            disabled={isSubmitting}
          />

          <EraseButton
            onClick={handleSubmit}
            disabled={!prompt.trim()}
            loading={isSubmitting}
          />

          <div className="text-center">
            <Link
              href={`/job/${jobId}/mark`}
              className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
            >
              <Wand2 className="h-4 w-4" />
              Not perfect? Mark examples
            </Link>
          </div>

          {error && <p className="text-sm text-destructive text-center">{error}</p>}
        </div>
      </div>
    </main>
  );
}
