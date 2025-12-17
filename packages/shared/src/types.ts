/**
 * Shared types for Hushmark audio separation
 */

export type AnchorKind = "present" | "absent";

export interface Anchor {
  kind: AnchorKind;
  start: number;
  end: number;
}

export type JobStatus =
  | "created"
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

export interface JobCompute {
  queuedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  gpuSeconds?: number;
  rtf?: number;
  durationSec?: number;
}

export type ErrorStep =
  | "download"
  | "extract"
  | "infer"
  | "upload"
  | "remux"
  | "unknown";

export interface JobError {
  message: string;
  step?: ErrorStep;
  detail?: string;
  retryable?: boolean;
}

export type InputKind = "audio" | "video";

// Worker API contracts
export interface WorkerAnchor {
  kind: "+" | "-";
  start: number;
  end: number;
}

export interface SeparateRequest {
  job_id: string;
  input_kind: InputKind;
  input_url: string;
  prompt: string;
  anchors: WorkerAnchor[];
  output_bucket: string;
  output_keys: {
    clean: string;
    removed: string;
    video?: string;
  };
  callback_url: string;
}

export interface WorkerMetrics {
  gpu_seconds: number;
  rtf: number;
  duration_sec: number;
}

export interface CallbackSuccess {
  job_id: string;
  status: "succeeded";
  output_clean_key: string;
  output_removed_key: string;
  output_video_key?: string;
  metrics: WorkerMetrics;
}

export interface CallbackFailure {
  job_id: string;
  status: "failed";
  error: {
    message: string;
    step: string;
    detail?: string;
    retryable: boolean;
  };
}

export type CallbackPayload = CallbackSuccess | CallbackFailure;
