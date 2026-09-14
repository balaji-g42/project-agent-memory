# Memory Qdrant MCP

A TypeScript MCP (Model Context Protocol) server that gives a coding agent persistent project memory - context, decisions, progress and patterns - backed by a Qdrant vector database.

## Features

- **7 MCP tools**: `memory_create`, `memory_read`, `memory_update`, `memory_delete`, `memory_context`, `memory_graph`, `memory_admin`
- **Local embeddings by default**: ONNX CPU inference in-process via `@huggingface/transformers`; no embedding service, no API key, nothing leaves the machine except the Qdrant writes
- **Configurable vector dimension**: `VECTOR_DIM` (default 768), Matryoshka-truncated and re-normalized
- **Pluggable providers**: `onnx`, `openai` (any OpenAI-compatible endpoint - Ollama, LM Studio, vLLM, LiteLLM, OpenAI itself), `gemini`, `openrouter`
- **No silent fallbacks**: a failing provider fails the call rather than returning degraded vectors
- **Runs via `npx`**: no global install, no long-running service
- **Performance**: Qdrant connection pooling, LRU caches for embeddings and queries, cache invalidation on write

## Requirements

- Node.js 18+
- A reachable Qdrant instance (local or cloud)
- No API key with the default `onnx` provider

## Installation

### Using npx (recommended)

```bash
npx -y memory-qdrant-mcp
```

### From source

```bash
git clone https://github.com/balaji-g42/memory-qdrant-mcp
cd memory-qdrant-mcp
npm install
npm run build
node dist/index.js
```

## Setup

### 1. Qdrant

```bash
docker run -p 6333:6333 -v ./qdrant_storage:/qdrant/storage qdrant/qdrant
```

### 2. Configuration

Minimum - everything else has a working default:

```env
QDRANT_URL=http://localhost:6333
```

Common settings:

```env
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

The full environment-variable reference is in [`skill/MCP-CONFIG.md`](skill/MCP-CONFIG.md).

**Changing `VECTOR_DIM` destroys data.** On the next call the server sees the size mismatch against the stored collection, warns on stderr, deletes that collection and recreates it empty.

### Embedding providers

| Provider | Notes |
|----------|-------|
| `onnx` (default) | In-process CPU inference. `nomic-ai/nomic-embed-text-v1.5`, 768 dims, ~140MB at `q8`, downloaded once into `~/mcp/memory-qdrant-mcp/models` so `npx` runs reuse it |
| `openai` | Any endpoint speaking `/v1/embeddings`. Set `OPENAI_BASE_URL`; for Ollama use `http://localhost:11434/v1` |
| `gemini` | Requires `GEMINI_API_KEY` |
| `openrouter` | Requires `OPENROUTER_API_KEY` |

An unrecognized `EMBEDDING_PROVIDER` is a startup error.

## MCP Configuration

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "memory-qdrant-mcp"],
      "env": {
        "QDRANT_URL": "http://localhost:6333"
      }
    }
  }
}
```

Client-specific templates are in [`skill/`](skill/): `claude-config.example.json`, `vscode-mcp-config.example.json`, `cursor-config.example.json`.

## Agent Skill

A Claude Agent Skill lives in [`skill/`](skill/) - install it so the agent knows when and how to use these tools without being told each session.

- **Claude Code**: copy `skill/*` into `.claude/skills/memory-qdrant-mcp/` (project) or `~/.claude/skills/memory-qdrant-mcp/` (global)
- **Claude.ai**: zip `skill/` and upload via Settings → Features → Skills

See [`skill/README.md`](skill/README.md).

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
memory-qdrant-mcp/
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
│   └── mcp_tools/
│       ├── memoryBankTools.ts
│       └── summarizer.ts
├── dist/                     # Compiled output (generated)
├── tests/
├── skill/                    # Claude Agent Skill
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
- [Transformers.js](https://huggingface.co/docs/transformers.js)
- [OpenRouter](https://openrouter.ai)
