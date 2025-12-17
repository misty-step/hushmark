"""
Hushmark GPU Worker - Modal serverless AudioSep inference
Uses AudioSep for text-prompted audio source separation
"""

import modal
import os
import shutil
import subprocess
import time
import hashlib
import hmac
from typing import Optional
from pydantic import BaseModel

# ============================================================================
# IMAGE DEFINITION
# ============================================================================

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "git", "libsndfile1")
    .pip_install(
        "torch==2.1.0",
        "torchaudio==2.1.0",
        "transformers>=4.36.0",
        "boto3>=1.34.0",
        "httpx>=0.25.0",
        "fastapi>=0.104.0",
        "pydantic>=2.5.0",
        "librosa>=0.10.0",
        "soundfile>=0.12.0",
        "huggingface_hub>=0.19.0",
        "pytorch_lightning",
        "einops",
        "ftfy",
        "braceexpand",
        "webdataset",
        "museval",
    )
    .run_commands(
        "git clone https://github.com/Audio-AGI/AudioSep.git /opt/audiosep",
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
    input_url: str
    prompt: str
    anchors: list[Anchor] = []
    output_bucket: str
    output_keys: OutputKeys
    callback_url: str


class Metrics(BaseModel):
    gpu_seconds: float
    rtf: float  # Real-time factor
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
    scaledown_window=120,  # Keep warm 2 min
    min_containers=0,  # Scale to zero
    secrets=[modal.Secret.from_name("hushmark-r2")],
)
class AudioSeparator:
    """GPU worker for AudioSep inference."""

    @modal.enter()
    def load_model(self):
        """Load model once on container startup."""
        import sys
        sys.path.insert(0, "/opt/audiosep")

        import torch
        from pipeline import build_audiosep
        from huggingface_hub import hf_hub_download

        self.device = torch.device("cuda")

        # Download model checkpoint from HuggingFace
        checkpoint_path = hf_hub_download(
            repo_id="Audio-AGI/AudioSep",
            filename="audiosep_base_4M_steps.ckpt",
            cache_dir="/tmp/hf_cache"
        )
        config_path = "/opt/audiosep/config/audiosep_base.yaml"

        self.model = build_audiosep(
            config_yaml=config_path,
            checkpoint_path=checkpoint_path,
            device=self.device
        )
        print(f"AudioSep model loaded on {self.device}")

    @modal.fastapi_endpoint(method="POST", docs=True)
    async def separate(self, request: SeparateRequest) -> dict:
        """
        Main separation endpoint.
        Downloads input, runs AudioSep, uploads outputs, calls back to Convex.
        """
        import httpx

        start_time = time.time()
        work_dir = f"/tmp/job_{request.job_id}"
        os.makedirs(work_dir, exist_ok=True)

        try:
            # Step 1: Download input file
            input_path = await self._download_input(request.input_url, work_dir)

            # Step 2: Extract audio if video
            audio_path = input_path
            if request.input_kind == "video":
                audio_path = self._extract_audio(input_path, work_dir)

            # Step 3: Run AudioSep separation
            clean_path, removed_path = self._separate(
                audio_path, request.prompt, work_dir
            )

            # Step 4: Normalize loudness
            clean_path = self._normalize(clean_path, work_dir, "clean")
            removed_path = self._normalize(removed_path, work_dir, "removed")

            # Step 5: Remux video if needed
            video_path = None
            if request.input_kind == "video" and request.output_keys.video:
                video_path = self._remux_video(input_path, clean_path, work_dir)

            # Step 6: Upload outputs to R2
            await self._upload_outputs(
                clean_path, removed_path, video_path,
                request.output_bucket, request.output_keys
            )

            # Calculate metrics
            import librosa
            duration = librosa.get_duration(path=audio_path)
            gpu_seconds = time.time() - start_time
            rtf = gpu_seconds / duration if duration > 0 else 0

            # Step 7: Callback success
            await self._callback(request.callback_url, CallbackPayload(
                job_id=request.job_id,
                status="succeeded",
                output_clean_key=request.output_keys.clean,
                output_removed_key=request.output_keys.removed,
                output_video_key=request.output_keys.video,
                metrics=Metrics(
                    gpu_seconds=gpu_seconds,
                    rtf=rtf,
                    duration_sec=duration
                )
            ))

            return {"status": "succeeded", "job_id": request.job_id}

        except Exception as e:
            import traceback
            error_detail = traceback.format_exc()

            # Callback failure
            await self._callback(request.callback_url, CallbackPayload(
                job_id=request.job_id,
                status="failed",
                error=ErrorDetail(
                    message=str(e),
                    step="separation",
                    detail=error_detail[:500],
                    retryable=False
                )
            ))

            return {"status": "failed", "job_id": request.job_id, "error": str(e)}

        finally:
            # Cleanup
            shutil.rmtree(work_dir, ignore_errors=True)

    async def _download_input(self, url: str, work_dir: str) -> str:
        """Download input file from presigned URL."""
        import httpx

        async with httpx.AsyncClient() as client:
            response = await client.get(url, follow_redirects=True)
            response.raise_for_status()

            # Determine extension from content-type
            content_type = response.headers.get("content-type", "")
            ext = ".wav"
            if "video" in content_type or "mp4" in content_type:
                ext = ".mp4"
            elif "audio/mpeg" in content_type:
                ext = ".mp3"

            input_path = os.path.join(work_dir, f"input{ext}")
            with open(input_path, "wb") as f:
                f.write(response.content)

            return input_path

    def _extract_audio(self, video_path: str, work_dir: str) -> str:
        """Extract audio track from video using ffmpeg."""
        audio_path = os.path.join(work_dir, "extracted.wav")
        subprocess.run([
            "ffmpeg", "-i", video_path,
            "-vn", "-acodec", "pcm_s16le",
            "-ar", "32000", "-ac", "2",
            audio_path, "-y"
        ], check=True, capture_output=True)
        return audio_path

    def _separate(self, audio_path: str, prompt: str, work_dir: str) -> tuple[str, str]:
        """Run AudioSep to separate target sound."""
        import sys
        sys.path.insert(0, "/opt/audiosep")
        from pipeline import inference

        # Output path for separated target sound
        target_path = os.path.join(work_dir, "target.wav")

        # Run inference
        inference(
            self.model,
            audio_path,
            prompt,
            target_path,
            self.device,
            use_chunk=True  # Memory efficient for long audio
        )

        # Create residual (original - target = background/clean)
        import librosa
        import soundfile as sf
        import numpy as np

        # Load original and target
        original, sr = librosa.load(audio_path, sr=32000, mono=False)
        target, _ = librosa.load(target_path, sr=32000, mono=False)

        # Handle mono/stereo mismatch
        if original.ndim == 1:
            original = original[np.newaxis, :]
        if target.ndim == 1:
            target = target[np.newaxis, :]

        # Ensure same length
        min_len = min(original.shape[-1], target.shape[-1])
        original = original[..., :min_len]
        target = target[..., :min_len]

        # Residual = original - target (the "clean" version without the sound)
        residual = original - target

        clean_path = os.path.join(work_dir, "clean.wav")
        removed_path = os.path.join(work_dir, "removed.wav")

        sf.write(clean_path, residual.T, sr)
        sf.write(removed_path, target.T, sr)

        return clean_path, removed_path

    def _normalize(self, audio_path: str, work_dir: str, name: str) -> str:
        """Normalize audio to -16 LUFS."""
        output_path = os.path.join(work_dir, f"{name}_normalized.wav")
        subprocess.run([
            "ffmpeg", "-i", audio_path,
            "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
            output_path, "-y"
        ], check=True, capture_output=True)
        return output_path

    def _remux_video(self, video_path: str, audio_path: str, work_dir: str) -> str:
        """Replace video audio track with cleaned audio."""
        output_path = os.path.join(work_dir, "output.mp4")
        subprocess.run([
            "ffmpeg", "-i", video_path, "-i", audio_path,
            "-c:v", "copy", "-map", "0:v:0", "-map", "1:a:0",
            "-shortest", output_path, "-y"
        ], check=True, capture_output=True)
        return output_path

    async def _upload_outputs(
        self,
        clean_path: str,
        removed_path: str,
        video_path: Optional[str],
        bucket: str,
        keys: OutputKeys
    ):
        """Upload output files to R2."""
        import boto3

        s3 = boto3.client(
            "s3",
            endpoint_url=os.environ["R2_ENDPOINT"],
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        )

        # Upload clean audio
        s3.upload_file(clean_path, bucket, keys.clean)

        # Upload removed audio
        s3.upload_file(removed_path, bucket, keys.removed)

        # Upload video if applicable
        if video_path and keys.video:
            s3.upload_file(video_path, bucket, keys.video)

    async def _callback(self, url: str, payload: CallbackPayload):
        """Send callback to Convex."""
        import httpx

        async with httpx.AsyncClient() as client:
            await client.post(
                url,
                json=payload.model_dump(),
                timeout=30
            )

    @modal.fastapi_endpoint(method="GET")
    async def health(self) -> dict:
        """Health check endpoint."""
        return {"status": "ok", "model": "audiosep"}
