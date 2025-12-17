"use client";

import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";

interface DownloadButtonsProps {
  cleanAudioUrl: string;
  removedAudioUrl: string;
  cleanVideoUrl?: string;
  isVideo: boolean;
}

export function DownloadButtons({
  cleanAudioUrl,
  removedAudioUrl,
  cleanVideoUrl,
  isVideo,
}: DownloadButtonsProps) {
  return (
    <div className="flex flex-wrap gap-3">
      {isVideo && cleanVideoUrl ? (
        <Button asChild>
          <a href={cleanVideoUrl} download="clean.mp4">
            <Download className="mr-2 h-4 w-4" />
            Download Clean Video
          </a>
        </Button>
      ) : (
        <Button asChild>
          <a href={cleanAudioUrl} download="clean.wav">
            <Download className="mr-2 h-4 w-4" />
            Download Clean Audio
          </a>
        </Button>
      )}

      <Button variant="outline" asChild>
        <a href={removedAudioUrl} download="removed.wav">
          <Download className="mr-2 h-4 w-4" />
          Download Removed
        </a>
      </Button>
    </div>
  );
}
