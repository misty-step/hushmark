# DESIGN.md — Hushmark Architecture Specification

> **Comprehensive engineering blueprint for text-prompted audio source separation**

---

## Table of Contents

1. [Product Context](#0-product-context)
2. [Architecture Overview](#1-architecture-overview)
3. [SAM-Audio Model Deep Dive](#2-sam-audio-model-deep-dive)
4. [Modal GPU Worker Specification](#3-modal-gpu-worker-specification)
5. [Convex Backend Design](#4-convex-backend-design)
6. [Cloudflare R2 Storage Design](#5-cloudflare-r2-storage-design)
7. [WaveSurfer.js Waveform Editor](#6-wavesurferjs-waveform-editor)
8. [FFmpeg Media Pipeline](#7-ffmpeg-media-pipeline)
9. [Web Application Design](#8-web-application-design)
10. [Implementation Pseudocode](#9-implementation-pseudocode)
11. [File Organization](#10-file-organization)
12. [Data Structures & Schema](#11-data-structures--schema)
13. [Error Handling Strategy](#12-error-handling-strategy)
14. [Testing Strategy](#13-testing-strategy)
15. [Infrastructure & DevOps](#14-infrastructure--devops)
16. [Security Considerations](#15-security-considerations)
17. [Performance Considerations](#16-performance-considerations)
18. [Alternatives Considered](#17-alternatives-considered)

---

## 0. Product Context

**Problem**: Users need to remove specific unwanted sounds (barking, coughing, sirens, keyboard clicks) from audio/video files without destroying the rest of the audio or requiring DAW expertise.

**Users**: Content creators, podcasters, video editors, journalists who need quick one-sound removal.

**Core Stories**:
1. Upload audio/video → describe unwanted sound → get clean + removed outputs
2. Preview before/after with A/B toggle
3. Mark temporal examples when text prompt isn't precise enough

**Success Metrics**:
- Time-to-first-result < 90s for 60s clip
- 90%+ job success rate for files under limits
- Removed track is recognizable; clean track preserves speech intelligibility

**Non-Goals**: Multitrack editing, batch processing, DAW effects, voice isolation marketing, visual prompting (MVP).

---

## 1. Architecture Overview

### 1.1 Selected Approach

**Turborepo monorepo** with:
- **Next.js 15** (App Router) on Vercel
- **Convex** for database + realtime subscriptions + actions
- **Modal** for serverless GPU inference
- **Cloudflare R2** for object storage
- **Meta SAM-Audio** for sound separation

### 1.2 Rationale

| Decision | Why |
|----------|-----|
| Convex over Neon/Supabase | Built-in realtime subscriptions without polling infrastructure; fastest iteration |
| Modal over RunPod/Lambda | Serverless GPU scaling, Infrastructure-from-Code, no container registry management, memory snapshots for fast cold starts |
| R2 over S3 | Zero egress fees, S3-compatible, Cloudflare CDN integration |
| SAM-Audio over AudioSep | Just released (Dec 2025), unified text/visual/span prompting, SOTA performance, Meta backing |

### 1.3 System Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              HUSHMARK SYSTEM                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐                 │
│  │   Browser   │      │   Vercel    │      │   Convex    │                 │
│  │  (Next.js)  │◄────►│   Edge      │◄────►│  Database   │                 │
│  └──────┬──────┘      └─────────────┘      └──────┬──────┘                 │
│         │                                          │                        │
│         │ Presigned PUT                           │ Action                  │
│         ▼                                          ▼                        │
│  ┌─────────────┐                           ┌─────────────┐                 │
│  │ Cloudflare  │                           │    Modal    │                 │
│  │     R2      │◄─────────────────────────►│ GPU Worker  │                 │
│  │  (Storage)  │  Download/Upload          │ (SAM-Audio) │                 │
│  └─────────────┘                           └──────┬──────┘                 │
│                                                    │                        │
│                                                    │ Callback               │
│                                                    ▼                        │
│                                            ┌─────────────┐                 │
│                                            │   Convex    │                 │
│                                            │ HTTP Action │                 │
│                                            └─────────────┘                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.4 Data Flow (Detailed)

```
1. UPLOAD PHASE
   User → DropZone → [Validate file type/size/duration]
                   → POST Convex action: getUploadUrl()
                   ← { uploadUrl, objectKey, jobId }
                   → PUT to R2 presigned URL (direct upload)
                   → POST Convex mutation: finalizeUpload()
                   → Navigate to /job/{jobId}/describe

2. DESCRIBE PHASE
   User → PromptInput → [Enter "dog barking"]
                      → POST Convex mutation: setPromptAndRun()
                      → [Normalize prompt]
                      → [Update job: status=queued, queuedAt=now]
                      → Convex action: triggerWorker()
                        → Generate presigned input URL
                        → Generate HMAC callback signature
                        → POST to Modal /separate endpoint
                      → Navigate to /job/{jobId}/results

3. PROCESSING PHASE
   Modal Worker:
     → Acknowledge (status=running)
     → Download input from R2
     → If video: ffmpeg extract audio
     → ffmpeg convert to 48kHz mono WAV
     → Load SAM-Audio model (cached on warm container)
     → Run inference with prompt + anchors
     → Normalize outputs (peak -1dB)
     → Apply 5ms fade in/out
     → Save clean.wav, removed.wav
     → If video: ffmpeg remux clean audio into video
     → Upload outputs to R2
     → POST callback to Convex HTTP endpoint

4. CALLBACK PHASE
   Convex HTTP Action:
     → Verify HMAC signature
     → Parse payload
     → Update job: status=succeeded/failed, outputKeys, metrics
     → If failed + retryable: schedule retry

5. RESULTS PHASE (REALTIME)
   Browser:
     → useQuery(jobs.getWithDownloads, { jobId })
     → Convex subscription auto-updates on job change
     → When succeeded: render AudioPlayer with presigned download URLs
     → A/B toggle, removed toggle, download buttons
```

---

## 2. SAM-Audio Model Deep Dive

### 2.1 What is SAM-Audio?

**SAM-Audio** (Segment Anything Model for Audio) was released by Meta AI on **December 16, 2025**. It's a foundation model for isolating any sound from complex audio mixtures using text, visual, or temporal prompts.

**Key Innovation**: Unlike prior models (AudioSep, LASS-Net, CLIPSep), SAM-Audio unifies multiple prompting modalities in one model and achieves SOTA performance across all audio categories.

### 2.2 Architecture

- **Framework**: Flow-matching diffusion transformer
- **Model sizes**: 500M, 1B, 3B parameters (sam-audio-small, base, large)
- **Training data**: 100M+ videos using multimodal contrastive learning
- **Processing speed**: RTF ≈ 0.7 (faster than real-time)

### 2.3 Prompting Methods

| Method | Description | Use Case |
|--------|-------------|----------|
| **Text** | Natural language description | "dog barking", "keyboard clicks" |
| **Visual** | Click on object/person in video | Isolate speaker's voice (not MVP) |
| **Span** | Time segments marking target audio | When text alone isn't precise |

### 2.4 Python API

```python
from sam_audio import SAMAudio, SAMAudioProcessor
import torchaudio
import torch

# Load model (cache on container startup)
device = torch.device("cuda")
model = SAMAudio.from_pretrained("facebook/sam-audio-large").to(device).eval()
processor = SAMAudioProcessor.from_pretrained("facebook/sam-audio-large")

# Text prompting only
inputs = processor(
    audios=["/path/to/audio.wav"],
    descriptions=["dog barking"]
).to(device)

with torch.inference_mode():
    result = model.separate(inputs)

# result.target = isolated sound (what we're removing)
# result.residual = everything else (the "clean" output)

torchaudio.save("removed.wav", result.target[0].unsqueeze(0).cpu(), processor.audio_sampling_rate)
torchaudio.save("clean.wav", result.residual[0].unsqueeze(0).cpu(), processor.audio_sampling_rate)
```

### 2.5 Span Prompting (Temporal Anchors)

```python
# Anchors format: [[kind, start_sec, end_sec], ...]
# "+" = sound present in this range (positive example)
# "-" = sound NOT present in this range (negative example)

anchors = [
    ["+", 6.3, 7.0],   # Dog barking here
    ["+", 12.1, 12.8], # Dog barking here too
    ["-", 0.0, 1.5],   # Only speech here (no dog)
]

inputs = processor(
    audios=[audio_path],
    descriptions=["dog barking"],
    anchors=[anchors]  # Pass as list of anchor lists
).to(device)

result = model.separate(inputs)
```

### 2.6 Model Requirements

| Aspect | Specification |
|--------|--------------|
| **HuggingFace** | `facebook/sam-audio-large` (gated, requires access request) |
| **GPU VRAM** | ~16GB for large model (fits on A10G/L4/A100) |
| **Input format** | Audio file or torch tensor |
| **Sample rate** | `processor.audio_sampling_rate` (likely 48kHz) |
| **Output** | `target` and `residual` tensors |

### 2.7 Known Limitations

1. **No audio prompts** — can't use reference audio clips
2. **Similar sounds** — struggles with single singer from chorus, one instrument from orchestra
3. **Gated access** — requires HuggingFace authentication

### 2.8 Alternatives Evaluated

| Model | Pros | Cons | Decision |
|-------|------|------|----------|
| **SAM-Audio** | SOTA, unified prompting, Meta backing | Brand new (Dec 2025), gated | **Selected** |
| **AudioSep** | Proven, open weights, Replicate API | Text-only, older architecture | Fallback option |
| **DGMO** | Training-free, uses diffusion priors | Lower performance | Not selected |
| **AudioLDM-based** | Generation model repurposed | Not designed for separation | Not selected |

---

## 3. Modal GPU Worker Specification

### 3.1 Why Modal?

- **Infrastructure-from-Code**: Define GPU, dependencies, secrets in Python
- **Memory Snapshots**: Sub-second cold starts by snapshotting GPU VRAM
- **Auto-scaling**: Scales to zero when idle, up on demand
- **Per-second billing**: Pay only for compute time
- **Web endpoints**: Built-in HTTPS endpoints with FastAPI

### 3.2 GPU Selection

| GPU | VRAM | Price/hr | Best For |
|-----|------|----------|----------|
| **T4** | 16GB | ~$0.59 | Budget inference |
| **L4** | 24GB | ~$0.80 | Cost-effective modern |
| **A10G** | 24GB | ~$1.10 | **Recommended for MVP** |
| **L40S** | 48GB | ~$1.50 | Large models |
| **A100-40GB** | 40GB | ~$3.10 | Heavy workloads |
| **H100** | 80GB | ~$5.95 | Maximum performance |

**Recommendation**: Start with **A10G** (24GB VRAM, good cost/performance). SAM-Audio large (~16GB) fits comfortably.

### 3.3 Cold Start Optimization

```python
# Modal uses lifecycle hooks for optimization

@app.cls(
    gpu="A10G",
    timeout=600,
    container_idle_timeout=120,  # Keep warm for 2 min after last request
    min_containers=0,            # Scale to 0 when idle (saves cost)
    # min_containers=1,          # Always warm (higher cost, no cold starts)
)
class AudioSeparator:
    @modal.enter()  # Runs ONCE on container startup
    def load_model(self):
        from sam_audio import SAMAudio, SAMAudioProcessor
        self.model = SAMAudio.from_pretrained("facebook/sam-audio-large").cuda().eval()
        self.processor = SAMAudioProcessor.from_pretrained("facebook/sam-audio-large")
        print("Model loaded!")  # This gets snapshotted

    @modal.web_endpoint(method="POST")
    def separate(self, request: SeparateRequest):
        # Model already loaded, inference runs immediately
        ...
```

**Memory Snapshotting**: Modal can snapshot the loaded model into disk, restoring in <1 second instead of re-downloading weights.

### 3.4 Complete Worker Implementation

```python
# apps/worker/modal_app.py

import modal
import os
import shutil
import subprocess
import time
import json
import traceback
from typing import Optional
from pydantic import BaseModel

# ============================================================================
# IMAGE DEFINITION
# ============================================================================

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git")
    .pip_install(
        "torch>=2.1.0",
        "torchaudio>=2.1.0",
        "transformers>=4.36.0",
        "boto3>=1.34.0",
        "httpx>=0.25.0",
        "fastapi>=0.104.0",
        "pydantic>=2.5.0",
    )
    # Pre-download model weights into image (bakes into layer)
    .run_commands(
        "python -c \"from sam_audio import SAMAudio, SAMAudioProcessor; "
        "SAMAudio.from_pretrained('facebook/sam-audio-large'); "
        "SAMAudioProcessor.from_pretrained('facebook/sam-audio-large')\""
    )
)

app = modal.App("hushmark-worker", image=image)

# ============================================================================
# REQUEST/RESPONSE MODELS
# ============================================================================

class Anchor(BaseModel):
    kind: str  # "+" or "-"
    start: float
    end: float

class OutputKeys(BaseModel):
    clean: str
    removed: str
    video: Optional[str] = None

class SeparateRequest(BaseModel):
    job_id: str
    input_kind: str  # "audio" or "video"
    input_url: str   # Presigned download URL
    prompt: str
    anchors: list[Anchor]
    output_bucket: str
    output_keys: OutputKeys
    callback_url: str

class Metrics(BaseModel):
    gpu_seconds: float
    rtf: float
    duration_sec: float

class ErrorDetail(BaseModel):
    message: str
    step: str
    detail: Optional[str] = None
    retryable: bool

class CallbackPayload(BaseModel):
    job_id: str
    status: str  # "succeeded" or "failed"
    output_clean_key: Optional[str] = None
    output_removed_key: Optional[str] = None
    output_video_key: Optional[str] = None
    metrics: Optional[Metrics] = None
    error: Optional[ErrorDetail] = None

# ============================================================================
# WORKER CLASS
# ============================================================================

@app.cls(
    gpu="A10G",
    timeout=600,  # 10 minute max
    container_idle_timeout=120,  # Keep warm 2 min
    min_containers=0,  # Scale to zero
    secrets=[modal.Secret.from_name("hushmark-secrets")],
)
class AudioSeparator:
    """GPU worker for SAM-Audio inference."""

    @modal.enter()
    def load_model(self):
        """Load model once on container startup (gets snapshotted)."""
        import torch
        from sam_audio import SAMAudio, SAMAudioProcessor

        self.device = torch.device("cuda")
        self.model = SAMAudio.from_pretrained("facebook/sam-audio-large").to(self.device).eval()
        self.processor = SAMAudioProcessor.from_pretrained("facebook/sam-audio-large")
        print(f"Model loaded on {self.device}")

    @modal.web_endpoint(method="POST", docs=True)
    async def separate(self, request: SeparateRequest) -> dict:
        """
        Main separation endpoint.

        1. Download input
        2. Extract/convert audio
        3. Run SAM-Audio inference
        4. Post-process outputs
        5. Upload to R2
        6. Callback to Convex
        """
        import torch
        import torchaudio
        import httpx
        import boto3
        from botocore.config import Config

        job_id = request.job_id
        work_dir = f"/tmp/{job_id}"
        os.makedirs(work_dir, exist_ok=True)
        start_time = time.time()

        try:
            # ------------------------------------------------------------------
            # 1. DOWNLOAD INPUT
            # ------------------------------------------------------------------
            input_ext = ".mp4" if request.input_kind == "video" else ".wav"
            input_path = f"{work_dir}/input{input_ext}"

            async with httpx.AsyncClient(timeout=300) as client:
                response = await client.get(request.input_url)
                response.raise_for_status()
                with open(input_path, "wb") as f:
                    f.write(response.content)

            # ------------------------------------------------------------------
            # 2. EXTRACT/CONVERT AUDIO
            # ------------------------------------------------------------------
            audio_path = f"{work_dir}/audio.wav"

            if request.input_kind == "video":
                # Extract audio from video: mono, 48kHz, PCM
                cmd = [
                    "ffmpeg", "-y",
                    "-i", input_path,
                    "-vn",  # No video
                    "-acodec", "pcm_s16le",
                    "-ar", "48000",
                    "-ac", "1",  # Mono
                    audio_path
                ]
            else:
                # Convert audio to standard format
                cmd = [
                    "ffmpeg", "-y",
                    "-i", input_path,
                    "-acodec", "pcm_s16le",
                    "-ar", "48000",
                    "-ac", "1",
                    audio_path
                ]

            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode != 0:
                raise RuntimeError(f"ffmpeg failed: {result.stderr}")

            # Get duration
            probe_cmd = [
                "ffprobe", "-v", "quiet",
                "-print_format", "json",
                "-show_format",
                audio_path
            ]
            probe_result = subprocess.run(probe_cmd, capture_output=True, text=True)
            probe_data = json.loads(probe_result.stdout)
            duration_sec = float(probe_data["format"]["duration"])

            # ------------------------------------------------------------------
            # 3. RUN SAM-AUDIO INFERENCE
            # ------------------------------------------------------------------
            # Format anchors: [[kind, start, end], ...]
            anchors_formatted = [
                [a.kind, a.start, a.end] for a in request.anchors
            ] if request.anchors else None

            # Prepare inputs
            inputs = self.processor(
                audios=[audio_path],
                descriptions=[request.prompt],
                anchors=[anchors_formatted] if anchors_formatted else None
            ).to(self.device)

            # Run inference
            with torch.inference_mode():
                result = self.model.separate(inputs)

            target = result.target[0]    # What we're removing
            residual = result.residual[0]  # The "clean" output

            # ------------------------------------------------------------------
            # 4. POST-PROCESS OUTPUTS
            # ------------------------------------------------------------------
            # Peak normalize to -1 dBFS
            def normalize_audio(audio: torch.Tensor, peak_db: float = -1.0) -> torch.Tensor:
                peak = audio.abs().max()
                if peak > 0:
                    target_peak = 10 ** (peak_db / 20)
                    audio = audio * (target_peak / peak)
                return audio.clamp(-1.0, 1.0)

            # Apply 5ms fade in/out to prevent clicks
            def apply_fade(audio: torch.Tensor, sample_rate: int, fade_ms: int = 5) -> torch.Tensor:
                fade_samples = int(sample_rate * fade_ms / 1000)
                if fade_samples > 0 and audio.shape[-1] > fade_samples * 2:
                    # Fade in
                    fade_in = torch.linspace(0, 1, fade_samples, device=audio.device)
                    audio[..., :fade_samples] *= fade_in
                    # Fade out
                    fade_out = torch.linspace(1, 0, fade_samples, device=audio.device)
                    audio[..., -fade_samples:] *= fade_out
                return audio

            sample_rate = self.processor.audio_sampling_rate

            clean = normalize_audio(residual, peak_db=-1.0)
            clean = apply_fade(clean, sample_rate, fade_ms=5)

            removed = normalize_audio(target, peak_db=-1.0)
            removed = apply_fade(removed, sample_rate, fade_ms=5)

            # Save outputs
            clean_path = f"{work_dir}/clean.wav"
            removed_path = f"{work_dir}/removed.wav"

            torchaudio.save(clean_path, clean.unsqueeze(0).cpu(), sample_rate)
            torchaudio.save(removed_path, removed.unsqueeze(0).cpu(), sample_rate)

            # ------------------------------------------------------------------
            # 5. REMUX VIDEO (if input was video)
            # ------------------------------------------------------------------
            video_path = None
            if request.input_kind == "video" and request.output_keys.video:
                video_path = f"{work_dir}/clean.mp4"
                remux_cmd = [
                    "ffmpeg", "-y",
                    "-i", input_path,
                    "-i", clean_path,
                    "-c:v", "copy",  # Don't re-encode video
                    "-c:a", "aac",
                    "-b:a", "192k",
                    "-map", "0:v:0",  # Video from original
                    "-map", "1:a:0",  # Audio from clean
                    "-shortest",
                    video_path
                ]
                result = subprocess.run(remux_cmd, capture_output=True, text=True)
                if result.returncode != 0:
                    raise RuntimeError(f"Remux failed: {result.stderr}")

            # ------------------------------------------------------------------
            # 6. UPLOAD TO R2
            # ------------------------------------------------------------------
            s3 = boto3.client(
                "s3",
                endpoint_url=f"https://{os.environ['CLOUDFLARE_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
                region_name="auto",
                config=Config(signature_version="s3v4"),
            )

            bucket = request.output_bucket

            # Upload clean audio
            s3.upload_file(clean_path, bucket, request.output_keys.clean)

            # Upload removed audio
            s3.upload_file(removed_path, bucket, request.output_keys.removed)

            # Upload clean video (if applicable)
            if video_path and request.output_keys.video:
                s3.upload_file(video_path, bucket, request.output_keys.video)

            # ------------------------------------------------------------------
            # 7. CALCULATE METRICS
            # ------------------------------------------------------------------
            gpu_seconds = time.time() - start_time
            rtf = gpu_seconds / duration_sec  # Real-time factor

            # ------------------------------------------------------------------
            # 8. CALLBACK SUCCESS
            # ------------------------------------------------------------------
            callback_payload = CallbackPayload(
                job_id=job_id,
                status="succeeded",
                output_clean_key=request.output_keys.clean,
                output_removed_key=request.output_keys.removed,
                output_video_key=request.output_keys.video if video_path else None,
                metrics=Metrics(
                    gpu_seconds=gpu_seconds,
                    rtf=rtf,
                    duration_sec=duration_sec,
                ),
            )

            async with httpx.AsyncClient(timeout=30) as client:
                await client.post(
                    request.callback_url,
                    json=callback_payload.model_dump(),
                    headers={"Content-Type": "application/json"},
                )

            return {"status": "succeeded", "job_id": job_id}

        except Exception as e:
            # ------------------------------------------------------------------
            # ERROR HANDLING
            # ------------------------------------------------------------------
            error_msg = str(e)
            step = self._classify_error_step(error_msg)
            retryable = self._is_retryable(error_msg)

            callback_payload = CallbackPayload(
                job_id=job_id,
                status="failed",
                error=ErrorDetail(
                    message=error_msg,
                    step=step,
                    detail=traceback.format_exc(),
                    retryable=retryable,
                ),
            )

            try:
                async with httpx.AsyncClient(timeout=30) as client:
                    await client.post(
                        request.callback_url,
                        json=callback_payload.model_dump(),
                        headers={"Content-Type": "application/json"},
                    )
            except Exception:
                pass  # Best effort callback

            return {"status": "failed", "job_id": job_id, "error": error_msg}

        finally:
            # Cleanup temp files
            shutil.rmtree(work_dir, ignore_errors=True)

    def _classify_error_step(self, error_msg: str) -> str:
        """Classify which step failed based on error message."""
        msg = error_msg.lower()
        if any(x in msg for x in ["download", "url", "http", "connection"]):
            return "download"
        if any(x in msg for x in ["ffmpeg", "codec", "format", "extract"]):
            return "extract"
        if any(x in msg for x in ["cuda", "model", "inference", "tensor", "sam"]):
            return "infer"
        if any(x in msg for x in ["upload", "s3", "r2", "bucket"]):
            return "upload"
        if any(x in msg for x in ["remux", "video"]):
            return "remux"
        return "unknown"

    def _is_retryable(self, error_msg: str) -> bool:
        """Determine if error is retryable."""
        msg = error_msg.lower()
        # Not retryable: codec issues, format errors, OOM
        if any(x in msg for x in ["unsupported", "codec", "invalid format", "out of memory"]):
            return False
        # Retryable: network, transient failures
        return True


# ============================================================================
# HEALTH CHECK
# ============================================================================

@app.function()
@modal.web_endpoint(method="GET")
def health():
    return {"status": "healthy", "service": "hushmark-worker"}
```

### 3.5 Deployment Commands

```bash
# Development (hot-reload)
modal serve apps/worker/modal_app.py

# Production deployment
modal deploy apps/worker/modal_app.py

# View logs
modal app logs hushmark-worker

# Open shell in container (debugging)
modal shell apps/worker/modal_app.py
```

### 3.6 Secrets Configuration

Create secrets in Modal Dashboard or CLI:

```bash
modal secret create hushmark-secrets \
  CLOUDFLARE_ACCOUNT_ID=<your-account-id> \
  R2_ACCESS_KEY_ID=<your-access-key> \
  R2_SECRET_ACCESS_KEY=<your-secret-key> \
  HF_TOKEN=<your-huggingface-token>
```

---

## 4. Convex Backend Design

### 4.1 Why Convex?

- **Automatic Realtime**: `useQuery()` becomes live subscription without WebSocket code
- **ACID Transactions**: Mutations are transactional
- **TypeScript-first**: Full type safety from database to client
- **Actions**: Call external APIs (Modal, R2) from server
- **HTTP Actions**: Receive webhooks (worker callbacks)
- **Scheduler**: Schedule delayed/recurring jobs

### 4.2 Schema Definition

```typescript
// convex/schema.ts

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Shared validators
const anchorValidator = v.object({
  kind: v.union(v.literal("present"), v.literal("absent")),
  start: v.number(),
  end: v.number(),
});

const computeValidator = v.object({
  queuedAt: v.optional(v.number()),
  startedAt: v.optional(v.number()),
  finishedAt: v.optional(v.number()),
  gpuSeconds: v.optional(v.number()),
  rtf: v.optional(v.number()),
  durationSec: v.optional(v.number()),
});

const errorValidator = v.object({
  message: v.string(),
  step: v.optional(v.string()),
  detail: v.optional(v.string()),
  retryable: v.optional(v.boolean()),
});

export default defineSchema({
  jobs: defineTable({
    // Status
    status: v.union(
      v.literal("created"),
      v.literal("queued"),
      v.literal("running"),
      v.literal("succeeded"),
      v.literal("failed")
    ),

    // Ownership
    sessionId: v.string(),
    userId: v.optional(v.string()),

    // Input metadata
    inputKind: v.union(v.literal("audio"), v.literal("video")),
    inputObjectKey: v.string(),
    inputFilename: v.string(),
    inputSizeBytes: v.number(),
    inputContentType: v.string(),

    // Prompting
    promptRaw: v.optional(v.string()),
    promptNormalized: v.optional(v.string()),
    anchors: v.array(anchorValidator),

    // Outputs
    outputCleanKey: v.optional(v.string()),
    outputRemovedKey: v.optional(v.string()),
    outputVideoKey: v.optional(v.string()),

    // Observability
    compute: v.optional(computeValidator),
    error: v.optional(errorValidator),
    retryCount: v.optional(v.number()),

    // Lifecycle
    expiresAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_status", ["status"])
    .index("by_expires", ["expiresAt"]),
});
```

### 4.3 Job Mutations

```typescript
// convex/jobs.ts

import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { internal, api } from "./_generated/api";

// ============================================================================
// CONSTANTS
// ============================================================================

const TTL_DAYS = 7;
const MAX_RETRIES = 2;

// ============================================================================
// HELPERS
// ============================================================================

function normalizePrompt(raw: string): string {
  let normalized = raw.trim();
  if (!normalized) return "";

  // Strip leading action verbs
  const patterns = [
    /^(remove|erase|delete|get rid of|filter out|take out)\s+/i,
    /^(the|a|an)\s+/i,
  ];
  for (const pattern of patterns) {
    normalized = normalized.replace(pattern, "");
  }

  return normalized.toLowerCase().trim();
}

function validateAnchors(anchors: Array<{ kind: string; start: number; end: number }>) {
  const MIN_DURATION = 0.25;
  const MAX_DURATION = 5.0;
  const MAX_ANCHORS = 6;

  if (anchors.length > MAX_ANCHORS) {
    throw new Error(`Too many anchors (max ${MAX_ANCHORS})`);
  }

  for (const anchor of anchors) {
    if (anchor.end <= anchor.start) {
      throw new Error("Anchor end must be after start");
    }
    const duration = anchor.end - anchor.start;
    if (duration < MIN_DURATION) {
      throw new Error(`Anchor too short (min ${MIN_DURATION}s)`);
    }
    if (duration > MAX_DURATION) {
      throw new Error(`Anchor too long (max ${MAX_DURATION}s)`);
    }
  }
}

// ============================================================================
// MUTATIONS
// ============================================================================

export const create = mutation({
  args: {
    sessionId: v.string(),
    inputObjectKey: v.string(),
    inputFilename: v.string(),
    inputSizeBytes: v.number(),
    inputContentType: v.string(),
    inputKind: v.union(v.literal("audio"), v.literal("video")),
  },
  handler: async (ctx, args) => {
    const expiresAt = Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000;

    const jobId = await ctx.db.insert("jobs", {
      status: "created",
      sessionId: args.sessionId,
      inputKind: args.inputKind,
      inputObjectKey: args.inputObjectKey,
      inputFilename: args.inputFilename,
      inputSizeBytes: args.inputSizeBytes,
      inputContentType: args.inputContentType,
      anchors: [],
      expiresAt,
    });

    return jobId;
  },
});

export const setPromptAndRun = mutation({
  args: {
    jobId: v.id("jobs"),
    sessionId: v.string(),
    promptRaw: v.string(),
    anchors: v.array(v.object({
      kind: v.union(v.literal("present"), v.literal("absent")),
      start: v.number(),
      end: v.number(),
    })),
  },
  handler: async (ctx, args) => {
    // Fetch job
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Job not found");
    if (job.sessionId !== args.sessionId) throw new Error("Access denied");
    if (job.status !== "created" && job.status !== "failed") {
      throw new Error(`Cannot run job in ${job.status} state`);
    }

    // Validate
    if (!args.promptRaw.trim()) throw new Error("Prompt is required");
    validateAnchors(args.anchors);

    // Normalize prompt
    const promptNormalized = normalizePrompt(args.promptRaw);

    // Update job
    await ctx.db.patch(args.jobId, {
      status: "queued",
      promptRaw: args.promptRaw,
      promptNormalized,
      anchors: args.anchors,
      compute: {
        queuedAt: Date.now(),
      },
      error: undefined,  // Clear previous error
    });

    // Schedule worker trigger (non-blocking)
    await ctx.scheduler.runAfter(0, internal.jobs.triggerWorker, {
      jobId: args.jobId,
    });

    return args.jobId;
  },
});

export const rerun = mutation({
  args: {
    jobId: v.id("jobs"),
    sessionId: v.string(),
    promptRaw: v.optional(v.string()),
    anchors: v.optional(v.array(v.object({
      kind: v.union(v.literal("present"), v.literal("absent")),
      start: v.number(),
      end: v.number(),
    }))),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Job not found");
    if (job.sessionId !== args.sessionId) throw new Error("Access denied");

    // Use existing values if not provided
    const promptRaw = args.promptRaw ?? job.promptRaw;
    const anchors = args.anchors ?? job.anchors;

    if (!promptRaw) throw new Error("Prompt is required");
    validateAnchors(anchors);

    const promptNormalized = normalizePrompt(promptRaw);

    await ctx.db.patch(args.jobId, {
      status: "queued",
      promptRaw,
      promptNormalized,
      anchors,
      compute: {
        queuedAt: Date.now(),
      },
      error: undefined,
      retryCount: 0,
    });

    await ctx.scheduler.runAfter(0, internal.jobs.triggerWorker, {
      jobId: args.jobId,
    });

    return args.jobId;
  },
});

// ============================================================================
// QUERIES
// ============================================================================

export const get = query({
  args: {
    jobId: v.id("jobs"),
    sessionId: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    if (job.sessionId !== args.sessionId) return null;
    return job;
  },
});

// ============================================================================
// INTERNAL MUTATIONS (for HTTP actions and scheduler)
// ============================================================================

export const handleWorkerCallback = internalMutation({
  args: {
    jobId: v.id("jobs"),
    status: v.union(v.literal("succeeded"), v.literal("failed")),
    outputCleanKey: v.optional(v.string()),
    outputRemovedKey: v.optional(v.string()),
    outputVideoKey: v.optional(v.string()),
    metrics: v.optional(v.object({
      gpuSeconds: v.number(),
      rtf: v.number(),
      durationSec: v.number(),
    })),
    error: v.optional(v.object({
      message: v.string(),
      step: v.optional(v.string()),
      detail: v.optional(v.string()),
      retryable: v.optional(v.boolean()),
    })),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Job not found");

    const now = Date.now();

    if (args.status === "succeeded") {
      await ctx.db.patch(args.jobId, {
        status: "succeeded",
        outputCleanKey: args.outputCleanKey,
        outputRemovedKey: args.outputRemovedKey,
        outputVideoKey: args.outputVideoKey,
        compute: {
          ...job.compute,
          finishedAt: now,
          gpuSeconds: args.metrics?.gpuSeconds,
          rtf: args.metrics?.rtf,
          durationSec: args.metrics?.durationSec,
        },
      });
    } else {
      // Failed
      const retryCount = (job.retryCount ?? 0) + 1;
      const shouldRetry = args.error?.retryable && retryCount <= MAX_RETRIES;

      await ctx.db.patch(args.jobId, {
        status: shouldRetry ? "queued" : "failed",
        error: args.error,
        retryCount,
        compute: {
          ...job.compute,
          finishedAt: now,
        },
      });

      // Schedule retry
      if (shouldRetry) {
        const delay = retryCount * 5000;  // 5s, 10s backoff
        await ctx.scheduler.runAfter(delay, internal.jobs.triggerWorker, {
          jobId: args.jobId,
        });
      }
    }
  },
});

export const setRunning = internalMutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.jobId, {
      status: "running",
      compute: {
        startedAt: Date.now(),
      },
    });
  },
});
```

### 4.4 Storage Actions

```typescript
// convex/storage.ts

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// ============================================================================
// R2 CLIENT
// ============================================================================

function getR2Client() {
  return new S3Client({
    region: "auto",
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

// ============================================================================
// ACTIONS
// ============================================================================

export const getUploadUrl = action({
  args: {
    jobId: v.string(),
    filename: v.string(),
    contentType: v.string(),
  },
  handler: async (ctx, args) => {
    const r2 = getR2Client();

    // Determine extension from content type
    const extMap: Record<string, string> = {
      "audio/wav": ".wav",
      "audio/x-wav": ".wav",
      "audio/mpeg": ".mp3",
      "audio/mp3": ".mp3",
      "audio/m4a": ".m4a",
      "audio/mp4": ".m4a",
      "video/mp4": ".mp4",
      "video/quicktime": ".mov",
    };
    const ext = extMap[contentType] || "";

    const objectKey = `inputs/${args.jobId}/source${ext}`;

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: objectKey,
      ContentType: args.contentType,
    });

    const uploadUrl = await getSignedUrl(r2, command, { expiresIn: 3600 });

    return {
      objectKey,
      uploadUrl,
      expiresAt: Date.now() + 3600 * 1000,
    };
  },
});

export const getDownloadUrl = action({
  args: {
    objectKey: v.string(),
  },
  handler: async (ctx, args) => {
    const r2 = getR2Client();

    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: args.objectKey,
    });

    const downloadUrl = await getSignedUrl(r2, command, { expiresIn: 3600 });

    return downloadUrl;
  },
});

export const getMultipleDownloadUrls = action({
  args: {
    objectKeys: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const r2 = getR2Client();
    const bucket = process.env.R2_BUCKET!;

    const urls: Record<string, string> = {};

    for (const key of args.objectKeys) {
      if (key) {
        const command = new GetObjectCommand({ Bucket: bucket, Key: key });
        urls[key] = await getSignedUrl(r2, command, { expiresIn: 3600 });
      }
    }

    return urls;
  },
});
```

### 4.5 Worker Trigger Action

```typescript
// convex/jobs.ts (continued)

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import crypto from "crypto";

export const triggerWorker = internalAction({
  args: {
    jobId: v.id("jobs"),
  },
  handler: async (ctx, args) => {
    // Fetch job
    const job = await ctx.runQuery(internal.jobs.getInternal, { jobId: args.jobId });
    if (!job) throw new Error("Job not found");

    // Get presigned input URL
    const inputUrl = await ctx.runAction(internal.storage.getDownloadUrlInternal, {
      objectKey: job.inputObjectKey,
    });

    // Generate HMAC signature for callback
    const callbackSecret = process.env.WORKER_CALLBACK_SECRET!;
    const callbackPayload = JSON.stringify({ jobId: args.jobId });
    const signature = crypto
      .createHmac("sha256", callbackSecret)
      .update(callbackPayload)
      .digest("hex");

    const callbackUrl = `${process.env.CONVEX_SITE_URL}/worker/callback?jobId=${args.jobId}&sig=${signature}`;

    // Build output keys
    const cleanKey = `outputs/${args.jobId}/clean.wav`;
    const removedKey = `outputs/${args.jobId}/removed.wav`;
    const videoKey = job.inputKind === "video" ? `outputs/${args.jobId}/clean.mp4` : undefined;

    // Format anchors for worker
    const anchors = job.anchors.map((a: { kind: string; start: number; end: number }) => ({
      kind: a.kind === "present" ? "+" : "-",
      start: a.start,
      end: a.end,
    }));

    // POST to Modal worker
    const workerUrl = process.env.MODAL_WORKER_URL!;
    const response = await fetch(`${workerUrl}/separate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        job_id: args.jobId,
        input_kind: job.inputKind,
        input_url: inputUrl,
        prompt: job.promptNormalized,
        anchors,
        output_bucket: process.env.R2_BUCKET,
        output_keys: {
          clean: cleanKey,
          removed: removedKey,
          video: videoKey,
        },
        callback_url: callbackUrl,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Worker request failed: ${error}`);
    }

    // Mark as running
    await ctx.runMutation(internal.jobs.setRunning, { jobId: args.jobId });
  },
});

export const getInternal = internalQuery({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.jobId);
  },
});
```

### 4.6 HTTP Actions (Worker Callback)

```typescript
// convex/http.ts

import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import crypto from "crypto";

const http = httpRouter();

// ============================================================================
// WORKER CALLBACK
// ============================================================================

http.route({
  path: "/worker/callback",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Extract query params
    const url = new URL(request.url);
    const jobId = url.searchParams.get("jobId");
    const signature = url.searchParams.get("sig");

    if (!jobId || !signature) {
      return new Response("Missing jobId or signature", { status: 400 });
    }

    // Verify HMAC signature
    const callbackSecret = process.env.WORKER_CALLBACK_SECRET!;
    const expectedPayload = JSON.stringify({ jobId });
    const expectedSignature = crypto
      .createHmac("sha256", callbackSecret)
      .update(expectedPayload)
      .digest("hex");

    if (signature !== expectedSignature) {
      return new Response("Invalid signature", { status: 401 });
    }

    // Parse body
    const body = await request.json();

    // Update job
    await ctx.runMutation(internal.jobs.handleWorkerCallback, {
      jobId: jobId as any,  // Type cast for Convex ID
      status: body.status,
      outputCleanKey: body.output_clean_key,
      outputRemovedKey: body.output_removed_key,
      outputVideoKey: body.output_video_key,
      metrics: body.metrics ? {
        gpuSeconds: body.metrics.gpu_seconds,
        rtf: body.metrics.rtf,
        durationSec: body.metrics.duration_sec,
      } : undefined,
      error: body.error ? {
        message: body.error.message,
        step: body.error.step,
        detail: body.error.detail,
        retryable: body.error.retryable,
      } : undefined,
    });

    return new Response("OK", { status: 200 });
  }),
});

// ============================================================================
// CORS PREFLIGHT
// ============================================================================

http.route({
  path: "/worker/callback",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

export default http;
```

---

## 5. Cloudflare R2 Storage Design

### 5.1 Why R2?

| Feature | R2 | S3 |
|---------|----|----|
| **Egress** | **$0 (free)** | $0.09/GB |
| **Storage** | $0.015/GB/mo | $0.023/GB/mo |
| **Ops (write)** | $4.50/1M | $5.00/1M |
| **Ops (read)** | $0.36/1M | $0.40/1M |
| **CDN** | Built-in (Cloudflare) | Requires CloudFront |

### 5.2 Bucket Structure

```
hushmark/
├── inputs/
│   └── {jobId}/
│       └── source.{mp3|mp4|wav|m4a|mov}
└── outputs/
    └── {jobId}/
        ├── clean.wav
        ├── removed.wav
        └── clean.mp4  (if video input)
```

### 5.3 Lifecycle Rules

```json
{
  "Rules": [
    {
      "ID": "Delete-Inputs",
      "Status": "Enabled",
      "Filter": { "Prefix": "inputs/" },
      "Expiration": { "Days": 7 }
    },
    {
      "ID": "Delete-Outputs",
      "Status": "Enabled",
      "Filter": { "Prefix": "outputs/" },
      "Expiration": { "Days": 7 }
    },
    {
      "ID": "Abort-Incomplete-Multipart",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }
  ]
}
```

### 5.4 CORS Configuration

```json
[
  {
    "AllowedOrigins": [
      "https://hushmark.app",
      "https://*.vercel.app",
      "http://localhost:3000"
    ],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["Content-Type", "x-amz-*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

### 5.5 Presigned URL Generation (TypeScript)

```typescript
// lib/r2.ts

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export function createR2Client() {
  return new S3Client({
    region: "auto",
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

export async function generateUploadUrl(
  client: S3Client,
  key: string,
  contentType: string,
  expiresIn = 3600
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET!,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(client, command, { expiresIn });
}

export async function generateDownloadUrl(
  client: S3Client,
  key: string,
  expiresIn = 3600
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET!,
    Key: key,
  });
  return getSignedUrl(client, command, { expiresIn });
}
```

### 5.6 Direct Browser Upload

```typescript
// Client-side upload using presigned URL

async function uploadFile(file: File, uploadUrl: string): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    body: file,
    headers: {
      "Content-Type": file.type,
    },
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status}`);
  }
}
```

---

## 6. WaveSurfer.js Waveform Editor

### 6.1 Why WaveSurfer.js v7?

- **Shadow DOM**: Isolated styling, no CSS conflicts
- **TypeScript**: Full type definitions
- **Regions Plugin**: Built-in support for selectable time spans
- **Performance**: Optimized canvas rendering
- **Active maintenance**: v7 is current standard (2024-2025)

### 6.2 Installation

```bash
pnpm add wavesurfer.js
```

### 6.3 Complete React Component

```typescript
// components/waveform/waveform-editor.tsx

"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { Region } from "wavesurfer.js/dist/plugins/regions.esm.js";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Play, Pause, Plus, Trash2, ZoomIn, ZoomOut } from "lucide-react";

// ============================================================================
// TYPES
// ============================================================================

export interface Anchor {
  kind: "present" | "absent";
  start: number;
  end: number;
}

interface WaveformEditorProps {
  audioUrl: string;
  anchors: Anchor[];
  onAnchorsChange: (anchors: Anchor[]) => void;
  maxAnchors?: number;
}

// ============================================================================
// COMPONENT
// ============================================================================

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
  const [markingMode, setMarkingMode] = useState<"present" | "absent" | null>(null);

  // --------------------------------------------------------------------------
  // INITIALIZATION
  // --------------------------------------------------------------------------

  useEffect(() => {
    if (!containerRef.current) return;

    // Create Regions plugin
    const regions = RegionsPlugin.create();
    regionsRef.current = regions;

    // Create WaveSurfer instance
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

    // Load audio
    ws.load(audioUrl);

    // Event listeners
    ws.on("ready", () => {
      setIsReady(true);
      setDuration(ws.getDuration());

      // Restore existing anchors as regions
      anchors.forEach((anchor, index) => {
        regions.addRegion({
          id: `anchor-${index}`,
          start: anchor.start,
          end: anchor.end,
          color: anchor.kind === "present"
            ? "rgba(0, 200, 100, 0.3)"
            : "rgba(200, 100, 0, 0.3)",
          drag: true,
          resize: true,
          content: anchor.kind === "present" ? "Sound present" : "Sound absent",
        });
      });
    });

    ws.on("play", () => setIsPlaying(true));
    ws.on("pause", () => setIsPlaying(false));
    ws.on("timeupdate", (time) => setCurrentTime(time));

    // Region events
    regions.on("region-updated", (region: Region) => {
      syncRegionsToAnchors();
    });

    regions.on("region-clicked", (region: Region, e: MouseEvent) => {
      e.stopPropagation();
      region.play();
    });

    // Cleanup
    return () => {
      ws.destroy();
    };
  }, [audioUrl]);

  // --------------------------------------------------------------------------
  // ZOOM
  // --------------------------------------------------------------------------

  useEffect(() => {
    if (wavesurferRef.current && isReady) {
      wavesurferRef.current.zoom(zoom);
    }
  }, [zoom, isReady]);

  // --------------------------------------------------------------------------
  // HELPERS
  // --------------------------------------------------------------------------

  const syncRegionsToAnchors = useCallback(() => {
    if (!regionsRef.current) return;

    const regions = regionsRef.current.getRegions();
    const newAnchors: Anchor[] = regions.map((region) => ({
      kind: region.color?.includes("0, 200, 100") ? "present" : "absent",
      start: region.start,
      end: region.end,
    }));

    onAnchorsChange(newAnchors);
  }, [onAnchorsChange]);

  const addRegion = useCallback((kind: "present" | "absent") => {
    if (!regionsRef.current || !wavesurferRef.current) return;
    if (anchors.length >= maxAnchors) return;

    const current = wavesurferRef.current.getCurrentTime();
    const end = Math.min(current + 2, duration); // 2 second default

    regionsRef.current.addRegion({
      id: `anchor-${Date.now()}`,
      start: current,
      end: end,
      color: kind === "present"
        ? "rgba(0, 200, 100, 0.3)"
        : "rgba(200, 100, 0, 0.3)",
      drag: true,
      resize: true,
      content: kind === "present" ? "Sound present" : "Sound absent",
    });

    syncRegionsToAnchors();
  }, [anchors.length, maxAnchors, duration, syncRegionsToAnchors]);

  const clearAllRegions = useCallback(() => {
    if (!regionsRef.current) return;
    regionsRef.current.clearRegions();
    onAnchorsChange([]);
  }, [onAnchorsChange]);

  const togglePlay = useCallback(() => {
    wavesurferRef.current?.playPause();
  }, []);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  // --------------------------------------------------------------------------
  // RENDER
  // --------------------------------------------------------------------------

  return (
    <div className="space-y-4">
      {/* Waveform */}
      <div
        ref={containerRef}
        className="w-full rounded-lg border bg-muted/30"
        style={{ minHeight: 128 }}
      />

      {/* Time display */}
      <div className="flex justify-between text-sm text-muted-foreground font-mono">
        <span>{formatTime(currentTime)}</span>
        <span>{formatTime(duration)}</span>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Playback */}
        <Button
          variant="outline"
          size="icon"
          onClick={togglePlay}
          disabled={!isReady}
        >
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
        Mark 1-3 short regions (0.5-2s) where the sound is present, and optionally where it's absent.
        Drag edges to resize, drag center to move.
      </p>
    </div>
  );
}
```

### 6.4 Performance for Long Audio

For audio > 5 minutes, pre-generate peaks server-side:

```python
# Generate peaks with audiowaveform CLI
audiowaveform -i input.wav -o peaks.json --pixels-per-second 20
```

```typescript
// Pass pre-generated peaks to WaveSurfer
WaveSurfer.create({
  container: containerRef.current,
  url: audioUrl,
  peaks: peaksData,  // Pre-loaded JSON
  // ...
});
```

---

## 7. FFmpeg Media Pipeline

### 7.1 Commands Reference

| Operation | Command |
|-----------|---------|
| **Extract audio (mono, 48kHz)** | `ffmpeg -i input.mp4 -vn -acodec pcm_s16le -ar 48000 -ac 1 output.wav` |
| **Convert to WAV** | `ffmpeg -i input.mp3 -acodec pcm_s16le -ar 48000 -ac 1 output.wav` |
| **Remux video** | `ffmpeg -i video.mp4 -i audio.wav -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 -shortest output.mp4` |
| **Get duration** | `ffprobe -v quiet -print_format json -show_format input.wav` |
| **Normalize (EBU R128)** | `ffmpeg -i input.wav -af loudnorm=I=-16:TP=-1.5:LRA=11 output.wav` |
| **Fade in/out** | `ffmpeg -i input.wav -af "afade=t=in:d=0.005,afade=t=out:st={dur-0.005}:d=0.005" output.wav` |

### 7.2 Python Wrapper

```python
# apps/worker/media.py

import subprocess
import json
import os
from typing import Optional

class FFmpegProcessor:
    def __init__(self, ffmpeg_bin: str = "ffmpeg", ffprobe_bin: str = "ffprobe"):
        self.ffmpeg = ffmpeg_bin
        self.ffprobe = ffprobe_bin

    def _run(self, cmd: list[str]) -> subprocess.CompletedProcess:
        """Run command with error handling."""
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg error: {result.stderr}")
        return result

    def get_duration(self, file_path: str) -> float:
        """Get audio/video duration in seconds."""
        cmd = [
            self.ffprobe, "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            file_path
        ]
        result = self._run(cmd)
        data = json.loads(result.stdout)
        return float(data["format"]["duration"])

    def extract_audio(
        self,
        input_path: str,
        output_path: str,
        sample_rate: int = 48000,
        channels: int = 1
    ) -> None:
        """Extract audio from video, convert to mono PCM WAV."""
        cmd = [
            self.ffmpeg, "-y",
            "-i", input_path,
            "-vn",  # No video
            "-acodec", "pcm_s16le",
            "-ar", str(sample_rate),
            "-ac", str(channels),
            output_path
        ]
        self._run(cmd)

    def convert_to_wav(
        self,
        input_path: str,
        output_path: str,
        sample_rate: int = 48000,
        channels: int = 1
    ) -> None:
        """Convert any audio format to WAV."""
        cmd = [
            self.ffmpeg, "-y",
            "-i", input_path,
            "-acodec", "pcm_s16le",
            "-ar", str(sample_rate),
            "-ac", str(channels),
            output_path
        ]
        self._run(cmd)

    def remux_video(
        self,
        video_path: str,
        audio_path: str,
        output_path: str,
        audio_bitrate: str = "192k"
    ) -> None:
        """Replace video's audio track with new audio."""
        cmd = [
            self.ffmpeg, "-y",
            "-i", video_path,
            "-i", audio_path,
            "-c:v", "copy",  # Don't re-encode video
            "-c:a", "aac",
            "-b:a", audio_bitrate,
            "-map", "0:v:0",  # Video from first input
            "-map", "1:a:0",  # Audio from second input
            "-shortest",
            output_path
        ]
        self._run(cmd)

    def apply_fade(
        self,
        input_path: str,
        output_path: str,
        duration_sec: float,
        fade_ms: int = 5
    ) -> None:
        """Apply fade in/out to prevent clicks."""
        fade_sec = fade_ms / 1000
        start_out = max(0, duration_sec - fade_sec)

        filter_str = f"afade=t=in:d={fade_sec},afade=t=out:st={start_out}:d={fade_sec}"

        cmd = [
            self.ffmpeg, "-y",
            "-i", input_path,
            "-af", filter_str,
            output_path
        ]
        self._run(cmd)
```

---

## 8. Web Application Design

### 8.1 Page Structure

```
app/
├── layout.tsx              # Root layout with providers
├── page.tsx                # Landing → redirect to /upload
├── upload/
│   └── page.tsx            # Screen A: Upload
└── job/
    └── [jobId]/
        ├── describe/
        │   └── page.tsx    # Screen B: Describe
        ├── results/
        │   └── page.tsx    # Screen C: Results
        └── mark/
            └── page.tsx    # Waveform marking
```

### 8.2 Component Architecture

```
components/
├── upload/
│   ├── drop-zone.tsx       # Drag-drop file picker
│   ├── file-info.tsx       # File metadata display
│   └── upload-progress.tsx # Progress bar
├── describe/
│   ├── prompt-input.tsx    # Text input with examples
│   └── erase-button.tsx    # Primary CTA
├── results/
│   ├── audio-player.tsx    # A/B toggle player
│   ├── download-buttons.tsx
│   └── error-display.tsx
├── waveform/
│   └── waveform-editor.tsx # Full waveform component
├── shared/
│   ├── job-status.tsx      # Status badge
│   └── rights-checkbox.tsx # Content rights acknowledgement
└── ui/                     # shadcn/ui components
```

### 8.3 State Management (Zustand)

```typescript
// stores/session.ts

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";

interface SessionStore {
  sessionId: string;
  ensureSession: () => string;
}

export const useSessionStore = create<SessionStore>()(
  persist(
    (set, get) => ({
      sessionId: "",
      ensureSession: () => {
        let { sessionId } = get();
        if (!sessionId) {
          sessionId = nanoid();
          set({ sessionId });
        }
        return sessionId;
      },
    }),
    { name: "hushmark-session" }
  )
);
```

```typescript
// stores/upload.ts

import { create } from "zustand";
import { Id } from "convex/_generated/dataModel";

interface UploadStore {
  file: File | null;
  jobId: Id<"jobs"> | null;
  uploadProgress: number;

  setFile: (file: File | null) => void;
  setJobId: (jobId: Id<"jobs"> | null) => void;
  setUploadProgress: (progress: number) => void;
  reset: () => void;
}

export const useUploadStore = create<UploadStore>((set) => ({
  file: null,
  jobId: null,
  uploadProgress: 0,

  setFile: (file) => set({ file }),
  setJobId: (jobId) => set({ jobId }),
  setUploadProgress: (progress) => set({ uploadProgress: progress }),
  reset: () => set({ file: null, jobId: null, uploadProgress: 0 }),
}));
```

### 8.4 Validation Constants

```typescript
// lib/validators.ts

export const ALLOWED_AUDIO_TYPES = [
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/m4a",
  "audio/mp4",
];

export const ALLOWED_VIDEO_TYPES = [
  "video/mp4",
  "video/quicktime",
];

export const ALLOWED_TYPES = [...ALLOWED_AUDIO_TYPES, ...ALLOWED_VIDEO_TYPES];

export const MAX_FILE_SIZE_MB = 500;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

export const MAX_DURATION_SEC = 600; // 10 minutes

export const ANCHOR_LIMITS = {
  MIN_DURATION: 0.25,  // seconds
  MAX_DURATION: 5.0,   // seconds
  MAX_COUNT: 6,
};

export function validateFile(file: File): { valid: boolean; error?: string } {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return { valid: false, error: `File type ${file.type} not supported` };
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return { valid: false, error: `File too large (max ${MAX_FILE_SIZE_MB}MB)` };
  }

  return { valid: true };
}

export function getInputKind(contentType: string): "audio" | "video" {
  return ALLOWED_VIDEO_TYPES.includes(contentType) ? "video" : "audio";
}
```

---

## 9. Implementation Pseudocode

### 9.1 Upload Flow

```pseudocode
function handleFileSelect(file: File):
  // 1. Validate
  validation = validateFile(file)
  if not validation.valid:
    showError(validation.error)
    return

  // 2. Ensure session
  sessionId = sessionStore.ensureSession()

  // 3. Get presigned URL
  { uploadUrl, objectKey, jobId } = await convex.action(
    storage.getUploadUrl,
    { filename: file.name, contentType: file.type }
  )

  // 4. Create job record
  jobId = await convex.mutation(jobs.create, {
    sessionId,
    inputObjectKey: objectKey,
    inputFilename: file.name,
    inputSizeBytes: file.size,
    inputContentType: file.type,
    inputKind: getInputKind(file.type),
  })

  // 5. Upload to R2
  await uploadFileWithProgress(file, uploadUrl, (progress) => {
    uploadStore.setUploadProgress(progress)
  })

  // 6. Navigate
  router.push(`/job/${jobId}/describe`)
```

### 9.2 Describe & Run Flow

```pseudocode
function handleSubmit(prompt: string, anchors: Anchor[]):
  // 1. Validate prompt
  if prompt.trim().length === 0:
    showError("Please describe the sound to remove")
    return

  // 2. Validate anchors
  for anchor in anchors:
    if anchor.end - anchor.start < 0.25:
      showError("Anchors must be at least 0.25 seconds")
      return
    if anchor.end - anchor.start > 5.0:
      showError("Anchors must be at most 5 seconds")
      return

  // 3. Submit to Convex
  await convex.mutation(jobs.setPromptAndRun, {
    jobId,
    sessionId,
    promptRaw: prompt,
    anchors,
  })

  // 4. Navigate to results (subscription handles updates)
  router.push(`/job/${jobId}/results`)
```

### 9.3 Results Display Flow

```pseudocode
// Results page uses Convex subscription

function ResultsPage({ jobId }):
  sessionId = sessionStore.sessionId
  job = useQuery(jobs.get, { jobId, sessionId })

  // Realtime subscription - auto-updates when job changes
  if job.status === "queued":
    return <QueuedState />

  if job.status === "running":
    return <ProcessingState compute={job.compute} />

  if job.status === "failed":
    return <ErrorState error={job.error} onRetry={handleRetry} />

  if job.status === "succeeded":
    // Get download URLs
    downloads = useAction(storage.getMultipleDownloadUrls, {
      objectKeys: [job.outputCleanKey, job.outputRemovedKey, job.outputVideoKey]
    })

    return <SuccessState job={job} downloads={downloads} />
```

---

## 10. File Organization

```
hushmark/
├── apps/
│   ├── web/                              # Next.js 15 App
│   │   ├── app/
│   │   │   ├── layout.tsx                # ConvexProvider, fonts, metadata
│   │   │   ├── page.tsx                  # Landing/redirect
│   │   │   ├── upload/
│   │   │   │   └── page.tsx
│   │   │   └── job/
│   │   │       └── [jobId]/
│   │   │           ├── describe/
│   │   │           │   └── page.tsx
│   │   │           ├── results/
│   │   │           │   └── page.tsx
│   │   │           └── mark/
│   │   │               └── page.tsx
│   │   ├── components/
│   │   │   ├── upload/
│   │   │   │   ├── drop-zone.tsx
│   │   │   │   ├── file-info.tsx
│   │   │   │   └── upload-progress.tsx
│   │   │   ├── describe/
│   │   │   │   ├── prompt-input.tsx
│   │   │   │   └── erase-button.tsx
│   │   │   ├── results/
│   │   │   │   ├── audio-player.tsx
│   │   │   │   ├── download-buttons.tsx
│   │   │   │   └── error-display.tsx
│   │   │   ├── waveform/
│   │   │   │   └── waveform-editor.tsx
│   │   │   ├── shared/
│   │   │   │   ├── job-status.tsx
│   │   │   │   └── rights-checkbox.tsx
│   │   │   └── ui/                       # shadcn/ui
│   │   │       ├── button.tsx
│   │   │       ├── input.tsx
│   │   │       ├── slider.tsx
│   │   │       └── ...
│   │   ├── lib/
│   │   │   ├── validators.ts
│   │   │   └── utils.ts
│   │   ├── stores/
│   │   │   ├── session.ts
│   │   │   └── upload.ts
│   │   ├── styles/
│   │   │   └── globals.css
│   │   ├── next.config.ts
│   │   ├── tailwind.config.ts
│   │   └── package.json
│   │
│   └── worker/                           # Modal Python Worker
│       ├── modal_app.py                  # Main Modal app
│       ├── media.py                      # FFmpeg wrapper
│       └── requirements.txt
│
├── convex/
│   ├── _generated/                       # Auto-generated
│   ├── schema.ts                         # Database schema
│   ├── jobs.ts                           # Job mutations/queries/actions
│   ├── storage.ts                        # R2 presigned URL actions
│   └── http.ts                           # HTTP endpoints
│
├── packages/
│   └── shared/
│       └── types.ts                      # Shared TypeScript types
│
├── .github/
│   └── workflows/
│       ├── web.yml                       # Web CI/CD
│       └── worker.yml                    # Worker deploy
│
├── package.json                          # Root workspace
├── pnpm-workspace.yaml
├── turbo.json
├── lefthook.yml                          # Git hooks
├── DESIGN.md                             # This file
└── TASK.md                               # Original PRD
```

---

## 11. Data Structures & Schema

### 11.1 Job Type (Full)

```typescript
// packages/shared/types.ts

import { Id } from "convex/_generated/dataModel";

export type AnchorKind = "present" | "absent";

export interface Anchor {
  kind: AnchorKind;
  start: number;  // seconds
  end: number;    // seconds
}

export type JobStatus =
  | "created"   // File uploaded, awaiting prompt
  | "queued"    // Prompt submitted, worker triggered
  | "running"   // Worker acknowledged
  | "succeeded" // Outputs available
  | "failed";   // Error recorded

export interface JobCompute {
  queuedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  gpuSeconds?: number;
  rtf?: number;           // Real-time factor
  durationSec?: number;
}

export interface JobError {
  message: string;
  step?: "download" | "extract" | "infer" | "upload" | "remux" | "unknown";
  detail?: string;
  retryable?: boolean;
}

export interface Job {
  _id: Id<"jobs">;
  _creationTime: number;

  status: JobStatus;
  sessionId: string;
  userId?: string;

  inputKind: "audio" | "video";
  inputObjectKey: string;
  inputFilename: string;
  inputSizeBytes: number;
  inputContentType: string;

  promptRaw?: string;
  promptNormalized?: string;
  anchors: Anchor[];

  outputCleanKey?: string;
  outputRemovedKey?: string;
  outputVideoKey?: string;

  compute?: JobCompute;
  error?: JobError;
  retryCount?: number;

  expiresAt: number;
}
```

### 11.2 API Contracts

```typescript
// Worker request
interface SeparateRequest {
  job_id: string;
  input_kind: "audio" | "video";
  input_url: string;
  prompt: string;
  anchors: Array<{
    kind: "+" | "-";
    start: number;
    end: number;
  }>;
  output_bucket: string;
  output_keys: {
    clean: string;
    removed: string;
    video?: string;
  };
  callback_url: string;
}

// Worker callback (success)
interface CallbackSuccess {
  job_id: string;
  status: "succeeded";
  output_clean_key: string;
  output_removed_key: string;
  output_video_key?: string;
  metrics: {
    gpu_seconds: number;
    rtf: number;
    duration_sec: number;
  };
}

// Worker callback (failure)
interface CallbackFailure {
  job_id: string;
  status: "failed";
  error: {
    message: string;
    step: string;
    detail?: string;
    retryable: boolean;
  };
}
```

---

## 12. Error Handling Strategy

### 12.1 Error Categories

| Category | HTTP | User Message | Action |
|----------|------|--------------|--------|
| **ValidationError** | 400 | Specific field error | Fix input |
| **SessionError** | 403 | "Please refresh page" | Regenerate session |
| **NotFound** | 404 | "Job not found" | Return to upload |
| **WorkerError (retryable)** | - | "Processing failed, retrying..." | Auto-retry (max 2) |
| **WorkerError (fatal)** | - | "Could not process: {reason}" | Show adjust options |
| **InternalError** | 500 | "Something went wrong" | Log + alert |

### 12.2 Error Classification (Worker)

```python
def classify_error_step(error_msg: str) -> str:
    msg = error_msg.lower()

    if any(x in msg for x in ["download", "url", "http", "connection", "timeout"]):
        return "download"
    if any(x in msg for x in ["ffmpeg", "codec", "format", "extract", "unsupported"]):
        return "extract"
    if any(x in msg for x in ["cuda", "model", "inference", "tensor", "sam", "out of memory"]):
        return "infer"
    if any(x in msg for x in ["upload", "s3", "r2", "bucket", "access denied"]):
        return "upload"
    if any(x in msg for x in ["remux", "video"]):
        return "remux"

    return "unknown"

def is_retryable(error_msg: str) -> bool:
    msg = error_msg.lower()

    # NOT retryable
    if any(x in msg for x in [
        "unsupported codec",
        "invalid format",
        "out of memory",
        "access denied",
        "invalid audio",
    ]):
        return False

    # Retryable (network, transient)
    return True
```

### 12.3 Client Error Handling

```typescript
// components/shared/error-boundary.tsx

export function JobErrorDisplay({ error }: { error: JobError }) {
  const getErrorMessage = () => {
    switch (error.step) {
      case "download":
        return "Failed to download your file. Please try uploading again.";
      case "extract":
        return "Unsupported audio format. Try converting to MP3 or WAV.";
      case "infer":
        return "Processing failed. Try a simpler description or shorter file.";
      case "upload":
        return "Failed to save results. Please try again.";
      case "remux":
        return "Failed to create video output. Audio files are still available.";
      default:
        return error.message;
    }
  };

  return (
    <Alert variant="destructive">
      <AlertTitle>Processing Failed</AlertTitle>
      <AlertDescription>
        {getErrorMessage()}
        {error.retryable && (
          <span className="block mt-2 text-sm">
            You can try again with the same settings.
          </span>
        )}
      </AlertDescription>
    </Alert>
  );
}
```

---

## 13. Testing Strategy

### 13.1 Unit Tests (Vitest)

```typescript
// convex/__tests__/promptNormalize.test.ts

import { describe, it, expect } from "vitest";
import { normalizePrompt } from "../jobs";

describe("normalizePrompt", () => {
  it("strips leading action verbs", () => {
    expect(normalizePrompt("remove dog barking")).toBe("dog barking");
    expect(normalizePrompt("erase the coughing")).toBe("coughing");
    expect(normalizePrompt("get rid of keyboard clicks")).toBe("keyboard clicks");
  });

  it("handles edge cases", () => {
    expect(normalizePrompt("  ")).toBe("");
    expect(normalizePrompt("DOG BARKING")).toBe("dog barking");
    expect(normalizePrompt("a dog")).toBe("dog");
  });
});
```

```typescript
// convex/__tests__/anchorValidation.test.ts

import { describe, it, expect } from "vitest";
import { validateAnchors } from "../jobs";

describe("validateAnchors", () => {
  it("accepts valid anchors", () => {
    expect(() => validateAnchors([
      { kind: "present", start: 1, end: 2 },
      { kind: "absent", start: 5, end: 6 },
    ])).not.toThrow();
  });

  it("rejects too short anchors", () => {
    expect(() => validateAnchors([
      { kind: "present", start: 1, end: 1.1 },
    ])).toThrow("too short");
  });

  it("rejects too many anchors", () => {
    const anchors = Array(7).fill({ kind: "present", start: 0, end: 1 });
    expect(() => validateAnchors(anchors)).toThrow("Too many");
  });
});
```

### 13.2 Integration Tests

```typescript
// convex/__tests__/integration/jobFlow.test.ts

import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";

describe("Job flow", () => {
  it("creates job and transitions through states", async () => {
    const t = convexTest(schema);

    // Create job
    const jobId = await t.mutation(api.jobs.create, {
      sessionId: "test-session",
      inputObjectKey: "inputs/test/source.wav",
      inputFilename: "test.wav",
      inputSizeBytes: 1000,
      inputContentType: "audio/wav",
      inputKind: "audio",
    });

    // Verify created state
    let job = await t.query(api.jobs.get, { jobId, sessionId: "test-session" });
    expect(job?.status).toBe("created");

    // Submit prompt
    await t.mutation(api.jobs.setPromptAndRun, {
      jobId,
      sessionId: "test-session",
      promptRaw: "dog barking",
      anchors: [],
    });

    job = await t.query(api.jobs.get, { jobId, sessionId: "test-session" });
    expect(job?.status).toBe("queued");
    expect(job?.promptNormalized).toBe("dog barking");
  });
});
```

### 13.3 E2E Tests (Playwright)

```typescript
// e2e/upload.spec.ts

import { test, expect } from "@playwright/test";

test("upload flow", async ({ page }) => {
  await page.goto("/upload");

  // Upload file
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles("fixtures/test-audio.wav");

  // Wait for upload
  await expect(page.getByText("Upload complete")).toBeVisible();

  // Should navigate to describe
  await expect(page).toHaveURL(/\/job\/.*\/describe/);
});

test("describe and process flow", async ({ page }) => {
  // ... setup job first ...

  await page.goto(`/job/${jobId}/describe`);

  // Enter prompt
  await page.getByPlaceholder("dog barking").fill("keyboard clicks");
  await page.getByRole("button", { name: "Erase" }).click();

  // Should navigate to results
  await expect(page).toHaveURL(/\/results/);

  // Wait for processing (with timeout)
  await expect(page.getByText("Processing complete")).toBeVisible({ timeout: 120000 });
});
```

### 13.4 Golden File QA

Manual test suite with reference files:

| Test Case | Input | Expected |
|-----------|-------|----------|
| Dog + Speech | `dog_speech.wav` | Removed = barking only, Clean = speech preserved |
| Cough + Speech | `cough_speech.wav` | Removed = coughs only, Clean = speech preserved |
| Siren + Music | `siren_music.wav` | Removed = sirens only, Clean = music preserved |
| Keyboard + Voice | `keyboard_voice.wav` | Removed = clicks only, Clean = voice preserved |

---

## 14. Infrastructure & DevOps

### 14.1 Environment Variables

**Web (Vercel)**:
```env
CONVEX_DEPLOYMENT=prod:hushmark
NEXT_PUBLIC_CONVEX_URL=https://hushmark.convex.cloud
```

**Convex**:
```env
CLOUDFLARE_ACCOUNT_ID=<your-account-id>
R2_ACCESS_KEY_ID=<your-access-key>
R2_SECRET_ACCESS_KEY=<your-secret-key>
R2_BUCKET=hushmark
MODAL_WORKER_URL=https://hushmark-worker.modal.run
WORKER_CALLBACK_SECRET=<generate: openssl rand -hex 32>
```

**Modal**:
```env
# Set via modal secret create hushmark-secrets
CLOUDFLARE_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
HF_TOKEN=...  # For gated SAM-Audio model
```

### 14.2 Quality Gates (Lefthook)

```yaml
# lefthook.yml

pre-commit:
  parallel: true
  commands:
    lint:
      glob: "*.{ts,tsx}"
      run: pnpm eslint --fix {staged_files}
      stage_fixed: true
    format:
      glob: "*.{ts,tsx,json,md,css}"
      run: pnpm prettier --write {staged_files}
      stage_fixed: true
    typecheck:
      run: pnpm tsc --noEmit

pre-push:
  commands:
    test:
      run: pnpm test
    convex:
      run: npx convex typecheck
```

### 14.3 CI/CD (GitHub Actions)

```yaml
# .github/workflows/web.yml

name: Web CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: npx convex typecheck
      - run: pnpm test

  deploy:
    needs: quality
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          vercel-args: --prod
```

```yaml
# .github/workflows/worker.yml

name: Worker Deploy

on:
  push:
    branches: [main]
    paths:
      - apps/worker/**

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: pip install modal
      - run: modal deploy apps/worker/modal_app.py
        env:
          MODAL_TOKEN_ID: ${{ secrets.MODAL_TOKEN_ID }}
          MODAL_TOKEN_SECRET: ${{ secrets.MODAL_TOKEN_SECRET }}
```

---

## 15. Security Considerations

### 15.1 Threat Model

| Threat | Mitigation |
|--------|------------|
| **Unauthorized job access** | Session-based ownership check |
| **Worker spoofing** | HMAC-signed callback URLs |
| **Data exposure** | Presigned URLs with 1-hour expiry |
| **Abuse/spam** | Rate limiting (10 jobs/hour/session) |
| **Malicious files** | File type validation, size limits |
| **Secret exposure** | Environment variables, not in code |

### 15.2 Implementation Checklist

- [ ] HTTPS only (Vercel default)
- [ ] Presigned URL expiry: 1 hour
- [ ] HMAC secret: 256-bit random (`openssl rand -hex 32`)
- [ ] R2 bucket: private, no public access
- [ ] No credentials in client code
- [ ] Content-Type validation on upload
- [ ] Session ownership check on all queries/mutations
- [ ] CORS restricted to known origins
- [ ] No PII logged

### 15.3 Callback Signature Verification

```typescript
// HMAC signature for worker callbacks

import crypto from "crypto";

function generateCallbackSignature(jobId: string, secret: string): string {
  const payload = JSON.stringify({ jobId });
  return crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
}

function verifyCallbackSignature(
  jobId: string,
  signature: string,
  secret: string
): boolean {
  const expected = generateCallbackSignature(jobId, secret);
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}
```

---

## 16. Performance Considerations

### 16.1 Targets

| Metric | Target |
|--------|--------|
| **Upload** | < 30s for 100MB file |
| **Time-to-result** | < 90s for 60s audio |
| **Playback latency** | < 500ms first play |
| **Cold start** | < 5s with memory snapshot |

### 16.2 Optimizations

1. **Direct-to-R2 uploads**: Bypass Vercel 4.5MB limit
2. **Modal memory snapshots**: Pre-load model into GPU VRAM
3. **Streaming downloads**: Range requests for audio preview
4. **Convex subscriptions**: Realtime without polling
5. **Warm containers**: `container_idle_timeout=120` keeps 1 warm after use

### 16.3 Scaling

| Component | Strategy |
|-----------|----------|
| **Web** | Vercel auto-scales |
| **Database** | Convex auto-scales |
| **Storage** | R2 auto-scales |
| **GPU** | Modal auto-scales (0 to many) |

---

## 17. Alternatives Considered

### 17.1 Database

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **Convex** | Realtime built-in, TypeScript-first | Newer platform | **Selected** |
| Supabase | SQL, mature | Realtime requires setup | Rejected |
| Neon + Drizzle | Familiar SQL | No built-in realtime | Rejected |
| PlanetScale | MySQL scale | No realtime | Rejected |

### 17.2 GPU Provider

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **Modal** | Serverless, Python-native, snapshots | Newer platform | **Selected** |
| RunPod | Cheap GPUs | Requires container management | Rejected |
| Replicate | Simple API | Less control, higher cost | Rejected |
| AWS Lambda | Familiar | No GPU | Rejected |
| Self-hosted | Full control | DevOps overhead | Rejected |

### 17.3 Audio Separation Model

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **SAM-Audio** | SOTA, span prompting, Meta | Brand new (Dec 2025) | **Selected** |
| AudioSep | Proven, open | Text-only, older | Fallback |
| Demucs | Music separation | Not text-prompted | Rejected |
| Spleeter | Fast | Fixed sources only | Rejected |

---

## Summary

**Stack**: Next.js 15 + Convex + Modal (SAM-Audio) + Cloudflare R2

**Key Design Decisions**:
1. **Convex** for realtime job status without polling
2. **Modal** for serverless GPU with memory snapshots
3. **SAM-Audio** for SOTA text+span prompted separation
4. **Session-based auth** for anonymous usage
5. **HMAC-signed callbacks** for worker security
6. **Presigned URLs** for direct browser ↔ R2 transfers

**Critical Paths**:
1. Upload → R2 (presigned PUT)
2. Prompt → Convex → Modal → SAM-Audio → R2 → Callback → Convex
3. Results → Convex subscription → Presigned GET → Audio player

**Next Step**: Run `/build` to implement this architecture.

---

## References

- [SAM-Audio GitHub](https://github.com/facebookresearch/sam-audio)
- [SAM-Audio HuggingFace](https://huggingface.co/facebook/sam-audio-large)
- [SAM-Audio Blog](https://ai.meta.com/blog/sam-audio/)
- [Modal Documentation](https://modal.com/docs)
- [Convex Documentation](https://docs.convex.dev)
- [Cloudflare R2 Documentation](https://developers.cloudflare.com/r2)
- [WaveSurfer.js v7](https://wavesurfer.xyz)
- [FFmpeg Documentation](https://ffmpeg.org/documentation.html)
- [AudioSep (Alternative)](https://github.com/Audio-AGI/AudioSep)
