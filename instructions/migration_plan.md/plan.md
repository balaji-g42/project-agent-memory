# Memory MCP — Dual Backend (Qdrant + PostgreSQL/pgvector) — rev. 3

Rev. 2 planned to **replace** Qdrant with Postgres. That direction was reversed: Qdrant stays, Postgres/pgvector was added as a second, env-selectable backend. Rev. 2's removal sections (old §2.6, §9, §10) no longer apply and are dropped from this document. Everything below reflects what is actually true in the repo today.

---

# 0. Status

| Goal | Status |
|---|---|
| Reduce MCP tool surface (35 → 7) | **Done** — v3.0 |
| Configurable vector dimension | **Done** — `VECTOR_DIM`, default 768 |
| Local CPU embeddings, no Ollama dependency | **Done** — ONNX in-process |
| Qdrant durability / correctness fixes | **Done** — see §2 |
| Postgres/pgvector as a second backend | **Done** — `MEMORY_BACKEND=postgres` |
| Env-driven backend selection, no code change to switch | **Done** |
| Backward compatibility with existing Qdrant deployments | **Done** — Qdrant is untouched, still the default |
| Test suite rewritten for the 7-tool v3 surface | **Done** — `tests/all-tools.test.ts` / `TESTING_README.md` rewritten against real backends, not yet run |
| Qdrant → Postgres one-time migration script | **Done** — `skill/migrate-qdrant-to-pgvector.mjs`, any-dim (truncate+renormalize or refuse), `--all` mode added and run live — see §5a |
| Root `README.md` dual-backend rewrite | **Done** |
| `skill/SKILL.md` / `skill/README.md` dual-backend rewrite | **Not started** |
| Claude Code plugin packaging (`.claude-plugin/`) | **Not started** — not previously part of this repo; assumption pending confirmation |
| Branch pushed | **Not done** — `v3-tool-surface-rewrite`, unpushed |

---

# 1. Tool surface (unchanged from rev. 2, still current)

Registered in `src/index.ts`:

- `memory_create(project_name, items[{ memory_type, content, id?, metadata? }])` → `[{ id, type }]`
- `memory_read(project_name, queries[{ query_text?, memory_type?, metadata_filter?, limit=5 }])` → one result array per query
- `memory_update(project_name, items[{ id, content?, metadata? }])` → `[{ id, updated }]`
- `memory_delete(project_name, ids[])` → `{ deleted }`
- `memory_context(project_name, product_context?, active_context?, pattern_limit=20)` → `{ productContext, activeContext, systemPatterns }`
- `memory_graph(project_name, op: link | neighbors | unlink, …)`
- `memory_admin(project_name, op: export | import | summarize, …)`

`memory_type` valid values: `productContext`, `activeContext`, `systemPatterns`, `decisionLog`, `progress`, `contextHistory`, `customData`, plus `knowledgeLink` for graph edges. See `skill/SKILL.md` "Migrating from v2.x" for the full 35→7 mapping — not repeated here.

---

# 2. Qdrant correctness fixes (this session, commit `69fb7c5`)

Three product bugs found while writing the test suite, all fixed on the Qdrant path:

1. **Durability.** All four write sites called `client.upsert`/`client.delete` with the default `wait: false`, so a read immediately after a write could miss it. Fixed: `wait: true` everywhere.
2. **Structured context correctness.** `logStructuredMemory` wrote a new random-UUID point per patch; `getStructuredContext` picked among them by vector similarity, not recency, so patches could merge onto a stale version. Fixed: deterministic point id `uuidv5(project:contextType)`, retrieved by id; falls back to the old similarity search only for pre-existing v2 rows that predate the deterministic id.
3. **Non-UUID caller ids.** Qdrant point ids must be UUID or unsigned integer; a caller-supplied `id` like `"fixed-id-001"` on `memory_create` caused silent failures downstream (`update`, `delete`, graph lookups). Fixed: `toPointId()` hashes any non-UUID, non-integer caller id to a UUIDv5 (namespace-scoped), applied consistently at every entry point (create, update, delete, graph link/neighbors).
4. **Markdown self-import.** Export writes `## ProductContext`; import lowercased headings before matching, so `productcontext` matched nothing and the whole import aborted on the first section. Fixed: case-insensitive canonicalisation against the known type list, per-section error handling instead of one aborting try.

Verified with a 30-check stdio test driver (`scratchpad/run-tools.mjs`, not yet promoted into `tests/`) — 25/30 before these fixes, 30/30 after, against both Qdrant and Postgres.

---

# 3. Backend selection

```
MEMORY_BACKEND=qdrant     # default — existing deployments need no env changes
MEMORY_BACKEND=postgres
POOL_SIZE=10              # shared pool-size knob for whichever backend is active
```

`src/init.ts` picks the client at startup:

```ts
const client: any = config.MEMORY_BACKEND === "postgres"
    ? new PostgresVectorClient()
    : new QdrantClient({ url: config.QDRANT_URL, apiKey: config.QDRANT_API_KEY, ... });
```

`src/mcp_tools/memoryBankTools.ts` calls `client.upsert/retrieve/search/scroll/delete` and is **backend-agnostic** — it required no changes beyond three pre-existing implicit-`any` type annotations. This works because `src/backends/postgres.ts` implements the same method shapes Qdrant's client exposes.

---

# 4. Postgres backend (`src/backends/postgres.ts`)

A Qdrant-API-shaped shim over `pg` + pgvector: `getCollections`, `getCollection`, `createCollection`, `deleteCollection`, `upsert`, `retrieve`, `search`, `scroll`, `delete`.

Schema, created automatically on first use (no manual migration step):

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memory_collections (
    name        TEXT PRIMARY KEY,
    vector_size INTEGER NOT NULL,
    distance    TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memory_points (
    collection  TEXT NOT NULL,
    id          TEXT NOT NULL,
    payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
    embedding   vector(VECTOR_DIM) NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (collection, id)
);

CREATE INDEX ON memory_points USING gin (payload);
CREATE INDEX ON memory_points USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON memory_points (collection, updated_at DESC);
```

Design decisions:

- **One table for all projects/collections.** A Qdrant "collection" (`memory_bank_<project>`) maps to the `collection` column, not a Postgres table per project — avoids DDL-per-project and keeps one HNSW index to tune.
- **The whole Qdrant payload is stored as JSONB.** Every filter key in use (`project`, `type`, `structured`, `status`, `dataType`, `contextType`, `metadata.*`) is answered by one predicate: `payload #> path @> value::jsonb`. This also reproduces Qdrant's `match.any` (array-membership) semantics for free — no special-casing per key.
- **Cosine score:** `1 - (embedding <=> $1)`, matching the Qdrant `score` field callers already expect.
- **Dimension mismatch is non-destructive.** Vector width is a column type (`vector(N)`), so it's global to the table. If `VECTOR_DIM` doesn't match the deployed column, the backend throws a descriptive migration error and changes nothing — deliberately safer than the Qdrant path, which deletes and recreates the collection on a size mismatch.
- **Password handling.** `POSTGRES_PASSWORD` is merged into the parsed `POSTGRES_URL` rather than passed as a separate `pg` pool option — `pg` lets a connection-string password silently overwrite a separately supplied one with `null`.

Env vars, mirroring the `QDRANT_URL`/`QDRANT_API_KEY` pattern:

```
POSTGRES_URL=postgresql://postgres@localhost:5432/memory
POSTGRES_PASSWORD=
```

New dependency: `pg` + `@types/pg`.

---

# 5. Verification

Same 30-check stdio driver run against both backends, with a `-test`-suffixed project name so testing never touches real data:

- Qdrant (remote, existing deployment): **30/30**
- Postgres (local `pgvector/pgvector:pg17` container, WSL, bind-mounted, Docker secret): **30/30**

Coverage: create (single/batch/explicit-id/rejected-type), read (search/filter/limit/list/batch), metadata filter (scalar + array), update (content/metadata/batch), context (init/patch/merge/history), graph (link/neighbors depth 1&2/direction/unlink), admin (export↔import round-trip, foreign-markdown error reporting), project isolation, delete (unknown-id/actual).

---

# 5a. Live migration test — qdrant.geekscodebase.me → local Postgres, 2026-09-14

Ran the actual migration tool against the real remote Qdrant deployment (`qdrant.geekscodebase.me`, 14 collections, credentials from the global Claude Code MCP config) into the local WSL `memory-postgres` container, `--vector-dim 768`.

**Script changes made to support this:**
- Added `--all`: enumerates every Qdrant collection via `getCollections()` and migrates each in one run, instead of one `--project` at a time. In `--all` mode a collection narrower than `--vector-dim` is skipped and reported, not aborted (single-`--project` mode still aborts, since there's nothing else to fall back to).
- Restricted `--all` to `memory_bank_*` names. The server hosts one non-`memory_bank_` collection (`n8n`, an unrelated app) with a different vector config shape (`config.params.vectors` had no single `size`/`distance` — likely named vectors) that isn't compatible with this tool's payload/vector assumptions; excluding it avoids both scraping foreign application data and a crash on malformed per-point vectors. Reported on stderr when excluded.
- Fixed `QdrantClient` defaulting to port 6333 even for an `https://` URL with no explicit port, which made every call time out against the real TLS endpoint (port 443). Now derives the port from the URL (explicit port, else 443/6333 by scheme).
- Added `checkCompatibility: false` — the client's version-compatibility probe also failed against this deployment and isn't needed for a one-shot script.

**Result:** 13 of 14 collections in scope (`memory_bank_*`); 8 migrated (652 points total), 5 skipped as narrower than the 768 target, 1 excluded as foreign:

| Collection | Source dim | Outcome |
|---|---|---|
| `memory_bank_ai_weather` (166), `memory_bank_autensa` (17), `memory_bank_automation-hbox-ng-pepv2` (154), `memory_bank_automation-hboxai-ng-pep` (9), `memory_bank_claude-profile` (195), `memory_bank_memory-qdrant-mcp` (77) | 3072 | Migrated — truncated + re-normalized to 768 |
| `memory_bank_memory-qdrant-mcp-test` (26), `memory_bank_memory-qdrant-mcp-test-isolation` (8) | 768 | Migrated — pass-through |
| `memory_bank_cc-portal`, `memory_bank_emr-automation`, `memory_bank_libretto`, `memory_bank_medical-db`, `memory_bank_mission-control` | 384 | Skipped — narrower than 768, refuse-not-pad rule |
| `n8n` | n/a | Excluded — not a `memory_bank_*` collection, different app |

Verified directly in Postgres afterwards: `memory_collections` has 8 rows all `vector_size=768`; `memory_points` row counts per collection match, `vector_dims(embedding)=768` on every row.

The 384-dim collections remain Qdrant-only. To bring them into this Postgres instance they'd need their own `--vector-dim 384` run against a Postgres schema pinned to 384 (the schema's vector width is a single shared column, so they can't coexist with the 768-dim collections in one database without a second `POSTGRES_URL`/database).

---

# 6. Remaining work

1. ~~Rewrite `tests/all-tools.test.ts` and `tests/TESTING_README.md`~~ — done; not yet run against a live backend (`npm run build && npm test` still pending).
2. **Run the rewritten test suite** against both backends to confirm it actually passes, not just compiles.
3. ~~Update `skill/SKILL.md` and `skill/README.md` for `MEMORY_BACKEND` awareness~~ — done.
4. ~~Qdrant → Postgres `--all`-collections migration, live-tested against `qdrant.geekscodebase.me`~~ — done, see §5a. The `skill/*.example.json` client templates still haven't been checked for `MEMORY_BACKEND` awareness.
5. **Decide and implement "the plugin for claude"** — no `.claude-plugin/` exists in this repo today. Current working assumption: this refers to the existing `skill/` Claude Agent Skill packaging (already documented in root `README.md` §"Agent Skill"), not a separate Claude Code plugin marketplace package. Flagged for the user to confirm or correct.
6. **Push `v3-tool-surface-rewrite`** (currently at commit `69fb7c5`, plus this session's uncommitted Postgres + migration-script work).

---

# 7. Out of scope (unchanged from rev. 2)

- reopening the tool count or schemas
- per-chunk rows (one row per memory, one averaged vector, stays as-is)
- full-text / hybrid search, reranking
- an ongoing/live Qdrant↔Postgres sync (the two backends stay independent at runtime); a one-time, one-way copy script is in scope and done — see `skill/migrate-qdrant-to-pgvector.mjs`
- removing Qdrant, ever, per explicit backward-compatibility requirement
