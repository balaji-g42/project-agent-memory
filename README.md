# Project Agent Memory

A TypeScript MCP (Model Context Protocol) server that gives a coding agent persistent project memory - context, decisions, progress and patterns - backed by Qdrant or PostgreSQL/pgvector (via pREST), selected with one environment variable.

## Features

- **7 MCP tools**: `memory_create`, `memory_read`, `memory_update`, `memory_delete`, `memory_context`, `memory_graph`, `memory_admin`
- **Dual storage backend**: `MEMORY_BACKEND=qdrant` (default) or `MEMORY_BACKEND=postgres`, same tool surface either way - no code change to switch, and Qdrant deployments need no env changes to keep working. The `postgres` backend talks to Postgres/pgvector through a [pREST](https://prest.dev) instance, not a direct DB connection - vectors travel over an `X-Vector` header (registered pREST queries can't carry them as URL params without hitting HTTP 414)
- **Local embeddings by default**: ONNX CPU inference in-process via `@huggingface/transformers`; no embedding service, no API key, nothing leaves the machine except the backend writes
- **Configurable vector dimension**: `VECTOR_DIM` (default 768), Matryoshka-truncated and re-normalized
- **Pluggable providers**: `onnx`, `openai` (any OpenAI-compatible endpoint - Ollama, LM Studio, vLLM, LiteLLM, OpenAI itself), `gemini`, `openrouter`
- **No silent fallbacks**: a failing provider fails the call rather than returning degraded vectors
- **Runs via `npx`**: no global install, no long-running service
- **Performance**: connection pooling (`POOL_SIZE`, shared across backends), LRU caches for embeddings and queries, cache invalidation on write

## Requirements

- Node.js 18+
- A reachable Qdrant instance, **or** a PostgreSQL instance with the `vector` (pgvector) extension **and** a [pREST](https://prest.dev) instance in front of it
- No API key with the default `onnx` provider

## Install

Three ways in, most to least automated. All of them still need a reachable Qdrant or Postgres - see [Setup](#setup) below.

### 1. Claude Code plugin (recommended)

Bundles the MCP server, the agent skill, and memory-first session hooks (detects `git commit`, nudges the agent to log it, hard-blocks `Stop` until it does) in one install.

```bash
git clone https://github.com/balaji-g42/project-agent-memory
claude --plugin-dir ./project-agent-memory
```

On first enable, Claude Code prompts for `memory_backend` (`qdrant` or `postgres`) and the matching URL/key via the plugin's `userConfig` - nothing is hardcoded to Qdrant. Validate the manifest any time with `claude plugin validate .`.

Includes: `.mcp.json` (server registration), `skill/` (agent skill), `hooks/` (`SessionStart` / `PostToolUse` / `Stop`), `commands/memory-sync.md` (`/memory-sync`).

### 2. Agent Skill only

Just the "when and how to use these tools" instructions - no hooks, no bundled server registration. Pair it with a manual MCP config (option 3).

- **Claude Code**: copy `skill/*` into `.claude/skills/project-agent-memory/` (project) or `~/.claude/skills/project-agent-memory/` (global)
- **Claude.ai**: zip `skill/` and upload via Settings → Features → Skills

See [`skill/README.md`](skill/README.md).

### 3. MCP server only (manual)

Register the server yourself - no skill, no hooks.

```bash
npx -y project-agent-memory
```

Or from source:

```bash
git clone https://github.com/balaji-g42/project-agent-memory
cd project-agent-memory
npm install
npm run build
node dist/index.js
```

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "project-agent-memory"],
      "env": {
        "QDRANT_URL": "http://localhost:6333"
      }
    }
  }
}
```

Client-specific templates are in [`skill/`](skill/): `claude-config.example.json`, `vscode-mcp-config.example.json`, `cursor-config.example.json`.

## Setup

### 1. Storage backend

Pick one. `MEMORY_BACKEND` defaults to `qdrant`, so existing deployments need no changes.

#### Qdrant (default)

```bash
docker run -p 6333:6333 -v ./qdrant_storage:/qdrant/storage qdrant/qdrant
```

```env
MEMORY_BACKEND=qdrant
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=
```

#### PostgreSQL / pgvector (via pREST)

`MEMORY_BACKEND=postgres` doesn't connect to Postgres directly - it goes through [pREST](https://prest.dev), which exposes registered SQL queries over HTTP. You need both Postgres (with `vector`) and pREST reachable:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: memory
    volumes:
      - ./pg_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  prest:
    image: prest/prest
    environment:
      PREST_PG_HOST: postgres
      PREST_PG_USER: postgres
      PREST_PG_PASS: postgres
      PREST_PG_DATABASE: memory
      PREST_JWT_KEY: change-me
    ports:
      - "3000:3000"
    depends_on:
      - postgres
```

```env
MEMORY_BACKEND=postgres
PREST_URL=http://localhost:3000
PREST_JWT_KEY=change-me
PREST_REGISTER_ADMIN=admin
PREST_DATABASE=memory
```

The `vector` extension, both tables (`memory_collections`, `memory_points`) and the registered pREST queries the server calls are created automatically on first connect - no manual migration step. `PREST_JWT_KEY` must match the key pREST's own config was started with (used to sign the admin bearer token for registered-query calls). See [`instructions/migration_plan.md/plan.md`](instructions/migration_plan.md/plan.md) §4 for the schema and design notes. If you have existing data in Qdrant and want to move it into Postgres, see [Migrating Qdrant data into Postgres](#migrating-qdrant-data-into-postgres) below.

### 2. Configuration

Minimum - everything else has a working default:

```env
QDRANT_URL=http://localhost:6333
```

Common settings:

```env
MEMORY_BACKEND=qdrant
POOL_SIZE=10

QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=

# postgres backend only
PREST_URL=http://localhost:3000
PREST_JWT_KEY=
PREST_REGISTER_ADMIN=admin
PREST_DATABASE=memory

VECTOR_DIM=768
DISTANCE_METRIC=Cosine

EMBEDDING_PROVIDER=onnx
EMBEDDING_MODEL=nomic-ai/nomic-embed-text-v1.5
ONNX_DTYPE=q8

SUMMARIZER_PROVIDER=openrouter
SUMMARIZER_MODEL=openai/gpt-oss-20b:free
OPENROUTER_API_KEY=
```

The full environment-variable reference, including the Postgres table, is in [`skill/MCP-CONFIG.md`](skill/MCP-CONFIG.md).

**Changing `VECTOR_DIM` destroys data on Qdrant.** On the next call the server sees the size mismatch against the stored collection, warns on stderr, deletes that collection and recreates it empty. On Postgres the vector column width is fixed at schema-creation time; a mismatch instead throws a descriptive error and changes nothing.

### Embedding providers

| Provider | Notes |
|----------|-------|
| `onnx` (default) | In-process CPU inference. `nomic-ai/nomic-embed-text-v1.5`, 768 dims, ~140MB at `q8`, downloaded once into `~/mcp/project-agent-memory/models` so `npx` runs reuse it |
| `openai` | Any endpoint speaking `/v1/embeddings`. Set `OPENAI_BASE_URL`; for Ollama use `http://localhost:11434/v1` |
| `gemini` | Requires `GEMINI_API_KEY` |
| `openrouter` | Requires `OPENROUTER_API_KEY` |

An unrecognized `EMBEDDING_PROVIDER` is a startup error.

## Tools

All seven take `project_name` (case-sensitive; it selects the `memory_bank_<project_name>` collection).

`memory_type` is one of: `productContext`, `activeContext`, `systemPatterns`, `decisionLog`, `progress`, `contextHistory`, `customData`, `knowledgeLink`.

The four CRUD tools take arrays, so a single write and a batch write use the same call shape - send one element or many.

### memory_create
Store entries. `project_name`, `items[]` of `{ memory_type, content, id?, metadata? }` (min 1). `metadata` holds filterable fields such as `status`, `priority` or `dataType`. Returns `[{ id, type }]`.

### memory_read
Retrieve entries. `project_name`, `queries[]` of `{ query_text?, memory_type?, metadata_filter?, limit? }` (min 1, `limit` default 5).
With `query_text` a query is a semantic search; without it, a recency-ordered listing that embeds nothing. `metadata_filter` matches on the fields stored by `memory_create`; an array value matches any of its elements. A single query returns `[{ id, score, content, type, timestamp, metadata }]`; several return one such array per query.

### memory_update
Update entries by id. `project_name`, `items[]` of `{ id, content?, metadata? }` (min 1). Content is re-embedded when supplied; omitting it keeps the stored vector. `metadata` is shallow-merged. Returns `[{ id, updated }]`.

### memory_delete
Permanently delete entries. `project_name`, `ids` (array, min 1). Returns `{ deleted }`.

### memory_context
Read, and optionally patch, the project's working state. `project_name`, optional `product_context`, optional `active_context`, `pattern_limit` (default 20). Patches are shallow-merged and the previous version is written to `contextHistory`; reads happen after writes. Initializes the workspace when product context is empty.

### memory_graph
Knowledge graph over the entries. `project_name`, `op`:
- `link` - `edges[]` of `{ from_id, to_id, relation, description? }`. Returns the created edges.
- `neighbors` - `id`, optional `relation`, `depth` (default 1), `direction` (`outgoing` / `incoming` / `both`, default `both`). Walks the graph outwards and returns `{ neighbors: [{ id, depth, via, content, type }], edges }`.
- `unlink` - `link_ids` (the edges' own ids). Returns `{ deleted }`.

Edges are stored in the same collection as ordinary points of type `knowledgeLink`; no second collection and no extra service.

### memory_admin
`project_name`, `op`:
- `export` - optional `memory_types`. Returns the memory bank as markdown.
- `import` - `markdown` in this server's own export format. Returns `{ imported, errors, timestamp }`.
- `summarize` - `content`. Returns a condensed version, for shrinking a long text before storing it.
- `delete_collection` - permanently deletes the entire memory bank (collection and all its points) for `project_name`. No confirmation step - irreversible.

Full parameter tables and return shapes: [`skill/API-REFERENCE.md`](skill/API-REFERENCE.md).

### Migrating from memory-qdrant-mcp v2.x

The package was renamed `memory-qdrant-mcp` → `project-agent-memory` at v3.0. Same server, same Qdrant collections (`memory_bank_<project>` in both versions), so **your existing data carries over untouched** - only the package name, the tool surface and some config keys change.

**1. Tools: 35 → 7.** Every v2 tool name is gone. The per-tool mapping is in [`skill/SKILL.md`](skill/SKILL.md).

**2. Config keys.** Everything not listed here is unchanged.

| v2.x | v3.0 | Notes |
|------|------|-------|
| `QDRANT_POOL_SIZE` | `POOL_SIZE` | Old name still read as a fallback; applies to whichever backend `MEMORY_BACKEND` selects |
| `DEFAULT_TOP_K_MEMORY_QUERY` | *(removed)* | No longer read. Pass `limit` per query in `memory_read` instead |
| `EMBEDDING_PROVIDER=fastembed` | `EMBEDDING_PROVIDER=onnx` | `onnx` is the new default and runs in-process on CPU |
| `EMBEDDING_PROVIDER=ollama` | `EMBEDDING_PROVIDER=openai` + `OPENAI_BASE_URL=http://localhost:11434/v1` | Ollama is now reached through the OpenAI-compatible provider. `OLLAMA_API_URL` still exists but only drives the **summarizer** |
| `EMBEDDING_MODEL=qwen/qwen3-embedding-8b` | `EMBEDDING_MODEL=nomic-ai/nomic-embed-text-v1.5` | New default, 768 dims |
| `VECTOR_DIM` default `3072` | default `768` | **Read the warning below before you start the v3 server** |
| *(none)* | `MEMORY_BACKEND` | Defaults to `qdrant`, so a v2 deployment needs no change |

**`VECTOR_DIM` is the one that will bite you.** If your v2 collections were built at 3072 and you start v3 without setting `VECTOR_DIM`, the server sees 768 against a 3072 collection, warns on stderr, then **deletes and recreates that collection empty**. Either pin `VECTOR_DIM` (and `EMBEDDING_PROVIDER`/`EMBEDDING_MODEL`) to what v2 used, or accept the wipe and re-ingest. There is no in-place re-embedding path.

**3. Update the MCP registration.** The command changes in both deployment shapes.

Local (embeddings computed on this machine, Qdrant on localhost):

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "project-agent-memory"],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "VECTOR_DIM": "768",
        "EMBEDDING_PROVIDER": "onnx",
        "EMBEDDING_MODEL": "nomic-ai/nomic-embed-text-v1.5"
      }
    }
  }
}
```

Self-hosted / cloud Qdrant (remote instance, API key, embeddings still local):

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "project-agent-memory"],
      "env": {
        "MEMORY_BACKEND": "qdrant",
        "QDRANT_URL": "https://qdrant.example.com",
        "QDRANT_API_KEY": "...",
        "POOL_SIZE": "10",
        "VECTOR_DIM": "768",
        "DISTANCE_METRIC": "Cosine",
        "EMBEDDING_PROVIDER": "onnx",
        "EMBEDDING_MODEL": "nomic-ai/nomic-embed-text-v1.5",
        "ONNX_DTYPE": "q8",
        "SUMMARIZER_PROVIDER": "openrouter",
        "SUMMARIZER_MODEL": "openai/gpt-oss-20b:free",
        "OPENROUTER_API_KEY": "..."
      }
    }
  }
}
```

On Windows, `"command": "npx"` may need to be `"command": "cmd", "args": ["/c", "npx", "-y", "project-agent-memory"]`.

**4. If you want to land on the Postgres backend instead.** v2 had no Postgres backend - it was Qdrant-only - so this is an upgrade *and* a backend switch, and the data has to be copied across. Do it in this order:

*a. Decide the embedding model first.* This is the whole difficulty. The migration script copies vectors verbatim; it does not re-embed. v2's default was `qwen/qwen3-embedding-8b` at 3072 dims, v3's is `nomic-ai/nomic-embed-text-v1.5` at 768. Vectors from two different models are not comparable, so if you migrate 3072-dim v2 points into a 768-dim collection and then let v3 write new memories with `onnx`, every similarity score between the old and new rows is meaningless - searches will look like they work and quietly rank wrong. Pick one:

| | Do this | Cost |
|---|---|---|
| **Keep v2's embeddings** | Set `VECTOR_DIM=3072` and the same `EMBEDDING_PROVIDER`/`EMBEDDING_MODEL` v2 used, then migrate | v2's `fastembed` and `ollama` embedding providers don't exist in v3, so this only works if v2 used `openrouter` or `gemini` |
| **Re-embed on v3 (recommended)** | Start clean on `onnx`/768 and re-ingest the content you care about | You lose v2 history you don't re-enter |

Migrating anyway and re-embedding later is possible - `memory_update` re-embeds the row it touches - but there is no bulk re-embed command.

*b. Stand up Postgres + pgvector + pREST* as in [PostgreSQL / pgvector (via pREST)](#postgresql--pgvector-via-prest) above. No manual DDL: the migration script creates the `vector` extension, `memory_collections`, `memory_points`, the indexes and the registered pREST queries itself, and is idempotent.

*c. Copy the data.* Point ids and payloads are preserved 1:1; re-running is an upsert, so a failed run is safe to repeat.

```bash
node skill/migrate-qdrant-to-pgvector.mjs --project <your-project> \
  --qdrant-url https://qdrant.example.com --qdrant-api-key ... \
  --prest-url http://localhost:3000 --prest-jwt-key change-me \
  --vector-dim 3072 \
  --dry-run
```

Drop `--dry-run` once the reported counts look right. Use `--all` instead of `--project` to move every collection on the Qdrant server in one pass. Full flag list via `--help`.

*d. Switch the MCP registration* to the Postgres backend. Local:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "project-agent-memory"],
      "env": {
        "MEMORY_BACKEND": "postgres",
        "PREST_URL": "http://localhost:3000",
        "PREST_JWT_KEY": "change-me",
        "PREST_REGISTER_ADMIN": "admin",
        "PREST_DATABASE": "memory",
        "VECTOR_DIM": "768",
        "EMBEDDING_PROVIDER": "onnx",
        "EMBEDDING_MODEL": "nomic-ai/nomic-embed-text-v1.5"
      }
    }
  }
}
```

Self-hosted / cloud Postgres (pREST sits in front of it; the server never opens a Postgres TCP connection of its own):

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "project-agent-memory"],
      "env": {
        "MEMORY_BACKEND": "postgres",
        "PREST_URL": "https://prest.example.com",
        "PREST_JWT_KEY": "...",
        "PREST_REGISTER_ADMIN": "admin",
        "PREST_DATABASE": "memory",
        "POOL_SIZE": "10",
        "VECTOR_DIM": "768",
        "DISTANCE_METRIC": "Cosine",
        "EMBEDDING_PROVIDER": "onnx",
        "EMBEDDING_MODEL": "nomic-ai/nomic-embed-text-v1.5",
        "ONNX_DTYPE": "q8",
        "SUMMARIZER_PROVIDER": "openrouter",
        "SUMMARIZER_MODEL": "openai/gpt-oss-20b:free",
        "OPENROUTER_API_KEY": "..."
      }
    }
  }
}
```

`PREST_JWT_KEY` must be the same key pREST itself was started with. `QDRANT_URL`/`QDRANT_API_KEY` are ignored once `MEMORY_BACKEND=postgres`, so you can leave them in place during the cutover and remove them after.

*e. Note the different failure mode.* On Qdrant a `VECTOR_DIM` mismatch silently wipes and recreates the collection. On Postgres the `vector(n)` column width is fixed at schema-creation time, so a mismatch throws a descriptive error and changes nothing - safer, but it means the `VECTOR_DIM` you migrate at is permanent for that database short of recreating the table.

See [Migrating Qdrant data into Postgres](#migrating-qdrant-data-into-postgres) below for the script's dimension-handling details.

### Migrating Qdrant data into Postgres

`skill/migrate-qdrant-to-pgvector.mjs` is a one-time, one-way copy of every point in a Qdrant collection into the Postgres backend's schema, through the same pREST endpoint the server itself uses. It's only needed if you have existing Qdrant data and want to start using `MEMORY_BACKEND=postgres` with it - the two backends are otherwise independent and nothing else moves data between them.

```bash
node skill/migrate-qdrant-to-pgvector.mjs --project project-agent-memory \
  --qdrant-url http://localhost:6333 \
  --prest-url http://localhost:3000 \
  --prest-jwt-key change-me
```

Source vectors of any dimension are supported: if the Qdrant collection's vector size differs from the target `VECTOR_DIM`, the script truncates and re-normalizes (Matryoshka-style, same as the embedding layer) when the source is larger, and refuses with a clear error rather than padding when the source is smaller. Run with `--help` for the full flag list, including `--dry-run`.

## Testing

Interactive:

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

Opens http://localhost:6274.

Smoke test over stdio:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node dist/index.js
```

## Development

### Project structure

```
project-agent-memory/
├── src/
│   ├── index.ts              # MCP server entry point, 7 tool registrations
│   ├── config.ts             # Environment configuration and VECTOR_DIM validation
│   ├── init.ts               # Collection creation and dimension guard
│   ├── cache.ts              # LRU caches and invalidation
│   ├── constants.ts
│   ├── types.ts
│   ├── utils.ts
│   ├── embeddings.ts         # Provider factory
│   ├── embeddings/
│   │   ├── providerBase.ts   # Abstract base class
│   │   ├── onnx.ts           # In-process ONNX inference
│   │   ├── openaiCompatible.ts
│   │   ├── geminiVertex.ts
│   │   └── openrouter.ts
│   ├── backends/
│   │   └── postgres.ts       # Qdrant-API-shaped shim over pg + pgvector
│   └── mcp_tools/
│       ├── memoryBankTools.ts
│       └── summarizer.ts
├── dist/                     # Compiled output (generated)
├── tests/
├── skill/                    # Claude Agent Skill, incl. the Qdrant->Postgres migration script
├── .claude-plugin/
│   └── plugin.json           # Plugin manifest (name, userConfig, skill path)
├── hooks/
│   ├── hooks.json             # SessionStart / PostToolUse / Stop wiring
│   └── inject.js              # Memory-first rules + commit auto-logging + Stop hard-block
├── commands/
│   └── memory-sync.md         # /memory-sync
├── .mcp.json                  # Plugin's bundled MCP server registration
├── package.json
└── tsconfig.json
```

### Build

```bash
npm run build   # compile to dist/
npm run dev     # watch mode
```

## License

MIT

## Resources

- [Model Context Protocol](https://modelcontextprotocol.io)
- [Qdrant](https://qdrant.tech)
- [pgvector](https://github.com/pgvector/pgvector)
- [Transformers.js](https://huggingface.co/docs/transformers.js)
- [OpenRouter](https://openrouter.ai)
