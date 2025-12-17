"use client";

import { AlertCircle, RefreshCw, Pencil, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { JobError } from "@hushmark/shared";

interface ErrorDisplayProps {
  error: JobError;
  onRetry?: () => void;
  onEditPrompt?: () => void;
  onMarkExamples?: () => void;
}

function getErrorMessage(error: JobError): string {
  switch (error.step) {
    case "download":
      return "Failed to download your file. Please try uploading again.";
    case "extract":
      return "Unsupported audio format. Try converting to MP3 or WAV.";
    case "infer":
      return "Processing failed. Try a simpler description or shorter file.";
    case "upload":
      return "Failed to save results. Please try again.";
    case "remux":
      return "Failed to merge audio back into video. Please try again.";
    default:
      return error.message || "Something went wrong. Please try again.";
  }
}

export function ErrorDisplay({
  error,
  onRetry,
  onEditPrompt,
  onMarkExamples,
}: ErrorDisplayProps) {
  const message = getErrorMessage(error);

  return (
    <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6 space-y-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-destructive mt-0.5" />
        <div>
          <h3 className="font-medium text-destructive">Processing Failed</h3>
          <p className="mt-1 text-sm text-muted-foreground">{message}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {error.retryable && onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Try Again
          </Button>
        )}
        {onEditPrompt && (
          <Button variant="outline" size="sm" onClick={onEditPrompt}>
            <Pencil className="mr-2 h-4 w-4" />
            Adjust Description
          </Button>
        )}
        {onMarkExamples && (
          <Button variant="outline" size="sm" onClick={onMarkExamples}>
            <Wand2 className="mr-2 h-4 w-4" />
            Mark Examples
          </Button>
        )}
      </div>
    </div>
  );
}
