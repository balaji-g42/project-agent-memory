# Memory MCP — PostgreSQL/pgvector Migration Plan (rev. 2)

This supersedes the first handoff. The first revision bundled two unrelated changes — MCP tool reduction and a database swap — and described several capabilities as "existing, preserve" that were stubs or did not work. The tool reduction is now finished and shipped; what remains is the database swap alone, plus a short list of things the first plan assumed already existed and which must be built from scratch if they are wanted.

---

# 0. Status

| Original goal | Status |
|---------------|--------|
| Reduce the MCP tool surface | **Done** — v3.0, 7 tools |
| Generic CRUD instead of specialized tools | **Done** |
| Configurable vector dimension | **Done** — `VECTOR_DIM`, default 768 |
| Local, CPU, 768-dim embeddings | **Done** — ONNX in-process, no Ollama |
| Single embedding provider abstraction, no silent fallbacks | **Done** |
| Replace Qdrant with PostgreSQL + pgvector | **Not started** — the subject of this plan |
| Self-hosted, no cloud services | Holds |

Everything in sections 1 and 2 is already in `master` as uncommitted work. Read them before planning; do not re-derive them.

---

# 1. What v3.0 already changed

**Tool surface: 35 → 7.** A hard cut, no deprecation window. Registered in `src/index.ts`:

- `memory_create(project_name, items[{ memory_type, content, id?, metadata? }])` → `[{ id, type }]`
- `memory_read(project_name, queries[{ query_text?, memory_type?, metadata_filter?, limit=5 }])` → one `[{ id, score, content, type, timestamp, metadata }]` per query
  - with `query_text`: vector search
  - without: recency listing via `client.scroll`, embeds nothing
- `memory_update(project_name, items[{ id, content?, metadata? }])` → `[{ id, updated }]`
- `memory_delete(project_name, ids[])` → `{ deleted }`
- `memory_context(project_name, product_context?, active_context?, pattern_limit=20)` → `{ productContext, activeContext, systemPatterns }`
- `memory_graph(project_name, op: link | neighbors | unlink, …)` → created edges / `{ neighbors, edges }` / `{ deleted }`
- `memory_admin(project_name, op: export | import | summarize, …)` → markdown / `{ imported, errors, timestamp }` / condensed text

The four CRUD tools take arrays, so a single write and a batch write are the same call. This supersedes 2.8.

`memory_context` is a tool the original plan did not have. It exists because product context, active context and system patterns are read together at every session start; folding them into `memory_read` would have meant three round trips and a wider schema. Patches are shallow-merged, the previous version is written to `contextHistory`, and reads happen after writes so one call both patches and returns.

`memory_type` is data, exactly as section 5 of the original plan required. Valid values: the seven from v2 — `productContext`, `activeContext`, `systemPatterns`, `decisionLog`, `progress`, `contextHistory`, `customData` — plus `knowledgeLink` for graph edges.

**`metadata` is populated.** Every point now carries a `metadata` object alongside `type`, `content`, `timestamp` and `project`. `memory_read` filters on it through nested Qdrant payload keys (`metadata.status`), with an array value matching any element. The `metadata JSONB` column in section 10 is therefore live data, not a forward-looking placeholder, and needs its GIN index from day one.

**Graph edges are ordinary points.** `memory_graph` writes edges into the same collection with `type = "knowledgeLink"` and `metadata = { sourceId, targetId, linkType }`. No second collection, no new service. `neighbors` scrolls all edges for the project (cap `MAX_GRAPH_EDGES = 10000`), walks them breadth-first to the requested depth, then does one `retrieve` for the reached nodes. In Postgres this becomes a filtered `SELECT` over the same table plus a recursive CTE, not a new table.

**Embeddings.** One factory in `src/embeddings.ts`, `SUPPORTED_PROVIDERS = ["onnx", "openai", "gemini", "openrouter"]`. Unknown provider is a startup error. There is no fallback provider.

- `onnx` (default): `nomic-ai/nomic-embed-text-v1.5` run in-process on CPU via `@huggingface/transformers`, `q8`, ~140MB, cached in `~/mcp/memory-qdrant-mcp/models`.
- `openai`: any OpenAI-compatible `/v1/embeddings` endpoint via `OPENAI_BASE_URL`. This is how Ollama is reached if someone wants it (`http://localhost:11434/v1`).
- The `fastembed` and `ollama` providers were **deleted**. `fastEmbed.ts` returned random vectors and was both the default provider and the universal silent fallback, so a v2 collection may contain noise.

**Vector dimension.** `VECTOR_DIM`, integer 1–4096, default 768, validated at startup. Larger model output is Matryoshka-truncated and re-normalized. On a size mismatch against an existing collection the server warns on stderr, **deletes the collection** and recreates it empty. This is deliberate and was chosen over refusing to start.

**Deleted modules:** `src/embeddings/fastEmbed.ts`, `src/embeddings/ollama.ts`, `src/mcp_tools/contextTools.ts`, `src/mcp_tools/store.ts`, `src/mcp_tools/search.ts`.

**Distribution:** `npx -y memory-qdrant-mcp`, stdio, one process per client session. The MCP server is **not** a long-running Docker service. This invalidates the original section 19's service list.

---

# 2. Corrections to the original plan

Each of these is a factual correction, not a change of intent.

**2.1 — The 4-tool target is now 7, and it is frozen.** Do not reopen it. `memory_context` earns its place; `memory_graph` and `memory_admin` exist because the capabilities they hold were dropped without authorization in the first cut and had to be brought back — folded into two op-discriminated tools rather than re-registered one per function. See 1.

**2.2 — Ollama is not the embedding path.** Original sections 2, 10, 11, 19, 23 assume `Ollama → nomic-embed-text:v1.5`. Embeddings now run in-process. This removes a container, a model volume, a network hop and ~1–2 GB of runtime RAM from the deployment. Ollama remains reachable through the `openai` provider for anyone who wants it, and remains an option for the *summarizer* only.

**2.3 — Vector dimension is configurable, not fixed at 768.** Original section 10 hard-codes `vector(768)`. The Postgres schema must take the dimension from `VECTOR_DIM` at collection/table creation time, the way the Qdrant path does. 768 is the default and the only value being tested.

**2.4 — "Preserve the embedding provider abstraction" is already satisfied.** Original section 11 and step 3 of section 25 can be struck. The abstraction exists (`EmbeddingProviderBase.embedTexts`), is already wired, and is database-independent.

**2.5 — Several "existing capabilities" did not exist.** Original sections 1, 7, 13 and 14 instruct that these be preserved. They must be reclassified as **new work**, to be built only if explicitly wanted:

| Capability | Reality in v2 | Status |
|---|---|---|
| Full-text search | `search_decisions_fts` etc. were substring scans over scrolled payloads, not an index | NEW work if wanted |
| Hybrid ranking / reranking | Never existed. Retrieval was `client.search` ordered by cosine distance | NEW work if wanted |
| Knowledge links / relationships | `create_knowledge_link` / `get_knowledge_links` wrote link records nothing ever traversed | **Built** — rewritten and exposed as `memory_graph` |
| Markdown import/export | Round-tripped this server's own format only | **Re-exposed** — `memory_admin` |
| Conversation analysis | Heuristic keyword extraction | **Deleted** |
| `sync_memory` | Returned a status object; synchronized nothing | Dropped from the surface; code left in place |
| Summarization | Worked. Condensed large result sets before returning them | **Re-exposed** — `memory_admin` |

**Unregistered is not removed.** v3.0 cut the MCP tool *registrations* and deleted the three modules that held them (`contextTools.ts`, `store.ts`, `search.ts`). The implementations in `src/mcp_tools/memoryBankTools.ts` were largely left alone. `src/index.ts` now imports 15 of them; after internal helpers roughly 25 remain unreachable — batch ops, sync, custom data, FTS, progress-with-status. `ConversationMetadata` in `types.ts` is dead now that `analyzeConversation` is gone.

The disposition, now decided:

- **Re-exposed** — `createKnowledgeLink`, `getKnowledgeLinks`, `exportMemoryToMarkdown`, `importMemoryFromMarkdown` (with `convertToMarkdown` / `parseMarkdownToMemory`), `summarizeText`. These must be ported.
- **Built new** — `getNeighbors` and `deleteKnowledgeLinks`. The v2 link reader searched with a dummy embedding of the literal string `"knowledge links"` capped at 100 results and filtered client-side, so it could silently miss edges; it is now an exact `client.scroll` over a `type = "knowledgeLink"` filter. Note v2-written edges stored `sourceId`/`targetId`/`linkType` at the payload top level and are not read by the new code.
- **Deleted** — `analyzeConversation` and its `AnalysisDecision` / `AnalysisProgress` / `AnalysisResults` types.
- **Left in place, not ported** — `syncMemory` / `syncFromSource` and the ~25 other unreachable functions. They are pre-existing dead code; they are not to be deleted without instruction, and they are not to be given SQL equivalents.

Original section 8 recommended that administrative operations live in a CLI rather than the MCP surface. Superseded: they are on the surface as `memory_admin` ops, which costs one schema rather than a CLI nobody has scheduled.

Original section 24 ("mapping must cover EVERY current MCP tool… do not start deleting tools before this mapping is complete") is satisfied: the full 35 → 7 mapping is in `skill/SKILL.md` under "Migrating from v2.x". Reuse it, do not redo it.

**2.6 — Section 25 Step 2's "database abstraction layer" is dropped.** There is exactly one backend after this migration. A persistence interface with a single implementation is an abstraction for a hypothetical second caller. Port `src/init.ts` and the Qdrant calls in `src/mcp_tools/memoryBankTools.ts` directly to SQL. If a second backend is ever genuinely needed, extract the interface then, from two working implementations.

**2.7 — Sections 21 and 22 contradict each other and both over-scope the migration.** 21 says preserve IDs and regenerate embeddings only if incompatible; 22 says never truncate or pad. In practice every existing vector is incompatible — v2 wrote with `fastembed` (random), OpenRouter `qwen3-embedding-8b` (4096-dim) or Gemini, depending on configuration and on which of the two competing provider factories the call path hit. **No vector is migrated.** Migration is: export payloads, re-embed every row with the configured provider, validate counts. Sections 21 and 22 collapse to that.

**2.8 — Bounded batches (section 4) apply after all.** All four CRUD tools take arrays, so a single call can fan out arbitrarily wide: `memory_create` and `memory_update` embed and upsert per item, `memory_read` runs one search per query. Nothing caps the array length today. If a cap is wanted, add `MEMORY_MAX_BATCH_SIZE` and enforce it in `src/index.ts` at the schema, not in the port.

**2.9 — Section 17's measurement task is done by construction.** 35 schemas → 7 small ones. Measure the `tools/list` payload once after the migration if a number is wanted; do not make it a gating step.

---

# 3. Remaining objective

Replace Qdrant with self-hosted PostgreSQL + pgvector as the persistence and vector-search backend, with **no change to the MCP tool surface, the embedding pipeline, or memory semantics**.

Success criteria:

1. `tools/list` is byte-identical before and after.
2. The seven tools behave identically against Postgres — same return shapes, same ordering, same error cases, including `metadata_filter` and every `memory_graph` / `memory_admin` op.
3. `@qdrant/js-client-rest` is gone from `package.json`.
4. A fresh `npx` run against an empty Postgres creates its schema and works.
5. Existing Qdrant memories are re-embedded into Postgres with IDs, project, type, content and timestamps intact, and counts match.

---

# 4. Target architecture

```
Claude Code
   │  stdio, npx, one process per session
   ▼
Memory MCP  (memory_create / read / update / delete / context / graph / admin)
   │
   ├── embeddings: @huggingface/transformers, in-process CPU, nomic-embed-text-v1.5
   ├── summarizer: OpenRouter (network, optional)
   ├── LRU caches: embedding, query, context, pattern
   │
   ▼
PostgreSQL + pgvector   (Docker, persistent bind mount)
   ├── relational memory rows
   ├── vector(VECTOR_DIM) embeddings, HNSW cosine
   └── JSONB metadata
```

One container: Postgres. The MCP server runs from `npx` on the host. Ollama is not in the deployment.

---

# 5. Schema

Per-project isolation is currently physical — one Qdrant collection per project (`memory_bank_<project>`). In Postgres it becomes a `project` column with an index. Isolation must be enforced in every query's `WHERE` clause, at the data layer, never by convention (original section 16 stands).

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memories (
    id          TEXT PRIMARY KEY,
    project     TEXT NOT NULL,
    type        TEXT NOT NULL,
    content     TEXT NOT NULL,
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    embedding   vector(768) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX memories_project_type_idx ON memories (project, type);
CREATE INDEX memories_project_updated_idx ON memories (project, updated_at DESC);
CREATE INDEX memories_embedding_idx ON memories USING hnsw (embedding vector_cosine_ops);
CREATE INDEX memories_metadata_idx ON memories USING gin (metadata);
```

Notes:

- `vector(768)` is written at DDL time from `config.VECTOR_DIM`, not hard-coded. Changing `VECTOR_DIM` against an existing table must produce the same loud warn-and-recreate behaviour the Qdrant path has, so the two backends are not surprising in different ways. Verify HNSW/`vector_cosine_ops` syntax against the installed pgvector version before writing the DDL.
- `id` stays `TEXT`: v2 ids are UUID strings and placeholder ids, and `memory_create` accepts a caller-supplied `id`.
- `memories_project_updated_idx` is what `memory_read`'s list mode uses. That mode must stay embedding-free — a plain `ORDER BY updated_at DESC LIMIT n`.
- The v3 payload is `{ type, content, metadata, timestamp, project }` (v2 rows lack `metadata`; import them as `{}`). `timestamp` maps to `updated_at`. `metadata` carries live data — `memory_read`'s `metadata_filter` becomes a JSONB containment or `->>` comparison per key, with an array value becoming an `IN`, and `memories_metadata_idx` is required from day one, not optional.
- Graph edges are rows in this same table with `type = 'knowledgeLink'` and `metadata = { sourceId, targetId, linkType }`. No edge table. `memory_graph`'s `neighbors` op is the one place a recursive CTE over `metadata->>'sourceId'` / `metadata->>'targetId'` will read better than the client-side BFS the Qdrant path uses; either is acceptable as long as the return shape is unchanged.

**Chunk → row mapping.** Current behaviour: long content is chunked, each chunk is embedded, the embeddings are **averaged into one vector**, and the payload keeps the full original text — one point per memory. Keep exactly that: one row per memory, one averaged vector. Per-chunk rows would change retrieval behaviour and result shapes and is out of scope. If it is ever wanted it needs a separate `memory_chunks` table and a change to the return shape, and that is a v4 decision.

**Placeholder points.** `initMemoryBank` seeds one placeholder per memory type on collection creation. Decide explicitly whether to keep this in Postgres. It exists only because Qdrant needed a point before a filtered scroll returned sensibly; Postgres does not, so the default should be to drop it — but that changes what a fresh `memory_read` returns, so make it a conscious call, not a silent one.

---

# 6. Embeddings

No change. `src/embeddings.ts` and `src/embeddings/*` are database-independent and stay as they are. The Postgres layer receives `number[]` and binds it as a `vector` literal.

Original section 11's "do not hard-code the embedding provider into database code" stands and is currently satisfied — do not regress it while porting.

---

# 7. Retrieval

`memory_read` search mode, in SQL:

```sql
SELECT id, content, type, updated_at,
       1 - (embedding <=> $1) AS score
FROM memories
WHERE project = $2
  AND ($3::text IS NULL OR type = $3)
ORDER BY embedding <=> $1
LIMIT $4;
```

`<=>` is cosine distance under `vector_cosine_ops`; score is reported as similarity to match the Qdrant `score` field. That is the whole of current retrieval semantics — original section 13's "audit the existing retrieval implementation for additional filtering/scoring" was done: there is no additional ranking to preserve.

List mode:

```sql
SELECT id, content, type, updated_at, 0 AS score
FROM memories
WHERE project = $1 AND ($2::text IS NULL OR type = $2)
ORDER BY updated_at DESC
LIMIT $3;
```

**Caching.** `src/cache.ts` holds `embeddingCache`, `queryCache`, `contextCache`, `patternCache`, with `cacheUtils.invalidateProjectCache(projectName)` called after every write. The Postgres layer must call it at exactly the same points — after create, update and delete, and after each `memory_context` patch. A missed invalidation here surfaces as stale reads that look like a database bug.

---

# 8. Full-text and hybrid search — new work, optional

Not part of the migration. Land the migration first, green, then decide. If wanted:

```sql
ALTER TABLE memories
  ADD COLUMN content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX memories_content_tsv_idx ON memories USING gin (content_tsv);
```

Hybrid ranking then means combining `ts_rank_cd` with cosine similarity, which needs a weighting decision and a way to expose it. Neither the schema addition nor the ranking exists today, and neither is needed for parity. Treat as a separate change with its own tests.

---

# 9. Migration from Qdrant

One-shot, offline, run by the developer. Not an MCP tool.

1. Scroll every `memory_bank_*` collection with `with_payload: true, with_vector: false`. **Do not read vectors** — none of them are usable (see 2.7).
2. For each point emit `{ id, project, type, content, timestamp }` to a JSONL file per collection. This file is the backup; keep it.
3. Re-embed every `content` with the configured provider, batched, honouring the existing chunk-and-average path so vectors match what `memory_create` would produce today.
4. Insert into `memories`, preserving `id`, `project`, `type`, `content`, and mapping `timestamp` → `created_at` and `updated_at`.
5. Validate: row count per project equals point count per collection minus any placeholders you chose to drop; spot-check that a known query returns the expected entry.
6. Leave the Qdrant collections in place until validation passes.

Reversibility is the JSONL export, not a live dual-write. Do not build a dual-write path.

Note for expectation-setting: a v2 collection written while `fastembed` was active contains random vectors, so its *search* results were meaningless. The stored `content` is still correct, which is why re-embedding recovers the data fully.

---

# 10. Removing Qdrant

Only after 9 validates:

- delete `src/init.ts`'s Qdrant client and collection logic, replaced by the Postgres pool and DDL
- delete every `client.*` call in `src/mcp_tools/memoryBankTools.ts`
- remove `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_POOL_SIZE` from `src/config.ts`, `.env.example`, `skill/MCP-CONFIG.md`, `skill/README.md`, the three `skill/*.example.json` files and the root `README.md`
- remove `@qdrant/js-client-rest` from `package.json`
- replace the Qdrant `docker run` line in the root `README.md` with the Postgres Compose file from section 11, and stop the Qdrant container
- the hard-coded `port: 443` on the current Qdrant client goes with it — it is a pre-existing oddity, not behaviour to port

Replace with `POSTGRES_URL` (single DSN) plus a pool size. One variable, not five.

---

# 11. Docker

The MCP server is an `npx` process, not a service. Only the data stores are containers.

**Qdrant stays up through steps 1–6.** Its current setup is the `docker run` line in the root `README.md`, and it is unchanged by this migration — the migration in section 9 reads from it, and the parity test in step 5 runs both backends side by side. Keep it:

```bash
docker run -p 6333:6333 -v ./qdrant_storage:/qdrant/storage qdrant/qdrant
```

Retire it only at step 7, after section 9 validates. Ollama was never a container in this repo; it was a service proposed by the original plan's section 19 and an embedding provider module, both dropped.

Postgres is added alongside:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    container_name: memory-postgres
    restart: unless-stopped
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: memory
      POSTGRES_USER: memory
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password
    volumes:
      - ./postgres_data:/var/lib/postgresql/data
    secrets:
      - postgres_password
    deploy:
      resources:
        limits:
          memory: 1g
          cpus: "1.0"

secrets:
  postgres_password:
    file: ./secrets/postgres_password
```

Bind mount, not a named volume. Password via a Docker secret, not an env-file value. Resource limits present. No Ollama service, no Qdrant service.

---

# 12. Implementation order

0. **Done.** The fate of the unreachable functions is decided and recorded in 2.5: graph, import/export and summarize re-exposed via `memory_graph` / `memory_admin`; `analyzeConversation` deleted; sync dropped from the surface with its code left in place; the remaining ~25 functions stay dead and are **not** ported. Steps 1–8 touch only what `index.ts` imports.
1. **Schema and connection.** `pgvector/pgvector` container up, DDL applied from `VECTOR_DIM`, pool wired, `SELECT 1` green. → verify: server starts, connects, creates the table on an empty database.
2. **Port writes.** `logMemory`, `updateMemory`, `deleteMemory`, `logStructuredMemory` to SQL, with the same `invalidateProjectCache` calls. `updateMemory` must keep reusing the stored vector when `content` is omitted and shallow-merging `metadata`. → verify: `memory_create` / `memory_update` / `memory_delete` round-trip through the Inspector, single-item and multi-item.
3. **Port reads.** `queryMemory`, `listMemory`, `getStructuredContext`, `getSystemPatterns`, including `metadataFilterClauses` → JSONB predicates. → verify: search returns sane scores for a known corpus; list mode issues no embedding call; a `metadata_filter` with an array value matches any element.
4. **Context.** `memory_context` including the `contextHistory` write on patch. → verify: patch-then-read in one call returns the patched state.
4b. **Port graph and admin.** `createKnowledgeLink`, `getAllKnowledgeLinks`, `getKnowledgeLinks`, `getNeighbors`, `deleteKnowledgeLinks`, `exportMemoryToMarkdown`, `importMemoryFromMarkdown`. `summarizeText` is provider-side and needs no port. → verify: link → neighbors at depth 2 → unlink round-trips; export → import → export is stable.
5. **Parity test.** Same script against Qdrant and Postgres, diff the outputs. → verify: identical result shapes and ordering.
6. **Migrate** per section 9. → verify: counts match, spot-checks pass.
7. **Remove Qdrant** per section 10. → verify: `npm run build` green, `tools/list` unchanged, grep for `qdrant` returns only changelog text.
8. **Docs.** `.env.example`, `skill/MCP-CONFIG.md`, `skill/README.md`, the three example configs, root `README.md`, and the `CLAUDE.md` memory section. → verify: a clean-machine walkthrough of the README works.

Steps 1–5 do not delete anything. Qdrant stays runnable until step 7.

---

# 13. Testing

`tests/all-tools.test.ts` currently drives the 35 v2 tools over stdio and will fail wholesale against v3.0. It must be rewritten for the 7 tools before it can gate this migration. `tests/TESTING_README.md` documents the same v2 surface and is stale for the same reason. `package.json` also carries a dead `test:gemini` script pointing at a file that does not exist (pre-existing).

Required coverage:

- **create** — one entry; explicit `id` overwrites; unknown `memory_type` rejected
- **read search** — returns by relevance; `memory_type` filter; `limit` honoured; scores in range
- **read list** — recency order; no embedding call issued; `memory_type` filter
- **update** — content replaced and re-embedded; other payload fields preserved; `updated_at` refreshed; unknown id throws
- **delete** — count returned; unknown ids ignored, not raised; entry gone from subsequent reads
- **context** — patch merges shallowly; previous version lands in `contextHistory`; empty product context initializes; read reflects the write in the same call
- **batching** — a multi-item `memory_create` / `memory_update` and a multi-query `memory_read` return one result per element, in order
- **metadata** — stored on create, merged on update, filterable on read; an array filter value matches any element
- **graph** — `link` then `neighbors` at depth 2 reaches only what the edges connect; `direction` restricts correctly; `unlink` removes the edge and not the nodes
- **admin** — `export` → `import` → `export` is stable; `import` on foreign markdown reports errors rather than throwing
- **project isolation** — a query in project A never returns a project B row, at the SQL level
- **cache** — a write invalidates a cached query for that project only
- **dimension guard** — changing `VECTOR_DIM` against an existing table warns and recreates
- **embeddings** — vector length equals `VECTOR_DIM`; provider failure propagates as an error rather than a degraded vector
- **database** — survives a Postgres restart with the bind mount intact; concurrent writes; a failed insert rolls back

Original section 26's relationship and markdown-migration cases are dropped — those capabilities no longer exist.

---

# 14. Out of scope

Do not do these as part of this migration:

- reopening the tool count or schemas
- a persistence abstraction layer (2.6)
- per-chunk rows (5)
- FTS or hybrid ranking (8)
- knowledge links, markdown import/export, conversation analysis (2.5)
- bounded-batch tooling (2.8)
- dual-write or live cutover (9)

---

# 15. Design constraint

Unchanged from the original section 27, and now narrower:

```
CURRENT:  Claude Code → 5 MCP tools → memory engine → Qdrant
TARGET:   Claude Code → 5 MCP tools → memory engine → PostgreSQL + pgvector
```

The tool surface, the embedding pipeline, the summarizer and the memory semantics are fixed. Only the storage layer moves. Any change outside that line is a separate proposal.
