# Hushmark

**Describe a sound. We'll erase it.**

Text-prompted audio source separation that removes *exactly* what you describe—barking dogs, coughs, sirens, keyboard clicks—from your audio and video files.

## How It Works

1. **Upload** your audio (WAV, MP3, M4A) or video (MP4, MOV)
2. **Describe** the unwanted sound: *"dog barking"*, *"keyboard clicks"*, *"sirens"*
3. **Download** your cleaned file + the isolated removed sound

Optional: Mark 1-3 example regions in the waveform for surgical precision.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 15, TypeScript, Tailwind, shadcn/ui |
| Backend | Convex (realtime database + actions) |
| GPU Inference | Modal (serverless), AudioSep model |
| Storage | Cloudflare R2 |
| Deployment | Vercel |

## Development

```bash
# Install dependencies
pnpm install

# Start Convex dev server (terminal 1)
pnpm convex:dev

# Start Next.js dev server (terminal 2)
pnpm dev

# Deploy Modal worker
pnpm worker:deploy
```

## Project Structure

```
apps/
  web/           # Next.js frontend + Convex backend
  worker/        # Modal GPU worker (Python)
packages/
  config/        # Shared TypeScript/ESLint configs
```

## Environment Variables

### Convex Dashboard
```
CLOUDFLARE_ACCOUNT_ID=xxx
R2_ACCESS_KEY_ID=xxx
R2_SECRET_ACCESS_KEY=xxx
R2_BUCKET=hushmark
MODAL_WORKER_URL=https://your-modal-endpoint
WORKER_CALLBACK_SECRET=random-secret
```

### Modal Secret (hushmark-r2)
```
R2_ENDPOINT=https://xxx.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=xxx
R2_SECRET_ACCESS_KEY=xxx
```

## Architecture

```
Browser → Presigned PUT → R2 (input)
       ↓
    Convex (job created)
       ↓
    Modal Worker (GPU inference)
       ↓
    R2 (outputs) → Presigned GET → Browser
       ↓
    Convex callback (job complete)
```

See [DESIGN.md](./DESIGN.md) for comprehensive architecture documentation.

## License

Private - All rights reserved.
