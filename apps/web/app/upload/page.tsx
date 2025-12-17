"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { nanoid } from "nanoid";

import { DropZone } from "@/components/upload/drop-zone";
import { FileInfo } from "@/components/upload/file-info";
import { UploadProgress } from "@/components/upload/upload-progress";
import { RightsCheckbox } from "@/components/shared/rights-checkbox";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import { useSessionStore } from "@/stores/session";
import { getInputKind } from "@hushmark/shared";

export default function UploadPage() {
  const router = useRouter();
  const ensureSession = useSessionStore((s) => s.ensureSession);

  const [file, setFile] = useState<File | null>(null);
  const [hasRights, setHasRights] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const createJob = useMutation(api.jobs.create);
  const getUploadUrl = useAction(api.storage.getUploadUrl);

  const handleFileSelect = useCallback((selectedFile: File) => {
    setFile(selectedFile);
    setError(null);
  }, []);

  const handleClear = useCallback(() => {
    setFile(null);
    setError(null);
  }, []);

  const handleUpload = useCallback(async () => {
    if (!file || !hasRights) return;

    setIsUploading(true);
    setError(null);
    setUploadProgress(0);

    try {
      const sessionId = ensureSession();
      const tempJobId = nanoid();

      // Get presigned upload URL
      const { uploadUrl, objectKey } = await getUploadUrl({
        jobId: tempJobId,
        filename: file.name,
        contentType: file.type,
      });

      // Upload file with progress tracking
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) {
            setUploadProgress((e.loaded / e.total) * 100);
          }
        });
        xhr.addEventListener("load", () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Upload failed: ${xhr.status}`));
          }
        });
        xhr.addEventListener("error", () => reject(new Error("Upload failed")));
        xhr.open("PUT", uploadUrl);
        xhr.setRequestHeader("Content-Type", file.type);
        xhr.send(file);
      });

      // Create job record
      const jobId = await createJob({
        sessionId,
        inputObjectKey: objectKey,
        inputFilename: file.name,
        inputSizeBytes: file.size,
        inputContentType: file.type,
        inputKind: getInputKind(file.type),
      });

      // Navigate to describe page
      router.push(`/job/${jobId}/describe`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setIsUploading(false);
    }
  }, [file, hasRights, ensureSession, getUploadUrl, createJob, router]);

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-xl space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">Hushmark</h1>
          <p className="mt-2 text-muted-foreground">
            Remove unwanted sounds from your audio and video
          </p>
        </div>

        <div className="space-y-6">
          {!file ? (
            <DropZone onFileSelect={handleFileSelect} disabled={isUploading} />
          ) : (
            <FileInfo file={file} onClear={handleClear} />
          )}

          {isUploading && <UploadProgress progress={uploadProgress} />}

          {file && !isUploading && (
            <>
              <RightsCheckbox
                checked={hasRights}
                onCheckedChange={setHasRights}
              />

              <Button
                onClick={handleUpload}
                disabled={!hasRights}
                className="w-full"
                size="lg"
              >
                Continue
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </div>
    </main>
  );
}
