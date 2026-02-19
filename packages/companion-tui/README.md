# companion-tui

Terminal UI client for The Companion server.

## Run

From repo root:

```bash
cd packages/companion-tui
bun install
bun run tui
```

Or with host override:

```bash
cd packages/companion-tui
bun run tui -- --host localhost:3456
```

## Usage

```bash
companion-tui                # create new session
companion-tui -c             # continue most recent session in cwd
companion-tui -r             # pick session to resume
companion-tui -r <id>        # resume specific session
companion-tui -m <model>     # start with model
companion-tui --host <host>  # companion host (default: localhost:3456)
```
