"use client";

import { cn } from "@/lib/utils";
import { Loader2, CheckCircle2, XCircle, Clock, Zap } from "lucide-react";
import type { JobStatus as Status } from "@hushmark/shared";

interface JobStatusProps {
  status: Status;
  className?: string;
}

const statusConfig: Record<
  Status,
  { icon: typeof Loader2; label: string; color: string }
> = {
  created: {
    icon: Clock,
    label: "Ready",
    color: "text-muted-foreground",
  },
  queued: {
    icon: Clock,
    label: "Queued",
    color: "text-yellow-500",
  },
  running: {
    icon: Zap,
    label: "Processing",
    color: "text-blue-500",
  },
  succeeded: {
    icon: CheckCircle2,
    label: "Complete",
    color: "text-green-500",
  },
  failed: {
    icon: XCircle,
    label: "Failed",
    color: "text-destructive",
  },
};

export function JobStatus({ status, className }: JobStatusProps) {
  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <div className={cn("flex items-center gap-2", config.color, className)}>
      <Icon
        className={cn("h-4 w-4", status === "running" && "animate-pulse")}
      />
      <span className="text-sm font-medium">{config.label}</span>
    </div>
  );
}
