---
name: are-update
description: Incrementally update documentation for changed files
---

Update documentation for files that changed since last run.

<execution>
Run the update command in the background and monitor progress in real time.

## Steps

1. **Display version**: Read `.claude/ARE-VERSION` and show the user: `agents-reverse-engineer vX.Y.Z`

2. **Run the update command in the background** using `run_in_background: true`:
   ```bash
   npx agents-reverse-engineer@latest update $ARGUMENTS
   ```

3. **Monitor progress by polling** `.agents-reverse-engineer/progress.log`:
   - Wait ~15 seconds (use `sleep 15` in Bash), then use the **Read** tool to read `.agents-reverse-engineer/progress.log` (use the `offset` parameter to read only the last ~20 lines for long files)
   - Show the user a brief progress update (e.g. "12/30 files updated, ~5m remaining")
   - Check whether the background task has completed using `TaskOutput` with `block: false`
   - Repeat until the background task finishes
   - **Important**: Keep polling even if progress.log doesn't exist yet (the command takes a few seconds to start writing)

4. **On completion**, read the full background task output and summarize:
   - Files updated
   - Files unchanged
   - Any orphaned docs cleaned up

**Options:**
- `--uncommitted`: Include staged but uncommitted changes
- `--dry-run`: Show what would be updated without writing
- `--concurrency N`: Control number of parallel AI calls (default: auto)
- `--fail-fast`: Stop on first file analysis failure
- `--debug`: Show AI prompts and backend details
- `--trace`: Enable concurrency tracing to `.agents-reverse-engineer/traces/`
</execution>
