---
name: are-discover
description: Discover files in codebase
---

List files that would be analyzed for documentation.

<execution>
## STRICT RULES - VIOLATION IS FORBIDDEN

1. Run ONLY this exact command: `npx agents-reverse-engineer@latest discover $ARGUMENTS`
2. DO NOT add ANY flags the user did not explicitly type
3. If user typed nothing after `/are-discover`, run with ZERO flags

## Steps

1. **Display version**: Read `.claude/ARE-VERSION` and show the user: `agents-reverse-engineer vX.Y.Z`

2. **Run the discover command in the background** using `run_in_background: true`:
   ```bash
   npx agents-reverse-engineer@latest discover $ARGUMENTS
   ```

3. **Monitor progress by polling** `.agents-reverse-engineer/progress.log`:
   - Wait ~10 seconds (use `sleep 10` in Bash), then use the **Read** tool to read `.agents-reverse-engineer/progress.log` (use the `offset` parameter to read only the last ~20 lines for long files)
   - Show the user a brief progress update
   - Check whether the background task has completed using `TaskOutput` with `block: false`
   - Repeat until the background task finishes
   - **Important**: Keep polling even if progress.log doesn't exist yet (the command takes a few seconds to start writing)

4. **On completion**, read the full background task output and report number of files found.
</execution>
