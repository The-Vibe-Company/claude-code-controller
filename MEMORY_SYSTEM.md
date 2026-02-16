# Companion Memory System

A comprehensive, OpenClaw-inspired memory system for Companion that enables semantic search, persistent learning, and cross-session knowledge sharing.

## Overview

The memory system provides:

- **Semantic Search**: Hybrid BM25 + vector search for finding relevant memories
- **Persistent Storage**: Markdown files as source of truth, SQLite for indexing
- **Cross-Session Learning**: Share knowledge between sessions automatically
- **OpenAI Embeddings**: State-of-the-art semantic understanding (local embeddings coming soon)
- **CLI Management**: Full command-line control via `companion memory`

## Architecture

### Components

```
~/.companion/memory/
├── MEMORY.md                 # Global long-term memory
├── config.json               # Memory system configuration
├── .memorydb                 # SQLite database (chunks, embeddings, FTS5)
├── sessions/
│   └── YYYY-MM-DD.md        # Daily session logs
├── projects/
│   └── <slug>/              # Per-project memories
│       ├── MEMORY.md
│       ├── architecture.md
│       └── gotchas.md
└── skills/
    └── <slug>.md            # Skill-specific learnings
```

### Data Flow

1. **Indexing**: Markdown files → Chunks (400 tokens) → Embeddings → SQLite
2. **Search**: Query → Vector search + BM25 search → Hybrid scoring → Results
3. **Caching**: Content hash → Embedding cache → Avoid recomputation

## Installation & Setup

### Initialize Memory System

```bash
# Start Companion server
companion start

# Check memory status
companion memory status

# Configure OpenAI embeddings (required for semantic search)
companion memory config set --provider openai --api-key sk-...

# Or use environment variable
export OPENAI_API_KEY=sk-...
```

### Initial Indexing

```bash
# Index all memory files
companion memory reindex

# Check status again to see indexed chunks
companion memory status
```

## Usage

### CLI Commands

#### Status

```bash
# Show memory statistics
companion memory status

# Example output:
# {
#   "enabled": true,
#   "stats": {
#     "totalFiles": 12,
#     "totalChunks": 156,
#     "totalEmbeddings": 156,
#     "cacheEntries": 89,
#     "storageSize": 245760,
#     "sources": {
#       "global": 15,
#       "session": 98,
#       "project": 32,
#       "skill": 11
#     }
#   }
# }
```

#### Search

```bash
# Basic search
companion memory search "how to deploy the app"

# Limit results
companion memory search "authentication" --limit 5

# Set minimum score threshold
companion memory search "debugging tips" --min-score 0.7
```

#### Configuration

```bash
# View current config
companion memory config

# Set embedding provider
companion memory config set --provider openai --model text-embedding-3-small

# Disable embeddings (BM25 only)
companion memory config set --provider disabled

# Enable/disable memory system
companion memory config set --enabled true
```

#### Export / Import

```bash
# Export all memory to JSON
companion memory export --output ~/backup/memory-2026-02-15.json

# Import from backup
companion memory import --input ~/backup/memory-2026-02-15.json
```

#### Reindex

```bash
# Re-index all memory files (use after adding/editing markdown files)
companion memory reindex
```

### REST API

#### GET /api/memory/status

Get memory system status and statistics.

```bash
curl http://localhost:3456/api/memory/status
```

#### GET /api/memory/search?q=<query>

Search memory with optional parameters.

```bash
curl "http://localhost:3456/api/memory/search?q=deployment&limit=5&minScore=0.6"
```

Response:
```json
{
  "query": "deployment",
  "results": [
    {
      "chunk": {
        "id": "abc123",
        "path": "sessions/2026-02-10.md",
        "source": "session",
        "startLine": 45,
        "endLine": 60,
        "text": "Deployment process:\n1. Run tests\n2. Build production bundle\n3. Deploy to server"
      },
      "score": 0.89,
      "vectorScore": 0.92,
      "bm25Score": 0.83,
      "citation": "sessions/2026-02-10.md:45-60"
    }
  ]
}
```

#### POST /api/memory/reindex

Trigger re-indexing of all memory files.

```bash
curl -X POST http://localhost:3456/api/memory/reindex
```

#### GET /api/memory/config

Get memory configuration.

```bash
curl http://localhost:3456/api/memory/config
```

#### PUT /api/memory/config

Update memory configuration.

```bash
curl -X PUT http://localhost:3456/api/memory/config \
  -H "Content-Type: application/json" \
  -d '{"enabled": true, "provider": "openai"}'
```

## Writing to Memory

### Programmatic API

```typescript
import { getMemoryManager } from "./server/memory-manager.js";

const manager = getMemoryManager();

// Append to today's session log
manager.appendToSessionLog(`
## Learned Pattern

When deploying, always run tests first to catch regressions.
`);

// Write to global memory
manager.appendToGlobalMemory(`
## Important: Database Backups

Run daily backups at 3am via cron job.
`);

// Write skill-specific memory
manager.writeSkillMemory("deployment", `
# Deployment Skill

## Usage History
- 2026-02-15: Successfully deployed to production
- Always check environment variables first

## Common Issues
- Missing API keys → Check .env file
- Port conflicts → Use different port
`);

// Write project-specific memory
manager.writeProjectMemory("my-app", "MEMORY.md", `
# My App Memory

## Architecture
- Frontend: React + Vite
- Backend: Hono + Bun
- Database: PostgreSQL

## Known Issues
- Auth tokens expire after 1 hour
- Must run migrations before deployment
`);
```

## Configuration

### Memory Config File

`~/.companion/memory/config.json`:

```json
{
  "enabled": true,
  "storePath": "~/.companion/memory",
  "search": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "hybrid": {
      "enabled": true,
      "vectorWeight": 0.7,
      "bm25Weight": 0.3
    },
    "cache": {
      "enabled": true,
      "maxEntries": 50000
    }
  },
  "chunking": {
    "maxTokens": 400,
    "overlapTokens": 80
  },
  "autoFlush": {
    "enabled": false,
    "thresholdTokens": 40000
  },
  "sessionInjection": {
    "enabled": false,
    "maxSnippets": 5,
    "minScore": 0.6
  }
}
```

### Configuration Options

#### Embedding Providers

- `openai`: OpenAI embeddings API (requires API key)
- `disabled`: No embeddings, BM25-only search
- `local`: Local embeddings (coming soon)

#### Hybrid Search Weights

Default: 70% vector, 30% BM25. Adjust based on your use case:

- **Semantic-heavy** (0.9 vector, 0.1 BM25): Best for finding conceptually similar content
- **Keyword-heavy** (0.3 vector, 0.7 BM25): Best for finding exact terms, IDs, error codes
- **Balanced** (0.7 vector, 0.3 BM25): Good general-purpose default

#### Chunking Settings

- `maxTokens`: Target chunk size (~400 tokens = ~1600 characters)
- `overlapTokens`: Overlap between chunks to preserve context (~80 tokens)

## Search Quality Tips

### 1. Use Descriptive Queries

❌ Bad: `"error"`
✅ Good: `"authentication error when logging in with OAuth"`

### 2. Leverage Hybrid Search

The system combines:
- **Vector search**: Understands semantics ("deploy" matches "deployment", "shipping", "release")
- **BM25 search**: Finds exact keywords (good for IDs, file names, error codes)

### 3. Adjust Score Thresholds

- **0.5-0.6**: Broad search, may include tangentially related results
- **0.7-0.8**: Balanced, good default
- **0.9+**: Very strict, only highly relevant matches

### 4. Write Clear Memory Entries

Structure your memory markdown files for better search:

```markdown
# Clear Topic Headers

## Use descriptive headers
Not: "Issue"
Better: "OAuth Token Expiration Issue"

## Include keywords
When writing about deployment, mention: deploy, deployment, shipping, production, release

## Add context
Not: "Fixed the bug"
Better: "Fixed authentication bug where JWT tokens weren't being refreshed properly"
```

## Performance

### Indexing Speed

- ~1000 chunks/second with embeddings enabled (OpenAI API)
- ~10,000 chunks/second with embeddings disabled (BM25 only)

### Search Speed

- Vector search: ~50ms for 1000 chunks
- BM25 search: ~10ms for 1000 chunks
- Hybrid search: ~60ms for 1000 chunks

### Embedding Cache

The system caches embeddings by content hash:
- **Cache hit**: ~0ms (instant retrieval)
- **Cache miss**: ~100ms (OpenAI API call)
- Default cache size: 50,000 entries
- Storage: ~120MB for 50k cached embeddings (1536 dimensions)

## Troubleshooting

### No search results

1. Check if memory is enabled: `companion memory status`
2. Ensure files are indexed: `companion memory reindex`
3. Lower score threshold: `--min-score 0.5`
4. Check OpenAI API key: `echo $OPENAI_API_KEY`

### Slow search

1. Reduce database size: Delete old session logs
2. Disable vector search: `companion memory config set --provider disabled`
3. Check cache hit rate in status output

### Embeddings API errors

1. Verify API key: `companion memory config`
2. Check OpenAI quota/billing
3. Fallback to BM25: `companion memory config set --provider disabled`

### Memory files not found

1. Check directory exists: `ls ~/.companion/memory/`
2. Initialize if needed: Memory system auto-initializes on first use
3. Verify file permissions

## Roadmap

### Phase 1: Foundation ✅
- [x] Directory structure
- [x] CLI commands
- [x] REST API endpoints
- [x] SQLite database with FTS5
- [x] OpenAI embeddings
- [x] Hybrid search

### Phase 2: Intelligence (In Progress)
- [ ] Auto memory flush before context compaction
- [ ] Cross-session memory injection
- [ ] Project memory auto-population
- [ ] Skill memory integration

### Phase 3: Optimization
- [ ] Local embeddings (GGUF models)
- [ ] Memory compaction
- [ ] Advanced observability
- [ ] Search result ranking improvements

### Phase 4: Integration
- [ ] Session transcript indexing (opt-in)
- [ ] GitHub integration (index PR comments, issues)
- [ ] Slack integration (index conversations)
- [ ] Browser extension (index web research)

## Implementation Details

### File Structure

```
web/server/
├── memory-types.ts          # TypeScript types and interfaces
├── memory-store.ts          # Directory management, file discovery
├── memory-db.ts             # SQLite database layer
├── memory-embeddings.ts     # Embedding generation and caching
├── memory-chunker.ts        # Markdown chunking logic
├── memory-search.ts         # Hybrid search engine
├── memory-manager.ts        # High-level API
├── memory-chunker.test.ts   # Chunking tests
├── memory-db.test.ts        # Database tests
└── memory-embeddings.test.ts # Embedding tests
```

### Testing

```bash
# Run all memory tests
cd web && bun test memory

# Run specific test file
bun test server/memory-chunker.test.ts

# Watch mode
bun test --watch memory
```

### Database Schema

```sql
-- Chunks table
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  source TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  hash TEXT NOT NULL,
  text TEXT NOT NULL,
  updated_at INTEGER
);

-- Embeddings table
CREATE TABLE embeddings (
  chunk_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  embedding TEXT NOT NULL,
  updated_at INTEGER,
  FOREIGN KEY (chunk_id) REFERENCES chunks(id)
);

-- Embedding cache
CREATE TABLE embedding_cache (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  hash TEXT NOT NULL,
  embedding TEXT NOT NULL,
  updated_at INTEGER,
  PRIMARY KEY (provider, model, hash)
);

-- FTS5 virtual table
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  chunk_id UNINDEXED
);
```

## Credits

This memory system is inspired by [OpenClaw's memory architecture](https://docs.openclaw.ai/concepts/memory), adapting their design principles for Companion:

- Markdown as source of truth
- Hybrid BM25 + vector search
- Embedding caching
- Tool-based access patterns
- Citation support

## License

MIT
