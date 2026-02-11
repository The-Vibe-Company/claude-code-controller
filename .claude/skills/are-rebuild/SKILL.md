---
name: are-rebuild
description: Reconstruct project from specification documents
---

Reconstruct a project from specification documents using agents-reverse-engineer.

<execution>
Run the rebuild command in the background and monitor progress in real time.

## Steps

1. **Display version**: Read `.claude/ARE-VERSION` and show the user: `agents-reverse-engineer vX.Y.Z`

2. **Run the rebuild command in the background** using `run_in_background: true`:
   ```bash
   npx agents-reverse-engineer@latest rebuild $ARGUMENTS
   ```

3. **Monitor progress by polling** `.agents-reverse-engineer/progress.log`:
   - Wait ~15 seconds (use `sleep 15` in Bash), then use the **Read** tool to read `.agents-reverse-engineer/progress.log` (use the `offset` parameter to read only the last ~20 lines for long files)
   - Show the user a brief progress update (e.g. "4/12 rebuild units completed")
   - Check whether the background task has completed using `TaskOutput` with `block: false`
   - Repeat until the background task finishes
   - **Important**: Keep polling even if progress.log doesn't exist yet (the command takes a few seconds to start writing)

4. **On completion**, read the full background task output and summarize:
   - Number of rebuild units processed
   - Files generated and output directory
   - Any failures or partial completions

This reads spec files from `specs/`, partitions them into ordered rebuild units, and processes each via AI to generate source files.

**Options:**
- `--dry-run`: Show rebuild plan without making AI calls
- `--output <path>`: Output directory (default: rebuild/)
- `--force`: Wipe output directory and start fresh
- `--concurrency N`: Control number of parallel AI calls (default: auto)
- `--fail-fast`: Stop on first failure
- `--debug`: Show AI prompts and backend details
- `--trace`: Enable concurrency tracing to `.agents-reverse-engineer/traces/`

**Exit codes:** 0 (success), 1 (partial failure), 2 (total failure)
</execution>
