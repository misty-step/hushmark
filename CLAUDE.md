# CLAUDE.md — Hushmark

## Project Overview

**Hushmark** is a text-prompted audio source separation web app. Users upload audio/video, describe an unwanted sound, and receive cleaned output.

## Issue Tracking

This project uses **bd (beads)** for ALL issue tracking. Use `bd` commands instead of markdown TODOs.

```bash
bd ready              # Find available work
bd create "title" -t feature -p 1 --json
bd update <id> --status in_progress
bd close <id> --reason "Done"
bd sync               # Sync with git
```

See `AGENTS.md` and `.beads/BD_GUIDE.md` for workflow details.

## Tech Stack

- **Frontend**: Next.js 15 (App Router), TypeScript, Tailwind, shadcn/ui
- **Backend**: Convex (realtime database + actions)
- **GPU Worker**: Modal (serverless GPU), Meta SAM-Audio
- **Storage**: Cloudflare R2 (S3-compatible)

## Key Files

| File | Purpose |
|------|---------|
| `DESIGN.md` | Architecture specification (comprehensive) |
| `TASK.md` | Product requirements / PRD |
| `AGENTS.md` | Agent workflow instructions |
| `.beads/BD_GUIDE.md` | Beads usage guide (auto-generated) |

## Development Commands

```bash
# Web app
pnpm dev              # Start Next.js dev server
pnpm build            # Production build
pnpm test             # Run tests

# Convex
npx convex dev        # Start Convex dev
npx convex deploy     # Deploy to production

# Modal worker
modal serve apps/worker/modal_app.py   # Dev mode
modal deploy apps/worker/modal_app.py  # Production
```

## Code Style

- TypeScript strict mode
- Prefer Convex patterns (mutations, queries, actions)
- Use shadcn/ui components
- Follow existing file organization in `DESIGN.md`

## Session Workflow

1. Check `bd ready` for available work
2. Claim with `bd update <id> --status in_progress`
3. Implement, test, document
4. Close with `bd close <id> --reason "Done"`
5. End session: `git pull --rebase && bd sync && git push`
