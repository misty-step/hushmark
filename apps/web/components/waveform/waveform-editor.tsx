"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Play, Pause, Plus, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { formatDuration, cn } from "@/lib/utils";
import type { Anchor } from "@hushmark/shared";

interface WaveformEditorProps {
  audioUrl: string;
  anchors: Anchor[];
  onAnchorsChange: (anchors: Anchor[]) => void;
  maxAnchors?: number;
}

export function WaveformEditor({
  audioUrl,
  anchors,
  onAnchorsChange,
  maxAnchors = 6,
}: WaveformEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [zoom, setZoom] = useState(50);

  // Initialize WaveSurfer
  useEffect(() => {
    if (!containerRef.current) return;

    const regions = RegionsPlugin.create();
    regionsRef.current = regions;

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: "rgb(100, 100, 100)",
      progressColor: "rgb(60, 60, 60)",
      cursorColor: "rgb(255, 100, 100)",
      cursorWidth: 2,
      height: 128,
      minPxPerSec: zoom,
      plugins: [regions],
    });

    wavesurferRef.current = ws;

    ws.load(audioUrl);

    ws.on("ready", () => {
      setIsReady(true);
      setDuration(ws.getDuration());

      // Restore existing anchors as regions
      anchors.forEach((anchor, index) => {
        regions.addRegion({
          id: `anchor-${index}`,
          start: anchor.start,
          end: anchor.end,
          color:
            anchor.kind === "present"
              ? "rgba(34, 197, 94, 0.3)"
              : "rgba(249, 115, 22, 0.3)",
          drag: true,
          resize: true,
        });
      });
    });

    ws.on("play", () => setIsPlaying(true));
    ws.on("pause", () => setIsPlaying(false));
    ws.on("timeupdate", (time) => setCurrentTime(time));

    regions.on("region-updated", () => {
      syncRegionsToAnchors();
    });

    regions.on("region-clicked", (region, e) => {
      e.stopPropagation();
      region.play();
    });

    return () => {
      ws.destroy();
    };
  }, [audioUrl]);

  // Update zoom
  useEffect(() => {
    if (wavesurferRef.current && isReady) {
      wavesurferRef.current.zoom(zoom);
    }
  }, [zoom, isReady]);

  const syncRegionsToAnchors = useCallback(() => {
    if (!regionsRef.current) return;

    const regionsList = regionsRef.current.getRegions();
    const newAnchors: Anchor[] = regionsList.map((region) => ({
      kind: region.color?.includes("34, 197, 94") ? "present" : "absent",
      start: region.start,
      end: region.end,
    }));

    onAnchorsChange(newAnchors);
  }, [onAnchorsChange]);

  const addRegion = useCallback(
    (kind: "present" | "absent") => {
      if (!regionsRef.current || !wavesurferRef.current) return;
      if (anchors.length >= maxAnchors) return;

      const current = wavesurferRef.current.getCurrentTime();
      const end = Math.min(current + 2, duration);

      regionsRef.current.addRegion({
        id: `anchor-${Date.now()}`,
        start: current,
        end: end,
        color:
          kind === "present"
            ? "rgba(34, 197, 94, 0.3)"
            : "rgba(249, 115, 22, 0.3)",
        drag: true,
        resize: true,
      });

      syncRegionsToAnchors();
    },
    [anchors.length, maxAnchors, duration, syncRegionsToAnchors]
  );

  const clearAllRegions = useCallback(() => {
    if (!regionsRef.current) return;
    regionsRef.current.clearRegions();
    onAnchorsChange([]);
  }, [onAnchorsChange]);

  const togglePlay = useCallback(() => {
    wavesurferRef.current?.playPause();
  }, []);

  return (
    <div className="space-y-4">
      {/* Waveform container */}
      <div
        ref={containerRef}
        className="w-full rounded-lg border bg-muted/30"
        style={{ minHeight: 128 }}
      />

      {/* Time display */}
      <div className="flex justify-between text-sm text-muted-foreground font-mono">
        <span>{formatDuration(currentTime)}</span>
        <span>{formatDuration(duration)}</span>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Playback */}
        <Button variant="outline" size="icon" onClick={togglePlay} disabled={!isReady}>
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>

        {/* Zoom */}
        <div className="flex items-center gap-2">
          <ZoomOut className="h-4 w-4 text-muted-foreground" />
          <Slider
            value={[zoom]}
            onValueChange={([value]) => setZoom(value)}
            min={10}
            max={200}
            step={10}
            className="w-32"
          />
          <ZoomIn className="h-4 w-4 text-muted-foreground" />
        </div>

        <div className="h-6 w-px bg-border mx-2" />

        {/* Mark regions */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => addRegion("present")}
          disabled={!isReady || anchors.length >= maxAnchors}
          className="bg-green-500/10 hover:bg-green-500/20 border-green-500/30"
        >
          <Plus className="h-4 w-4 mr-1" />
          Sound present
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={() => addRegion("absent")}
          disabled={!isReady || anchors.length >= maxAnchors}
          className="bg-orange-500/10 hover:bg-orange-500/20 border-orange-500/30"
        >
          <Plus className="h-4 w-4 mr-1" />
          Sound absent
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={clearAllRegions}
          disabled={!isReady || anchors.length === 0}
        >
          <Trash2 className="h-4 w-4 mr-1" />
          Clear all
        </Button>

        {/* Counter */}
        <span className="text-sm text-muted-foreground ml-auto">
          {anchors.length}/{maxAnchors} markers
        </span>
      </div>

      {/* Instructions */}
      <p className="text-sm text-muted-foreground">
        Mark 1-3 short regions (0.5-2s) where the sound is present, and optionally
        where it&apos;s absent. Drag edges to resize, drag center to move.
      </p>
    </div>
  );
}
