# HUSHMARK

## (SAM-Audio) — Prototype PRD + System Design + Architecture Spec (Engineer-Ready)

**Goal:** ship a single-purpose web app that removes *one described sound* from an uploaded audio/video file using **text + optional temporal span examples**, returning:

* **Clean output** = “everything else” (residual)
* **Removed output** = “what got erased” (target, for trust/debug)

**Core promise (MVP):**
Upload → describe sound (“dog barking”) → (optional) mark 1–3 short examples → process → preview A/B → download.

---

## 1) Product requirements

### 1.1 MVP scope (must ship)

**Inputs**

* Audio: `.wav .mp3 .m4a`
* Video: `.mp4 .mov` (audio extracted, cleaned, remuxed)

**Prompting**

* Required: **text description**
* Optional: **temporal spans** as positive (“sound present”) and negative (“sound NOT present”) anchors

**Outputs**

* `clean.wav` (or `clean.m4a`) — residual
* `removed.wav` — target
* If input was video: `clean.mp4` — original video stream + cleaned audio stream

**Playback / UX**

* Before/after toggle (A/B)
* “Hear what was removed” toggle (plays removed)
* Download buttons

**Job orchestration**

* async job processing with status updates
* re-run same file with revised prompt/spans

**Storage & cleanup**

* inputs/outputs stored in object storage (R2/S3)
* auto-delete after configurable TTL (default 7 days)

### 1.2 Explicit non-goals (MVP excludes)

* multitrack timeline editing
* batch processing
* transcripts / editing docs
* DAW effects (EQ, compression, etc.)
* voice isolation / “remove a person” marketing
* visual prompting (masking objects in video)

### 1.3 Success criteria (MVP)

* For a 60s clip: “time-to-first-result” is consistently < ~90s on a decent GPU (measure and tune)
* Removed track is recognizable (“yes that’s the bark/cough”)
* Clean track preserves speech intelligibility
* 90%+ of jobs succeed for files under limits

---

## 2) User experience specification

### 2.1 Primary flow (3 screens)

#### Screen A — Upload

**UI**

* Drag-and-drop + file picker
* Shows: filename, detected type (audio/video), duration, size
* “Continue” button enabled when file validated

**Validation**

* File type allowed
* File size <= `MAX_UPLOAD_MB` (config)
* Duration <= `MAX_DURATION_SEC` (default 600s)

**Implementation note**

* Upload direct-to-object-storage via presigned URL (avoid Vercel limits)

---

#### Screen B — Describe

**UI**

* Single input: “What sound should I erase?”

  * Placeholder examples: “dog barking”, “coughing”, “keyboard clicks”, “sirens”
* Primary button: **Erase**
* Subtle link: **Not perfect? Mark examples**

**Prompt normalization (lightweight)**

* Store both:

  * `promptRaw` = exact user input
  * `promptNormalized` = cleaned noun phrase-ish
* Normalization rules:

  * Trim whitespace, lower-case for internal usage (keep original casing for UI)
  * Strip leading verbs/phrases: `remove|erase|delete|get rid of|filter out|take out`
  * Remove leading “the” / “a” if it helps
  * Don’t over-correct: keep user words if unsure

---

#### Screen C — Results

**UI**

* Player with toggles:

  1. **Before / After**
  2. **Hear removed**
* Download buttons:

  * Audio input → “Download Clean Audio”, “Download Removed (WAV)”
  * Video input → “Download Clean Video”, “Download Removed (WAV)”
* CTA: “Not perfect? Mark examples” → opens span marking with existing prompt

**Error handling**

* If failed: show error summary + “Try again” + “Adjust description” + “Mark examples”

---

### 2.2 Advanced control (only one): Mark examples

This is the “high quality without knobs” lever.

**UI**

* Waveform timeline + playhead + zoom controls
* Playback controls (space to play/pause, scrubbing)
* Two actions:

  * “Mark sound present” → creates span `{kind:"present", start, end}`
  * “Mark sound NOT present” → creates span `{kind:"absent", start, end}`
* Tip: “Mark 1–3 short regions (0.5–2.0s) for best results.”

**Constraints**

* Enforce span duration: min 0.25s, max 5.0s (configurable)
* Cap spans: max 6 total (recommend 3 present + 3 absent)
* Prevent overlaps of same kind; allow overlap across kinds only if user insists (prefer to block for simplicity)

**Implementation**

* Use WaveSurfer (or similar) to create regions
* Persist anchors to job (or to a “draft job config” for re-runs)

---

## 3) Technical architecture (TS-first, Python isolated)

### 3.1 Stack (recommended)

**Web app**

* Next.js (App Router), TypeScript
* Deployment: Vercel
* Auth: Clerk (optional for MVP; anonymous sessions allowed)

**Data**

* Convex (recommended for fastest iteration + realtime job updates)

  * Alternative: Neon Postgres + Drizzle (if you prefer SQL ops early)

**Storage**

* Cloudflare R2 (S3-compatible) or AWS S3
* Presigned uploads + presigned downloads

**Queue / job triggering**

* If Convex: scheduled functions/actions + HTTP call to worker
* Alternative: Upstash QStash to trigger worker callbacks

**GPU worker**

* Minimal Python service (Docker), single endpoint
* Runs SAM-Audio inference with PyTorch
* Hosted on RunPod / Modal / GPU VM

**Media tooling**

* ffmpeg inside worker container

### 3.2 High-level design goals

* Keep Vercel web tier **stateless**
* Keep worker **idempotent** (safe to retry)
* Keep storage **object-key based** with TTL cleanup
* Maintain **clear contracts** between web/orchestrator and worker

---

## 4) System components

### 4.1 Web app (Next.js)

Responsibilities:

* UI flows and client playback
* Create and manage jobs
* Generate presigned upload URLs
* Provide signed download URLs
* Trigger worker job execution
* Display realtime/polling status

### 4.2 Database (Convex or Neon)

Responsibilities:

* job state machine + metadata
* user mapping (if authenticated)
* audit + metrics (compute time, failure rate)

### 4.3 Object storage (R2/S3)

Buckets/prefixes:

* `inputs/{jobId}/original`
* `derived/{jobId}/extracted.wav` (optional; can be temp only)
* `outputs/{jobId}/clean.wav`
* `outputs/{jobId}/removed.wav`
* `outputs/{jobId}/clean.mp4` (optional)

Lifecycle policy:

* auto-expire everything under `inputs/` and `outputs/` after TTL days
* optionally keep `removed.wav` shorter TTL (privacy)

### 4.4 GPU Worker (Python)

Responsibilities:

* Download input via signed URL
* Extract audio (if video)
* Standardize audio format
* Run SAM-Audio:

  * Inputs: audio path, description, anchors (+/-)
  * Outputs: target + residual tensors
* Save output audio files
* Remux video if needed
* Upload outputs to storage
* Report completion back to web tier

---

## 5) Job state machine

States:

* `created` (job row exists, file uploaded)
* `queued` (worker trigger scheduled)
* `running` (worker started)
* `succeeded` (outputs uploaded)
* `failed` (error recorded)

Transitions:

* created → queued (immediately after job creation)
* queued → running (worker acknowledges)
* running → succeeded/failed

Retry policy:

* Automatic retry up to N times for transient errors (network, storage)
* No retry for deterministic errors (unsupported codec, exceeding limits)

Idempotency:

* Worker should upload outputs with deterministic keys based on `{jobId}`.
* If keys already exist, worker can:

  * overwrite (safe) OR
  * short-circuit and mark success (preferred if outputs validated)

---

## 6) Data model

### 6.1 Canonical Job schema

```ts
type Anchor = { kind: "present" | "absent"; start: number; end: number };

type Job = {
  id: string;               // uuid
  createdAt: number;        // ms
  updatedAt: number;        // ms

  status: "created" | "queued" | "running" | "succeeded" | "failed";

  userId?: string;          // Clerk user id (optional)
  sessionId?: string;       // anonymous session token (optional)

  inputKind: "audio" | "video";
  inputObjectKey: string;
  inputFilename: string;
  inputSizeBytes: number;
  durationSec: number;

  promptRaw: string;
  promptNormalized: string;
  anchors: Anchor[];

  // Output keys
  outputCleanKey?: string;
  outputRemovedKey?: string;
  outputVideoKey?: string;

  // Observability
  compute?: {
    queuedAt?: number;
    startedAt?: number;
    finishedAt?: number;
    gpuSeconds?: number;
    rtf?: number;            // real-time factor
  };

  error?: {
    message: string;
    step?: string;           // "download" | "ffmpeg_extract" | "infer" | "upload" | "remux"
    detail?: string;
  };

  expiresAt: number;         // ms (TTL cleanup reference)
};
```

### 6.2 Storage keys

Deterministic key pattern:

* `inputs/{jobId}/source{ext}`
* `outputs/{jobId}/clean.wav`
* `outputs/{jobId}/removed.wav`
* `outputs/{jobId}/clean.mp4`

---

## 7) API design (Next.js route handlers)

### 7.1 Upload init (presigned)

`POST /api/uploads/init`
Request:

```json
{ "filename": "myfile.mp4", "contentType": "video/mp4", "sizeBytes": 12345 }
```

Response:

```json
{
  "objectKey": "inputs/{jobId}/source.mp4",
  "uploadUrl": "https://...",
  "headers": { "Content-Type": "video/mp4" },
  "jobId": "uuid",
  "maxSizeBytes": 524288000,
  "expiresAt": 1234567890
}
```

Notes:

* You can create the job row here in `created` state, or create a “pending upload” record and finalize later.
* Prefer creating the job here so `jobId` is stable for object key.

---

### 7.2 Finalize upload metadata

`POST /api/uploads/complete`
Request:

```json
{ "jobId": "uuid", "durationSec": 93.2, "inputKind": "video" }
```

Response:

```json
{ "ok": true }
```

Notes:

* Duration detection can be client-side (ffprobe in-browser is hard) or server-side. Easiest: have worker compute duration during processing and update job; UI can show “~” until known.

---

### 7.3 Create processing run / update job config

`POST /api/jobs/{jobId}/run`
Request:

```json
{
  "prompt": "remove dog barking",
  "anchors": [
    { "kind": "present", "start": 6.3, "end": 7.0 },
    { "kind": "absent", "start": 0.0, "end": 1.0 }
  ]
}
```

Response:

```json
{ "jobId": "uuid", "status": "queued" }
```

Behavior:

* Normalize prompt
* Save prompt + anchors
* Set status `queued`
* Trigger worker execution (Convex action / QStash)

---

### 7.4 Get job status

`GET /api/jobs/{jobId}`
Response (example):

```json
{
  "job": {
    "id": "uuid",
    "status": "succeeded",
    "inputKind": "video",
    "durationSec": 93.2,
    "promptRaw": "remove dog barking",
    "promptNormalized": "dog barking",
    "anchors": []
  },
  "downloads": {
    "cleanAudioUrl": "https://signed...",
    "removedAudioUrl": "https://signed...",
    "cleanVideoUrl": "https://signed..."
  }
}
```

---

### 7.5 Worker callback (signed)

`POST /api/jobs/{jobId}/callback?sig=...`
Request:

```json
{
  "status": "succeeded",
  "outputCleanKey": "outputs/{jobId}/clean.wav",
  "outputRemovedKey": "outputs/{jobId}/removed.wav",
  "outputVideoKey": "outputs/{jobId}/clean.mp4",
  "metrics": { "gpuSeconds": 12.3, "rtf": 0.8 }
}
```

Or failure:

```json
{
  "status": "failed",
  "error": { "message": "ffmpeg failed", "step": "remux", "detail": "..." }
}
```

Security:

* HMAC signature with shared secret (`WORKER_CALLBACK_SECRET`)
* Reject if missing/invalid

---

## 8) Worker contract + implementation spec

### 8.1 Worker endpoint

`POST /separate`

Payload:

```json
{
  "jobId": "uuid",
  "inputKind": "audio|video",
  "inputUrl": "https://signed-download...",
  "prompt": "dog barking",
  "anchors": [["+", 6.3, 7.0], ["-", 0.0, 1.0]],
  "output": {
    "bucket": "your-bucket",
    "cleanKey": "outputs/{jobId}/clean.wav",
    "removedKey": "outputs/{jobId}/removed.wav",
    "videoKey": "outputs/{jobId}/clean.mp4"
  },
  "callbackUrl": "https://your-app.com/api/jobs/{jobId}/callback?sig=..."
}
```

### 8.2 Audio preprocessing

If inputKind = `video`:

1. download video to `/tmp/source.mp4`
2. extract audio:

   * `ffmpeg -i source.mp4 -vn -ac 1 -ar 48000 extracted.wav`

If inputKind = `audio`:

* download to `/tmp/source`
* convert to standard WAV (avoid codec surprises):

  * `ffmpeg -i source -ac 1 -ar 48000 extracted.wav`

### 8.3 Anchor mapping

From web:

* `present` → `"+"`
* `absent` → `"-"`

Validate anchors:

* within `[0, duration]`
* start < end
* clamp to file bounds

### 8.4 Inference (single pass; no chunking in v1)

* Load model once at process start (warm):

  * `SAMAudio.from_pretrained("facebook/sam-audio-base")` (configurable)
* For each job:

  * run separation
  * capture `target` + `residual`

### 8.5 Postprocessing

* Prevent clipping:

  * peak normalize to -1 dBFS or clamp + normalize
* Optional micro-fade:

  * 5–10ms fade in/out to avoid clicks
* Save:

  * `clean.wav` from residual
  * `removed.wav` from target

### 8.6 Remux video (if input was video)

* `ffmpeg -i source.mp4 -i clean.wav -c:v copy -map 0:v:0 -map 1:a:0 -shortest out.mp4`

### 8.7 Upload outputs

* Upload to storage keys provided (S3 SDK)
* Then callback web app

### 8.8 Failure modes + classification

* download error → retryable
* ffmpeg decode/unsupported codec → non-retryable
* OOM/inference failure → retryable once, then fail
* upload error → retryable

---

## 9) Long audio strategy (v1.5)

**v1:** hard limit duration (10 minutes)

**v1.5:** chunking + overlap + crossfade

* `chunkSec = 30`
* `overlapSec = 3`
* step = 27s

Algorithm:

1. Iterate start times: 0, 27, 54…
2. For each chunk:

   * `ffmpeg -ss start -t chunkSec extracted.wav → chunk.wav`
   * Map global anchors into local chunk space if overlapping
3. Run inference per chunk
4. Stitch residual outputs with linear crossfade over overlap

Acceptance criteria:

* no obvious seams in residual for typical content
* stable memory usage for long files

---

## 10) Security, privacy, and abuse controls

### 10.1 Content rights acknowledgement (low friction)

* Checkbox: “I own or have rights to edit this content.”

### 10.2 Data retention

* Default TTL 7 days (config)
* Option for user to “Delete now” (post-MVP)

### 10.3 Auth

MVP options:

* Anonymous session token stored in cookie; restrict job access to same session
* Later: Clerk user accounts; link jobs to `userId`

### 10.4 Rate limiting

* Per IP/session: max jobs per hour
* Per user (if logged in): separate quota

### 10.5 Signed URLs

* Presigned uploads (short expiry)
* Presigned downloads (short expiry)
* Never expose raw bucket access

---

## 11) Observability + metrics

Log fields (web + worker):

* jobId, status transitions, error step
* durations:

  * time queued → running
  * running → finished
* worker metrics:

  * GPU seconds
  * RTF (gpu_sec / audio_sec)
  * peak amplitude pre/post normalize
* storage size in/out

Dashboards:

* success rate
* p50/p95 time-to-result
* top failure reasons
* cost estimate per minute

---

## 12) Cost model (instrumentation-first)

Compute cost is dominated by GPU time.
Store:

* `gpuSeconds` and `durationSec`
  Compute:
* `rtf = gpuSeconds / durationSec`
  This enables per-minute pricing later.

---

## 13) Deployment + CI/CD

### 13.1 Environments

* `dev` (local)
* `staging` (preview deployments)
* `prod`

### 13.2 Web (Vercel)

* Next.js app
* Env vars for storage, Convex/Neon, worker URL, secrets

### 13.3 Worker (GPU)

* Docker image built via GitHub Actions
* Deployed to GPU provider with:

  * `MODEL_ID`
  * HF auth token (if required)
  * S3 credentials
  * callback secret

### 13.4 GitHub Actions (outline)

* On push to main:

  * lint/typecheck
  * deploy web (Vercel)
  * build/push worker image
  * trigger worker redeploy (provider-specific)

---

## 14) Repo structure (recommended)

```
/apps/web
  /app
  /components
  /lib (storage, auth, db)
  /api (route handlers)
  /styles

/apps/worker
  Dockerfile
  main.py (FastAPI or minimal HTTP)
  sam_audio_runner.py
  ffmpeg_utils.py
  storage_client.py

/packages/shared
  types.ts (Job, Anchor, API payloads)
  promptNormalize.ts

/.github/workflows
  web.yml
  worker.yml
```

---

## 15) Local development plan

### Web

* `pnpm dev`
* Uses dev bucket/prefix, or MinIO if you want local S3 emulation

### Worker

* Run locally without GPU for wiring:

  * accept request, stub outputs, upload dummy files
* GPU dev:

  * run on a single GPU node; point web staging to it

---

## 16) Testing strategy

### Unit tests

* prompt normalization
* anchor validation + clamping
* signing/HMAC verification

### Integration tests

* upload → create job → worker callback → download URLs
* retry behavior for transient failures

### Golden-file QA (manual but repeatable)

Prepare a small suite:

* barking + speech
* coughs + speech
* sirens + music
* keyboard clicks + voice

Acceptance:

* removed track contains the described events
* residual doesn’t “pump” or mangle speech excessively

---

## 17) Definition of done (prototype)

**Functional**

* Upload mp3/mp4
* Enter prompt and run
* Get clean + removed outputs
* Mark spans and rerun
* Video remux works

**Reliability**

* Job status always resolves to succeeded/failed
* Errors are readable and actionable
* Outputs are downloadable via signed URLs

**Ops**

* TTL cleanup in place
* Basic metrics + logs exist
* Worker can be restarted without breaking system

---

## 18) Implementation milestones (fast path)

1. **Skeleton**

* Presigned upload, job record, status UI

2. **Worker v1**

* Audio-only inference, outputs uploaded, callback update

3. **Video support**

* ffmpeg extract + remux

4. **Span marking UI**

* waveform regions + anchors payload

5. **Polish**

* A/B playback, removed toggle, improved errors, basic metrics

---

If you tell me **Convex vs Neon** (or “both”), and **R2 vs S3**, I can also generate a **literal task-by-task engineering plan** (tickets with acceptance criteria) and a **reference implementation skeleton** (routes, types, worker handler, signatures, env vars) you can paste into a repo.

