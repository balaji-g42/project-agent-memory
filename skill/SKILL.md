---
name: project-agent-memory
description: Persistent project memory backed by Qdrant or PostgreSQL/pgvector, selected with one environment variable. Use this when you need to store or recall context, decisions, progress, or patterns across conversations. Provides 7 tools - memory_create, memory_read, memory_update, memory_delete, memory_context, memory_graph, memory_admin. Use when the user asks to remember something, recall past decisions, track progress, link related memories, or search project history.
---

# Project Agent Memory

Persistent, semantically searchable project memory. Seven tools, one collection per project (`memory_bank_<project_name>`).

## project_name

Every call takes `project_name`. Derive it from the workspace: `package.json` `name`, `pyproject.toml` `[project].name`, `setup.py` `name=`, else the workspace folder name. It is case-sensitive - use the identical string for every call.

## Memory types

Exactly these eight values are valid for `memory_type`:

| Type | Use for |
|------|---------|
| `productContext` | What the project is: purpose, stack, architecture |
| `activeContext` | Current focus, next steps, open threads |
| `systemPatterns` | Reusable rules, one line each: `SYMPTOM -> CAUSE -> FIX` |
| `decisionLog` | A choice plus its rationale |
| `progress` | Completed or blocked work, with commit/build ids |
| `contextHistory` | Prior snapshots of product/active context |
| `customData` | Verbatim documents and blobs |
| `knowledgeLink` | Graph edges written by `memory_graph`; do not create these directly |

## The seven tools

The four CRUD tools take arrays, so one write and a batch write are the same call - send one element or many.

### memory_context

Session start, and whenever focus changes. Returns product context, active context and system patterns in one call. Creates and seeds the collection on first use.

```json
{ "project_name": "my-app" }
```

Patch context by passing objects; the patch is merged, not replaced:

```json
{
  "project_name": "my-app",
  "active_context": { "focus": "payment retries", "next_steps": ["add idempotency key"] }
}
```

### memory_create

```json
{
  "project_name": "my-app",
  "items": [
    { "memory_type": "decisionLog", "content": "Use JWT over sessions - stateless, survives horizontal scaling." }
  ]
}
```

Returns `[{ "id": "...", "type": "decisionLog" }]`. Pass `id` on an item to overwrite a known entry instead of creating one. Use `metadata` for anything you will later want to filter on:

```json
{
  "project_name": "my-app",
  "items": [
    { "memory_type": "progress", "content": "Retry backoff shipped in a1b2c3d.", "metadata": { "status": "completed" } },
    { "memory_type": "customData", "content": "...", "metadata": { "dataType": "apiSpec" } }
  ]
}
```

### memory_read

With `query_text` a query runs semantic search. Without it, it lists the most recent entries.

```json
{ "project_name": "my-app", "queries": [{ "query_text": "why JWT", "memory_type": "decisionLog", "limit": 5 }] }
```

```json
{ "project_name": "my-app", "queries": [{ "memory_type": "progress", "metadata_filter": { "status": ["pending", "blocked"] }, "limit": 10 }] }
```

Several queries in one call return one result array each. An array in `metadata_filter` matches any of its elements.

Search the symptom in the words you would actually type, not a tidy summary.

### memory_update

Re-embeds when `content` is supplied; omit it to change only `metadata`, which is merged rather than replaced.

```json
{
  "project_name": "my-app",
  "items": [
    { "id": "3f2a...", "content": "Superseded: moved to opaque tokens behind a gateway." },
    { "id": "9c11...", "metadata": { "status": "completed" } }
  ]
}
```

### memory_delete

Permanent, no undo.

```json
{ "project_name": "my-app", "ids": ["3f2a...", "9c11..."] }
```

### memory_graph

Relate entries to each other and walk those relations. Use it when the connection matters and semantic similarity would not find it - a bug caused by a decision, a pattern that supersedes another.

```json
{
  "project_name": "my-app",
  "op": "link",
  "edges": [{ "from_id": "3f2a...", "to_id": "9c11...", "relation": "superseded_by" }]
}
```

```json
{ "project_name": "my-app", "op": "neighbors", "id": "3f2a...", "depth": 2 }
```

`neighbors` returns `{ neighbors: [{ id, depth, via, content, type }], edges }`. `op: "unlink"` with `link_ids` removes edges.

### memory_admin

```json
{ "project_name": "my-app", "op": "export" }
```

`export` dumps the bank as markdown, `import` (with `markdown`) reads that same format back, `summarize` (with `content`) condenses a long text before you store it, `delete_collection` permanently deletes the whole memory bank for a project.

## Working pattern

1. Session start: `memory_context`.
2. Before writing code that touched a past problem: `memory_read` with the symptom.
3. As things settle, not batched at the end: `memory_create` the decision, progress line or pattern.
4. Focus changed: `memory_context` with `active_context`.

Keep writes small - one idea per entry. A progress entry is at most five lines: commit id, scope, verification, push status, what is still open. Incident detail belongs in a `systemPatterns` entry, not in progress.

## Configuration

Embeddings run in-process on ONNX by default - no external embedding service needed. See `MCP-CONFIG.md` for the environment variables, including `MEMORY_BACKEND` (`qdrant` default, or `postgres` - which talks to Postgres through pREST, needing `PREST_URL`/`PREST_JWT_KEY`), `VECTOR_DIM` (default 768), `EMBEDDING_PROVIDER`, and how to point the OpenAI-compatible provider at Ollama, LM Studio or vLLM.

Changing `VECTOR_DIM` against an existing Qdrant collection recreates that collection and destroys its stored memories; the server warns on stderr when it does this. On Postgres the vector column width is fixed at schema creation, so a mismatch instead throws and changes nothing.

Have existing data in Qdrant and want to move it into Postgres once? Run `migrate-qdrant-to-pgvector.mjs` in this directory (needs `--prest-url`/`--prest-jwt-key` or `$PREST_URL`/`$PREST_JWT_KEY` - the script writes through pREST, the same as the server does) - a one-time, one-way copy that handles source vectors of any dimension (truncate + re-normalize if wider than the target `VECTOR_DIM`, refuse rather than pad if narrower). `--project <name>` migrates one collection, `--all` migrates every `memory_bank_*` collection on the server (skipping, not aborting on, any that are narrower than the target). `node skill/migrate-qdrant-to-pgvector.mjs --help` for flags.

## Migrating from v2.x

The 35 v2 tools are condensed into 7. Mapping:

| Old | New |
|-----|-----|
| `log_memory`, `log_decision`, `log_progress`, `update_system_patterns`, `store_custom_data`, `batch_log_memory` | `memory_create` |
| `query_memory`, `semantic_search`, `get_decisions`, `search_decisions_fts`, `get_system_patterns`, `search_system_patterns`, `get_progress_with_status`, `search_progress_entries`, `get_custom_data`, `query_custom_data`, `search_custom_data`, `get_context_history`, `batch_query_memory`, `query_memory_summarized` | `memory_read` |
| `update_custom_data`, `update_progress_with_status` | `memory_update` |
| (none - deletion was not exposed) | `memory_delete` |
| `get_product_context`, `update_product_context`, `get_active_context`, `update_active_context`, `initialize_workspace`, `batch_update_context` | `memory_context` |
| `create_knowledge_link`, `get_knowledge_links` | `memory_graph` (plus `neighbors`, which v2 had no equivalent for) |
| `summarize_text`, `export_memory_to_markdown`, `import_memory_from_markdown` | `memory_admin` |
| `sync_memory`, `analyze_conversation` | removed |
