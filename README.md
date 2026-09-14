# Project Agent Memory

A TypeScript MCP (Model Context Protocol) server that gives a coding agent persistent project memory - context, decisions, progress and patterns - backed by Qdrant or PostgreSQL/pgvector, selected with one environment variable.

## Features

- **7 MCP tools**: `memory_create`, `memory_read`, `memory_update`, `memory_delete`, `memory_context`, `memory_graph`, `memory_admin`
- **Dual storage backend**: `MEMORY_BACKEND=qdrant` (default) or `MEMORY_BACKEND=postgres`, same tool surface either way - no code change to switch, and Qdrant deployments need no env changes to keep working
- **Local embeddings by default**: ONNX CPU inference in-process via `@huggingface/transformers`; no embedding service, no API key, nothing leaves the machine except the backend writes
- **Configurable vector dimension**: `VECTOR_DIM` (default 768), Matryoshka-truncated and re-normalized
- **Pluggable providers**: `onnx`, `openai` (any OpenAI-compatible endpoint - Ollama, LM Studio, vLLM, LiteLLM, OpenAI itself), `gemini`, `openrouter`
- **No silent fallbacks**: a failing provider fails the call rather than returning degraded vectors
- **Runs via `npx`**: no global install, no long-running service
- **Performance**: connection pooling (`POOL_SIZE`, shared across backends), LRU caches for embeddings and queries, cache invalidation on write

## Requirements

- Node.js 18+
- A reachable Qdrant instance, **or** a PostgreSQL instance with the `vector` (pgvector) extension available
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

#### PostgreSQL / pgvector

Any Postgres with the `vector` extension available. Example, local Docker:

```bash
docker run -p 5432:5432 -e POSTGRES_PASSWORD=postgres -v ./pg_data:/var/lib/postgresql/data pgvector/pgvector:pg17
```

```env
MEMORY_BACKEND=postgres
POSTGRES_URL=postgresql://postgres@localhost:5432/memory
POSTGRES_PASSWORD=postgres
```

The `vector` extension and both tables (`memory_collections`, `memory_points`) are created automatically on first connect - no manual migration step. See [`instructions/migration_plan.md/plan.md`](instructions/migration_plan.md/plan.md) §4 for the schema and design notes. If you have existing data in Qdrant and want to move it into Postgres, see [Migrating Qdrant data into Postgres](#migrating-qdrant-data-into-postgres) below.

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

Full parameter tables and return shapes: [`skill/API-REFERENCE.md`](skill/API-REFERENCE.md).

### Migrating from v2.x

v3.0 condenses the 35 v2 tools into these 7; the per-tool mapping is in [`skill/SKILL.md`](skill/SKILL.md).

### Migrating Qdrant data into Postgres

`skill/migrate-qdrant-to-pgvector.mjs` is a one-time, one-way copy of every point in a Qdrant collection into the Postgres backend's schema. It's only needed if you have existing Qdrant data and want to start using `MEMORY_BACKEND=postgres` with it - the two backends are otherwise independent and nothing else moves data between them.

```bash
node skill/migrate-qdrant-to-pgvector.mjs --project project-agent-memory \
  --qdrant-url http://localhost:6333 \
  --postgres-url postgresql://postgres@localhost:5432/memory
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
