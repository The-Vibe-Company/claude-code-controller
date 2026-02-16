# Memory System Quick Start

Get started with Companion's memory system in 5 minutes.

## 1. Setup

```bash
# Ensure Companion is running
companion start

# Configure OpenAI embeddings
export OPENAI_API_KEY=sk-your-api-key-here

# Or set via CLI
companion memory config set --api-key sk-your-api-key-here
```

## 2. Initialize & Index

```bash
# Check status (will auto-initialize memory directory)
companion memory status

# Index existing memory files
companion memory reindex
```

## 3. Add Your First Memory

```bash
# Edit global memory file
nano ~/.companion/memory/MEMORY.md
```

Add some content:

```markdown
# My Companion Memory

## Important Patterns

### Deployment Process
1. Run tests: `bun test`
2. Build: `bun run build`
3. Deploy: `./deploy.sh production`

### Authentication
- Use JWT tokens with 1-hour expiration
- Refresh tokens are valid for 7 days
- Store in httpOnly cookies

## Known Issues

### Database Connection Timeouts
If you see "connection pool exhausted", increase max_connections in postgresql.conf
```

Save and re-index:

```bash
companion memory reindex
```

## 4. Search Your Memory

```bash
# Semantic search
companion memory search "how do I deploy"

# Will find "Deployment Process" even though exact words don't match!

# Try different queries
companion memory search "authentication expires"
companion memory search "database timeout"
```

## 5. Use in Sessions

When working in a Companion session, you can reference memory:

```
User: "How do I deploy to production?"