/**
 * Validation constants and utilities
 */

export const ALLOWED_AUDIO_TYPES = [
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/m4a",
  "audio/mp4",
] as const;

export const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime"] as const;

export const ALLOWED_TYPES = [
  ...ALLOWED_AUDIO_TYPES,
  ...ALLOWED_VIDEO_TYPES,
] as const;

export const MAX_FILE_SIZE_MB = 500;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
export const MAX_DURATION_SEC = 600; // 10 minutes

export const ANCHOR_LIMITS = {
  MIN_DURATION: 0.25,
  MAX_DURATION: 5.0,
  MAX_COUNT: 6,
} as const;

export const TTL_DAYS = 7;

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateFile(file: File): ValidationResult {
  if (!ALLOWED_TYPES.includes(file.type as (typeof ALLOWED_TYPES)[number])) {
    return { valid: false, error: `File type ${file.type} not supported` };
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return { valid: false, error: `File too large (max ${MAX_FILE_SIZE_MB}MB)` };
  }

  return { valid: true };
}

export function getInputKind(contentType: string): "audio" | "video" {
  return ALLOWED_VIDEO_TYPES.includes(
    contentType as (typeof ALLOWED_VIDEO_TYPES)[number]
  )
    ? "video"
    : "audio";
}

export function normalizePrompt(raw: string): string {
  let normalized = raw.trim();
  if (!normalized) return "";

  const patterns = [
    /^(remove|erase|delete|get rid of|filter out|take out)\s+/i,
    /^(the|a|an)\s+/i,
  ];
  for (const pattern of patterns) {
    normalized = normalized.replace(pattern, "");
  }

  return normalized.toLowerCase().trim();
}

export interface AnchorForValidation {
  kind: string;
  start: number;
  end: number;
}

export function validateAnchors(
  anchors: AnchorForValidation[]
): ValidationResult {
  if (anchors.length > ANCHOR_LIMITS.MAX_COUNT) {
    return {
      valid: false,
      error: `Too many anchors (max ${ANCHOR_LIMITS.MAX_COUNT})`,
    };
  }

  for (const anchor of anchors) {
    if (anchor.end <= anchor.start) {
      return { valid: false, error: "Anchor end must be after start" };
    }
    const duration = anchor.end - anchor.start;
    if (duration < ANCHOR_LIMITS.MIN_DURATION) {
      return {
        valid: false,
        error: `Anchor too short (min ${ANCHOR_LIMITS.MIN_DURATION}s)`,
      };
    }
    if (duration > ANCHOR_LIMITS.MAX_DURATION) {
      return {
        valid: false,
        error: `Anchor too long (max ${ANCHOR_LIMITS.MAX_DURATION}s)`,
      };
    }
  }

  return { valid: true };
}
