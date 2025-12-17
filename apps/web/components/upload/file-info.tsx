"use client";

import { FileAudio, FileVideo, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/utils";
import { getInputKind } from "@hushmark/shared";

interface FileInfoProps {
  file: File;
  onClear: () => void;
}

export function FileInfo({ file, onClear }: FileInfoProps) {
  const inputKind = getInputKind(file.type);
  const Icon = inputKind === "video" ? FileVideo : FileAudio;

  return (
    <div className="flex items-center gap-4 rounded-lg border bg-muted/30 p-4">
      <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
        <Icon className="h-6 w-6 text-primary" />
      </div>

      <div className="flex-1 min-w-0">
        <p className="truncate font-medium">{file.name}</p>
        <p className="text-sm text-muted-foreground">
          {inputKind === "video" ? "Video" : "Audio"} • {formatBytes(file.size)}
        </p>
      </div>

      <Button variant="ghost" size="icon" onClick={onClear}>
        <X className="h-4 w-4" />
        <span className="sr-only">Remove file</span>
      </Button>
    </div>
  );
}
