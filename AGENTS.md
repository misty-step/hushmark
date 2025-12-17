# Agent Instructions

This project uses **bd (beads)** for ALL issue tracking. See `.beads/BD_GUIDE.md` for complete bd usage instructions.

## Project: Hushmark

Text-prompted audio source separation web app using Meta SAM-Audio.

**Stack**: Next.js 15 + Convex + Modal (GPU) + Cloudflare R2

**Key Files**:
- `DESIGN.md` — Architecture specification
- `TASK.md` — Product requirements

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd create "title" -t feature -p 1 --json  # Create issue
bd update <id> --status in_progress       # Claim work
bd close <id> --reason "Done"             # Complete work
bd sync               # Sync with git
```

## Issue Types & Priorities

**Types**: `bug`, `feature`, `task`, `epic`, `chore`

**Priorities**: `0` Critical → `4` Backlog

## Landing the Plane (Session Completion)

**When ending a work session**, complete ALL steps. Work is NOT complete until `git push` succeeds.

1. **File issues for remaining work** — Create issues for anything needing follow-up
2. **Run quality gates** (if code changed) — Tests, linters, builds
3. **Update issue status** — Close finished work, update in-progress items
4. **PUSH TO REMOTE** — MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Verify** — All changes committed AND pushed
6. **Hand off** — Provide context for next session

**CRITICAL**:
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing
- If push fails, resolve and retry until it succeeds

## Important Rules

- Use bd for ALL task tracking
- Use `--json` flag for programmatic bd commands
- Link discovered work with `discovered-from` dependencies
- Check `bd ready` before asking "what should I work on?"
- Commit `.beads/issues.jsonl` with code changes
- Do NOT create markdown TODO lists
