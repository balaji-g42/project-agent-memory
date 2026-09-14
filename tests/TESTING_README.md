# Testing

`tests/all-tools.test.ts` is a Jest suite that drives the built server over stdio via the MCP SDK client and exercises all 7 v3 tools against a real backend (Qdrant or Postgres — whichever `MEMORY_BACKEND` selects). There are no mocks; every test is a real round trip through the server.

All rows are written under project name `project-agent-memory-test` (plus `project-agent-memory-test-isolation` for the isolation check), so a run never touches production data. Nothing deletes these test collections afterward — drop them manually if you want a clean slate (`memory_bank_project-agent-memory-test*` in Qdrant, or the matching rows in Postgres' `memory_points`/`memory_collections`).

## Running

```bash
npm run build
npm test
```

`npm test` runs Jest, which spawns `dist/index.js`, so a build must exist first. The suite reads the same `.env` the server would (via the server's own `dotenv/config`), with `VECTOR_DIM`, `EMBEDDING_PROVIDER`, and `EMBEDDING_MODEL` pinned in `tests/all-tools.test.ts` to `768` / `onnx` / `nomic-ai/nomic-embed-text-v1.5` so results are deterministic regardless of local `.env` overrides.

### Against Qdrant (default)

Set `QDRANT_URL` (and `QDRANT_API_KEY` if needed) in `.env`, `MEMORY_BACKEND=qdrant` or unset, then `npm test`.

### Against Postgres/pgvector

Set `MEMORY_BACKEND=postgres` and `POSTGRES_URL`/`POSTGRES_PASSWORD` in `.env`, then `npm test`. Schema is created automatically on first connect.

To run both in one session, edit `.env` between runs (or export the vars inline before `npm test`) — there's no dual-backend test runner, since the point is to verify the two backends behave identically under one shared suite.

## What is covered

- `tools/list` — exact 7-tool surface, no leftover v2 names.
- `memory_create` — single item, batch order preservation, explicit-id idempotency and update-by-external-id, rejection of an unknown `memory_type`.
- `memory_read` — semantic search (relevance + score range), `memory_type` filter, `limit`, list mode (no `query_text`, recency order), batched queries, `metadata_filter` on a scalar and on an array (any-match).
- `memory_update` — content replacement (re-embeds), metadata shallow merge (preserves untouched keys), batch update.
- `memory_context` — initial shape, patch-and-read-back in one call, second patch merges shallowly over the first, previous version written to `contextHistory`.
- `memory_graph` — `link` creates edges, `neighbors` at depth 1 vs depth 2, `direction: incoming` restricts traversal, `unlink` removes edges without deleting nodes.
- `memory_admin` — `export` produces markdown, `export → import → export` round-trips without data loss, importing foreign (non-exported) markdown reports errors instead of throwing.
- Project isolation — a second project name never sees another project's rows.
- `memory_delete` — deleting an unknown id is a no-op, deleting a real id removes it from subsequent reads.

This mirrors the 30-check manual stdio driver used during v3 development (`scratchpad/run-tools.mjs`, not part of the repo) — that driver was the spec this suite was ported from.

## Notes

- Tests run sequentially within each `describe` block and share state (ids created by earlier tests are read by later ones), matching how the tools are actually used. Don't run individual `it()`s out of order with `.only` unless you also stub the state they depend on.
