"""
Hushmark GPU Worker - Modal serverless SAM-Audio inference
"""

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
        "sam-audio",  # Meta SAM-Audio package
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
    input_url: str  # Presigned download URL
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
        self.model = (
            SAMAudio.from_pretrained("facebook/sam-audio-large")
            .to(self.device)
            .eval()
        )
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
                cmd = [
                    "ffmpeg",
                    "-y",
                    "-i",
                    input_path,
                    "-vn",
                    "-acodec",
                    "pcm_s16le",
                    "-ar",
                    "48000",
                    "-ac",
                    "1",
                    audio_path,
                ]
            else:
                cmd = [
                    "ffmpeg",
                    "-y",
                    "-i",
                    input_path,
                    "-acodec",
                    "pcm_s16le",
                    "-ar",
                    "48000",
                    "-ac",
                    "1",
                    audio_path,
                ]

            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode != 0:
                raise RuntimeError(f"ffmpeg failed: {result.stderr}")

            # Get duration
            probe_cmd = [
                "ffprobe",
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                audio_path,
            ]
            probe_result = subprocess.run(probe_cmd, capture_output=True, text=True)
            probe_data = json.loads(probe_result.stdout)
            duration_sec = float(probe_data["format"]["duration"])

            # ------------------------------------------------------------------
            # 3. RUN SAM-AUDIO INFERENCE
            # ------------------------------------------------------------------
            # Format anchors: [[kind, start, end], ...]
            anchors_formatted = (
                [[a.kind, a.start, a.end] for a in request.anchors]
                if request.anchors
                else None
            )

            # Prepare inputs
            inputs = self.processor(
                audios=[audio_path],
                descriptions=[request.prompt],
                anchors=[anchors_formatted] if anchors_formatted else None,
            ).to(self.device)

            # Run inference
            with torch.inference_mode():
                result = self.model.separate(inputs)

            target = result.target[0]  # What we're removing
            residual = result.residual[0]  # The "clean" output

            # ------------------------------------------------------------------
            # 4. POST-PROCESS OUTPUTS
            # ------------------------------------------------------------------

            def normalize_audio(
                audio: torch.Tensor, peak_db: float = -1.0
            ) -> torch.Tensor:
                peak = audio.abs().max()
                if peak > 0:
                    target_peak = 10 ** (peak_db / 20)
                    audio = audio * (target_peak / peak)
                return audio.clamp(-1.0, 1.0)

            def apply_fade(
                audio: torch.Tensor, sample_rate: int, fade_ms: int = 5
            ) -> torch.Tensor:
                fade_samples = int(sample_rate * fade_ms / 1000)
                if fade_samples > 0 and audio.shape[-1] > fade_samples * 2:
                    fade_in = torch.linspace(
                        0, 1, fade_samples, device=audio.device
                    )
                    audio[..., :fade_samples] *= fade_in
                    fade_out = torch.linspace(
                        1, 0, fade_samples, device=audio.device
                    )
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
                    "ffmpeg",
                    "-y",
                    "-i",
                    input_path,
                    "-i",
                    clean_path,
                    "-c:v",
                    "copy",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "192k",
                    "-map",
                    "0:v:0",
                    "-map",
                    "1:a:0",
                    "-shortest",
                    video_path,
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

            s3.upload_file(clean_path, bucket, request.output_keys.clean)
            s3.upload_file(removed_path, bucket, request.output_keys.removed)

            if video_path and request.output_keys.video:
                s3.upload_file(video_path, bucket, request.output_keys.video)

            # ------------------------------------------------------------------
            # 7. CALCULATE METRICS
            # ------------------------------------------------------------------
            gpu_seconds = time.time() - start_time
            rtf = gpu_seconds / duration_sec

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
        if any(
            x in msg
            for x in ["unsupported", "codec", "invalid format", "out of memory"]
        ):
            return False
        return True


# ============================================================================
# HEALTH CHECK
# ============================================================================


@app.function()
@modal.web_endpoint(method="GET")
def health():
    return {"status": "healthy", "service": "hushmark-worker"}
