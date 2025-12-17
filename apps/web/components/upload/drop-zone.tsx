"use client";

import { useCallback, useState } from "react";
import { Upload, FileAudio, FileVideo } from "lucide-react";
import { cn } from "@/lib/utils";
import { validateFile, ALLOWED_TYPES } from "@hushmark/shared";

interface DropZoneProps {
  onFileSelect: (file: File) => void;
  disabled?: boolean;
}

export function DropZone({ onFileSelect, disabled }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(
    (file: File) => {
      setError(null);
      const validation = validateFile(file);
      if (!validation.valid) {
        setError(validation.error || "Invalid file");
        return;
      }
      onFileSelect(file);
    },
    [onFileSelect]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);

      if (disabled) return;

      const file = e.dataTransfer.files[0];
      if (file) {
        handleFile(file);
      }
    },
    [disabled, handleFile]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!disabled) {
        setIsDragging(true);
      }
    },
    [disabled]
  );

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        handleFile(file);
      }
    },
    [handleFile]
  );

  const acceptTypes = ALLOWED_TYPES.join(",");

  return (
    <div className="space-y-2">
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={cn(
          "relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-12 transition-colors",
          isDragging
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/25 hover:border-muted-foreground/50",
          disabled && "pointer-events-none opacity-50"
        )}
      >
        <input
          type="file"
          accept={acceptTypes}
          onChange={handleInputChange}
          disabled={disabled}
          className="absolute inset-0 cursor-pointer opacity-0"
        />

        <div className="flex items-center gap-3 text-muted-foreground">
          <FileAudio className="h-8 w-8" />
          <FileVideo className="h-8 w-8" />
        </div>

        <div className="mt-4 flex items-center gap-2 text-lg font-medium">
          <Upload className="h-5 w-5" />
          <span>Drop your file here</span>
        </div>

        <p className="mt-2 text-sm text-muted-foreground">
          or click to browse
        </p>

        <p className="mt-4 text-xs text-muted-foreground">
          Supports MP3, WAV, M4A, MP4, MOV • Max 500MB • Max 10 minutes
        </p>
      </div>

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}
