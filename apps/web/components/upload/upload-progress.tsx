"use client";

import { Progress } from "@/components/ui/progress";

interface UploadProgressProps {
  progress: number;
}

export function UploadProgress({ progress }: UploadProgressProps) {
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-sm">
        <span className="text-muted-foreground">Uploading...</span>
        <span className="font-medium">{Math.round(progress)}%</span>
      </div>
      <Progress value={progress} />
    </div>
  );
}
