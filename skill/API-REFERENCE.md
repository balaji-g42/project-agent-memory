# API Reference

Seven tools. Every tool takes `project_name` (string, case-sensitive, required).

`memory_type` is one of: `productContext`, `activeContext`, `systemPatterns`, `decisionLog`, `progress`, `contextHistory`, `customData`, `knowledgeLink`.

The four CRUD tools take arrays, so a single write and a batch write use the same call shape.

---

## memory_create

Store one or more memory entries.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `project_name` | string | yes | - | Project name |
| `items` | object[] | yes | - | At least one entry |
| `items[].memory_type` | enum | yes | - | One of the eight memory types |
| `items[].content` | string | yes | - | Content to store |
| `items[].id` | string | no | generated | Explicit point id; overwrites an existing entry |
| `items[].metadata` | object | no | `{}` | Filterable fields, e.g. `{ "status": "in_progress" }` |

Returns an array of `{ "id": string, "type": string }`, one per item, in order.

Each content is embedded and stored as a single point with payload `{ type, content, metadata, timestamp, project }`. Long content is chunked and the chunk embeddings are averaged; the payload keeps the full original text.

---

## memory_read

Retrieve entries. Each query has two modes.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `project_name` | string | yes | - | Project name |
| `queries` | object[] | yes | - | At least one query |
| `queries[].query_text` | string | no | - | Present: semantic search. Absent: list by recency |
| `queries[].memory_type` | enum | no | all types | Restrict to one type |
| `queries[].metadata_filter` | object | no | - | Equality filter on `metadata`; an array value matches any element |
| `queries[].limit` | number | no | 5 | Maximum entries |

One query returns an array of `{ id, score, content, type, timestamp, metadata }`. Several queries return one such array per query, in order.

`score` is the cosine similarity in search mode and `0` in list mode. List mode does not embed anything, so it costs no model time.

Search results are cached per `(project, query, type, limit, metadata_filter)` and invalidated by any write to that project.

---

## memory_update

Update entries by id. Supplying `content` re-embeds the entry; omitting it keeps the stored vector. `metadata` is shallow-merged into what is already stored. All other payload fields are preserved and `timestamp` is refreshed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_name` | string | yes | Project name |
| `items` | object[] | yes | At least one entry |
| `items[].id` | string | yes | Id of the entry to update |
| `items[].content` | string | no | New content |
| `items[].metadata` | object | no | Metadata fields to merge in |

Returns an array of `{ "id": string, "updated": true }`. Throws if an id does not exist in that project's collection.

---

## memory_delete

Permanently delete entries by id. No undo.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_name` | string | yes | Project name |
| `ids` | string[] | yes | At least one id |

Returns `{ "deleted": number }` - the count of ids that existed and were removed. Unknown ids are ignored rather than raising.

---

## memory_context

Read, and optionally patch, the project's working context.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `project_name` | string | yes | - | Project name |
| `product_context` | object | no | - | Patch merged into product context |
| `active_context` | object | no | - | Patch merged into active context |
| `pattern_limit` | number | no | 20 | Maximum system patterns returned |

Returns:

```json
{
  "productContext": { },
  "activeContext": { },
  "systemPatterns": [ { "id": "...", "content": "...", "timestamp": "..." } ]
}
```

Patches are shallow-merged into the existing object; previous versions are written to `contextHistory`. Reads happen after writes, so a single call can patch and return the updated state.

If product context is empty on read, the workspace is initialized automatically - there is no separate init tool.

---

## memory_graph

Typed edges between entries, and traversal over them.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `project_name` | string | yes | - | Project name |
| `op` | enum | yes | - | `link`, `neighbors` or `unlink` |
| `edges` | object[] | `op=link` | - | `{ from_id, to_id, relation, description? }` |
| `id` | string | `op=neighbors` | - | Entry to start from |
| `relation` | string | no | all | `op=neighbors`: restrict traversal to one relation |
| `depth` | number | no | 1 | `op=neighbors`: hops to walk |
| `direction` | enum | no | `both` | `op=neighbors`: `outgoing`, `incoming` or `both` |
| `link_ids` | string[] | `op=unlink` | - | Edge ids to delete |

`link` returns the created edges as `{ id, sourceId, targetId, linkType, description, timestamp }`.

`neighbors` returns `{ "neighbors": [{ id, depth, via, content, type }], "edges": [ ... ] }` - the reached entries ordered by hop distance, plus the edges touching the starting entry.

`unlink` returns `{ "deleted": number }`.

Edges are stored in the same collection as ordinary points with `type = "knowledgeLink"`; the edge's own id is what `unlink` takes. Do not create them with `memory_create`.

---

## memory_admin

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_name` | string | yes | Project name |
| `op` | enum | yes | `export`, `import`, `summarize` or `delete_collection` |
| `memory_types` | enum[] | no | `op=export`: types to include; defaults to the structured contexts, decisions and progress |
| `markdown` | string | `op=import` | Markdown in this server's own export format |
| `content` | string | `op=summarize` | Text to condense |

`export` returns the memory bank as a markdown string. `import` returns `{ imported, errors, timestamp }` and only accepts the format `export` produces. `summarize` returns the condensed text and uses the configured `SUMMARIZER_PROVIDER`, so it needs that provider's API key. `delete_collection` permanently deletes the entire memory bank (collection and all points) for `project_name` and returns `{ deleted: true }` - irreversible, no other params.

---

## Collection behaviour

The collection `memory_bank_<project_name>` is created on first use with `size = VECTOR_DIM` and the configured distance metric, and seeded with one placeholder point per memory type.

On every call, if the existing collection's vector size does not match `VECTOR_DIM`, the server logs a warning to stderr, **deletes the collection**, and recreates it at the new size. Stored memories in that collection are lost. Set `VECTOR_DIM` back to the size named in the warning if you want to keep them.

---

## Errors

Errors propagate as MCP tool errors with the underlying message. There are no silent fallbacks: an unreachable embedding provider, a missing API key, or a dimension the model cannot produce all fail loudly rather than returning degraded vectors.
