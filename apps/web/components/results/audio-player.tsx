"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Play, Pause, Volume2, VolumeX } from "lucide-react";
import { formatDuration, cn } from "@/lib/utils";

type AudioMode = "before" | "after" | "removed";

interface AudioPlayerProps {
  originalUrl?: string;
  cleanUrl: string;
  removedUrl: string;
}

export function AudioPlayer({
  originalUrl,
  cleanUrl,
  removedUrl,
}: AudioPlayerProps) {
  const [mode, setMode] = useState<AudioMode>("after");
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);

  const currentUrl =
    mode === "before"
      ? originalUrl || cleanUrl
      : mode === "after"
        ? cleanUrl
        : removedUrl;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
    const handleDurationChange = () => setDuration(audio.duration);
    const handleEnded = () => setIsPlaying(false);

    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("durationchange", handleDurationChange);
    audio.addEventListener("ended", handleEnded);

    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("durationchange", handleDurationChange);
      audio.removeEventListener("ended", handleEnded);
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const wasPlaying = isPlaying;
    const time = currentTime;

    audio.src = currentUrl;
    audio.load();

    // Resume playback position
    const handleCanPlay = () => {
      audio.currentTime = Math.min(time, audio.duration || time);
      if (wasPlaying) {
        audio.play();
      }
      audio.removeEventListener("canplay", handleCanPlay);
    };

    audio.addEventListener("canplay", handleCanPlay);
  }, [currentUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = isMuted ? 0 : volume;
  }, [volume, isMuted]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      audio.play();
    }
    setIsPlaying(!isPlaying);
  }, [isPlaying]);

  const handleSeek = useCallback((value: number[]) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = value[0];
    setCurrentTime(value[0]);
  }, []);

  const handleVolumeChange = useCallback((value: number[]) => {
    setVolume(value[0]);
    if (value[0] > 0) setIsMuted(false);
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted(!isMuted);
  }, [isMuted]);

  return (
    <div className="space-y-4 rounded-lg border bg-card p-6">
      <audio ref={audioRef} preload="metadata" />

      {/* Mode toggle */}
      <div className="flex gap-2">
        {originalUrl && (
          <Button
            variant={mode === "before" ? "default" : "outline"}
            size="sm"
            onClick={() => setMode("before")}
          >
            Before
          </Button>
        )}
        <Button
          variant={mode === "after" ? "default" : "outline"}
          size="sm"
          onClick={() => setMode("after")}
        >
          After
        </Button>
        <Button
          variant={mode === "removed" ? "secondary" : "outline"}
          size="sm"
          onClick={() => setMode("removed")}
          className={cn(
            mode === "removed" && "bg-orange-500/20 hover:bg-orange-500/30"
          )}
        >
          Hear Removed
        </Button>
      </div>

      {/* Progress bar */}
      <div className="space-y-2">
        <Slider
          value={[currentTime]}
          max={duration || 100}
          step={0.1}
          onValueChange={handleSeek}
          className="w-full"
        />
        <div className="flex justify-between text-xs text-muted-foreground font-mono">
          <span>{formatDuration(currentTime)}</span>
          <span>{formatDuration(duration)}</span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-4">
        <Button variant="outline" size="icon" onClick={togglePlay}>
          {isPlaying ? (
            <Pause className="h-4 w-4" />
          ) : (
            <Play className="h-4 w-4" />
          )}
        </Button>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={toggleMute}>
            {isMuted || volume === 0 ? (
              <VolumeX className="h-4 w-4" />
            ) : (
              <Volume2 className="h-4 w-4" />
            )}
          </Button>
          <Slider
            value={[isMuted ? 0 : volume]}
            max={1}
            step={0.01}
            onValueChange={handleVolumeChange}
            className="w-24"
          />
        </div>

        <span className="ml-auto text-sm text-muted-foreground">
          {mode === "before"
            ? "Original"
            : mode === "after"
              ? "Cleaned"
              : "What was removed"}
        </span>
      </div>
    </div>
  );
}
