# Configuration

## Install

Runs via `npx` - no global install, no long-running service:

```bash
npx -y project-agent-memory
```

You need a reachable Qdrant, or a Postgres/pgvector instance sitting behind a pREST instance. Everything else has a working default.

## Environment variables

### Storage backend

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_BACKEND` | `qdrant` | `qdrant` or `postgres` |
| `POOL_SIZE` | `10` | Client pool size, applies to the selected backend |

### Qdrant

| Variable | Default | Description |
|----------|---------|-------------|
| `QDRANT_URL` | `http://localhost:6333` | Qdrant endpoint |
| `QDRANT_API_KEY` | unset | Required by Qdrant Cloud, ignored locally |

### Postgres / pgvector (via pREST)

`MEMORY_BACKEND=postgres` talks to Postgres through [pREST](https://prest.dev), not a direct connection.

| Variable | Default | Description |
|----------|---------|-------------|
| `PREST_URL` | unset | pREST endpoint, e.g. `http://localhost:3000` |
| `PREST_JWT_KEY` | unset | Must match the key pREST was started with; used to sign the admin bearer token |
| `PREST_REGISTER_ADMIN` | `admin` | pREST admin username the registered queries run as |
| `PREST_DATABASE` | `memory` | Database name as known to pREST |

Requires the `vector` extension. Tables `memory_collections` and `memory_points`, and the registered pREST queries the server calls, are created on first use.

### Vectors

| Variable | Default | Description |
|----------|---------|-------------|
| `VECTOR_DIM` | `768` | Vector size. Integer 1-4096; an invalid value fails at startup |
| `DISTANCE_METRIC` | `Cosine` | `Cosine`, `Euclid` or `Dot` |

`VECTOR_DIM` must be less than or equal to the dimension your embedding model produces. Larger vectors are truncated to `VECTOR_DIM` and re-normalized (Matryoshka-style, which `nomic-embed-text-v1.5` is trained for); a value larger than the model's output is an error, not a pad.

**Changing `VECTOR_DIM` destroys data.** On the next call the server sees the size mismatch, warns on stderr, deletes the project collection and recreates it empty.

### Embeddings

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_PROVIDER` | `onnx` | `onnx`, `openai`, `gemini`, `openrouter` |
| `EMBEDDING_MODEL` | `nomic-ai/nomic-embed-text-v1.5` | Model id for the chosen provider |
| `ONNX_MODEL_CACHE_DIR` | `~/mcp/project-agent-memory/models` | Where the ONNX model is cached |
| `ONNX_DTYPE` | `q8` | Quantization: `q8`, `q4`, `fp16`, `fp32` |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Endpoint for the `openai` provider |
| `OPENAI_API_KEY` | unset | Key for the `openai` provider |
| `GEMINI_API_KEY` | unset | Required by the `gemini` provider |
| `OPENROUTER_API_KEY` | unset | Required by the `openrouter` provider |
| `EMBEDDING_CACHE_SIZE` | `1000` | LRU entries |

An unrecognized `EMBEDDING_PROVIDER` is a startup error. There is no fallback provider - a failing provider fails the call rather than returning degraded vectors.

#### onnx (default)

Embeddings run in-process on CPU via `@huggingface/transformers`. No embedding service, no network calls at query time. The model (~140MB at `q8`) downloads on first embed into `ONNX_MODEL_CACHE_DIR`, which lives under your home directory so `npx` runs reuse it. First embed after a cold start takes a few seconds; after that it is local and fast.

#### openai (also Ollama, LM Studio, vLLM, LiteLLM)

Any endpoint speaking the OpenAI `/v1/embeddings` API:

```bash
EMBEDDING_PROVIDER=openai
OPENAI_BASE_URL=http://localhost:11434/v1   # Ollama
EMBEDDING_MODEL=nomic-embed-text
VECTOR_DIM=768
```

```bash
EMBEDDING_PROVIDER=openai
OPENAI_BASE_URL=http://localhost:1234/v1    # LM Studio
EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5
```

```bash
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=sk-...                       # OpenAI itself
EMBEDDING_MODEL=text-embedding-3-small
VECTOR_DIM=768
```

`OPENAI_API_KEY` may be omitted for local servers that do not check it.

### Summarization

Long text is summarized before embedding when it exceeds the chunking threshold.

| Variable | Default | Description |
|----------|---------|-------------|
| `SUMMARIZER_PROVIDER` | `openrouter` | `openrouter`, `gemini`, `ollama` |
| `SUMMARIZER_MODEL` | `openai/gpt-oss-20b:free` | Model id |
| `OLLAMA_API_URL` | `http://localhost:11434` | Used only by the `ollama` summarizer |
| `OLLAMA_API_KEY` | unset | Used only by the `ollama` summarizer |

### Caching

| Variable | Default |
|----------|---------|
| `CACHE_TTL_SECONDS` | `300` |
| `QUERY_CACHE_SIZE` | `500` |

## Client configuration

### Claude Code / Claude Desktop

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

That is the whole minimum config: ONNX embeddings and `VECTOR_DIM=768` are the defaults.

### With a remote Qdrant and a hosted embedding provider

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "project-agent-memory"],
      "env": {
        "QDRANT_URL": "https://your-cluster.qdrant.io",
        "QDRANT_API_KEY": "your_key",
        "EMBEDDING_PROVIDER": "openai",
        "OPENAI_API_KEY": "sk-...",
        "EMBEDDING_MODEL": "text-embedding-3-small",
        "VECTOR_DIM": "768"
      }
    }
  }
}
```

### Local development

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["D:/WorkFolder/project-agent-memory/dist/index.js"],
      "env": { "QDRANT_URL": "http://localhost:6333" }
    }
  }
}
```

Run `npm run build` first.

## Qdrant

```bash
docker run -p 6333:6333 -v ./qdrant_storage:/qdrant/storage qdrant/qdrant
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Invalid VECTOR_DIM=...` at startup | Non-integer or out of 1-4096 | Correct the value |
| `VECTOR_DIM=N exceeds the M dimensions produced by...` | Asked for more dimensions than the model emits | Set `VECTOR_DIM=M` or pick a larger model |
| Warning that the collection is being recreated | `VECTOR_DIM` differs from the stored collection | Revert `VECTOR_DIM` to the size named in the warning to keep the data |
| `Unknown EMBEDDING_PROVIDER=...` | Typo, or a v2 provider name (`fastembed`, `ollama`) | Use `onnx`, `openai`, `gemini` or `openrouter`; for Ollama use `openai` with `OPENAI_BASE_URL=http://localhost:11434/v1` |
| Long pause on the first memory call | ONNX model downloading | Expected once; it is cached under `ONNX_MODEL_CACHE_DIR` |
| Search returns nothing relevant | Collection was written with a different embedding model | Vectors from two models are not comparable - re-create the entries under one provider |
