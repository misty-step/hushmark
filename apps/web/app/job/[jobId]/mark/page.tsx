"use client";

import { useState, useCallback, use } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import dynamic from "next/dynamic";

import { PromptInput } from "@/components/describe/prompt-input";
import { EraseButton } from "@/components/describe/erase-button";
import { useSessionStore } from "@/stores/session";
import { ArrowLeft, Loader2 } from "lucide-react";
import Link from "next/link";
import type { Anchor } from "@hushmark/shared";

// Dynamic import to avoid SSR issues with WaveSurfer
const WaveformEditor = dynamic(
  () =>
    import("@/components/waveform/waveform-editor").then(
      (mod) => mod.WaveformEditor
    ),
  {
    ssr: false,
    loading: () => (
      <div className="h-32 flex items-center justify-center border rounded-lg bg-muted/30">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    ),
  }
);

export default function MarkPage({
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

  const getDownloadUrl = useAction(api.storage.getDownloadUrl);
  const rerunJob = useMutation(api.jobs.rerun);

  const [prompt, setPrompt] = useState("");
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize prompt from job
  useState(() => {
    if (job?.promptRaw) {
      setPrompt(job.promptRaw);
    }
    if (job?.anchors) {
      setAnchors(job.anchors as Anchor[]);
    }
  });

  // Fetch audio URL for waveform
  useState(() => {
    if (job?.inputObjectKey && !audioUrl) {
      getDownloadUrl({ objectKey: job.inputObjectKey }).then(setAudioUrl);
    }
  });

  const handleSubmit = useCallback(async () => {
    if (!prompt.trim() || !sessionId) return;

    setIsSubmitting(true);
    setError(null);

    try {
      await rerunJob({
        jobId: jobId as Id<"jobs">,
        sessionId,
        promptRaw: prompt,
        anchors,
      });

      router.push(`/job/${jobId}/results`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start processing");
      setIsSubmitting(false);
    }
  }, [prompt, anchors, sessionId, jobId, rerunJob, router]);

  if (job === undefined || !audioUrl) {
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

  return (
    <main className="min-h-screen p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="flex items-center gap-4">
          <Link
            href={`/job/${jobId}/describe`}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold">Mark Examples</h1>
            <p className="text-muted-foreground">
              Help us find the sound by marking where it appears
            </p>
          </div>
        </div>

        <div className="space-y-6">
          <PromptInput
            value={prompt}
            onChange={setPrompt}
            disabled={isSubmitting}
          />

          <WaveformEditor
            audioUrl={audioUrl}
            anchors={anchors}
            onAnchorsChange={setAnchors}
          />

          <EraseButton
            onClick={handleSubmit}
            disabled={!prompt.trim()}
            loading={isSubmitting}
          />

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </div>
    </main>
  );
}
