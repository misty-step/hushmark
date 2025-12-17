# GitHub Copilot Instructions

## Project: Hushmark

Text-prompted audio source separation web app using Meta SAM-Audio.

## Issue Tracking with bd

This project uses **bd (beads)** for issue tracking — a Git-backed tracker for AI coding workflows.

**CRITICAL**: Use bd for ALL task tracking. Do NOT create markdown TODO lists.

### Essential Commands

```bash
# Find work
bd ready --json                    # Unblocked issues
bd stale --days 30 --json          # Forgotten issues

# Create and manage
bd create "Title" -t bug|feature|task -p 0-4 --json
bd create "Subtask" --parent <epic-id> --json
bd update <id> --status in_progress --json
bd close <id> --reason "Done" --json

# Search
bd list --status open --priority 1 --json
bd show <id> --json

# Sync
bd sync  # Force immediate export/commit/push
```

### Workflow

1. **Check ready work**: `bd ready --json`
2. **Claim task**: `bd update <id> --status in_progress`
3. **Work on it**: Implement, test, document
4. **Discover new work?** `bd create "Found bug" -p 1 --deps discovered-from:<parent-id> --json`
5. **Complete**: `bd close <id> --reason "Done" --json`
6. **Sync**: `bd sync`

### Priorities

- `0` Critical (security, data loss)
- `1` High (major features)
- `2` Medium (default)
- `3` Low (polish)
- `4` Backlog

## Tech Stack

- Next.js 15 (App Router), TypeScript, Tailwind, shadcn/ui
- Convex (realtime database)
- Modal (serverless GPU)
- Cloudflare R2 (storage)
- Meta SAM-Audio (ML model)

## Key Files

- `DESIGN.md` — Architecture specification
- `TASK.md` — Product requirements
- `AGENTS.md` — Agent workflow
- `.beads/BD_GUIDE.md` — Beads usage guide

## Important Rules

- Use bd for ALL task tracking
- Use `--json` flag for programmatic commands
- Run `bd sync` at end of sessions
- Commit `.beads/issues.jsonl` with code changes
- Do NOT create markdown TODO lists
