---
name: are-specify
description: Generate project specification from AGENTS.md docs
---

Generate a project specification from existing AGENTS.md documentation.

<execution>
Run the specify command in the background and monitor progress in real time.

## Steps

1. **Display version**: Read `.claude/ARE-VERSION` and show the user: `agents-reverse-engineer vX.Y.Z`

2. **Run the specify command in the background** using `run_in_background: true`:
   ```bash
   npx agents-reverse-engineer@latest specify $ARGUMENTS
   ```

3. **Monitor progress by polling** `.agents-reverse-engineer/progress.log`:
   - Wait ~15 seconds (use `sleep 15` in Bash), then use the **Read** tool to read `.agents-reverse-engineer/progress.log` (use the `offset` parameter to read only the last ~20 lines for long files)
   - Show the user a brief progress update
   - Check whether the background task has completed using `TaskOutput` with `block: false`
   - Repeat until the background task finishes
   - **Important**: Keep polling even if progress.log doesn't exist yet (the command takes a few seconds to start writing)

4. **On completion**, read the full background task output and summarize:
   - Number of AGENTS.md files collected
   - Output file(s) written

This collects all AGENTS.md files, synthesizes them via AI, and writes a comprehensive project specification.

If no AGENTS.md files exist, it will auto-run `generate` first.

**Options:**
- `--dry-run`: Show input statistics without making AI calls
- `--output <path>`: Custom output path (default: specs/SPEC.md)
- `--multi-file`: Split specification into multiple files
- `--force`: Overwrite existing specification
- `--debug`: Show AI prompts and backend details
- `--trace`: Enable concurrency tracing to `.agents-reverse-engineer/traces/`
</execution>
