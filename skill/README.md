# Memory Qdrant MCP Agent Skill

A Claude Agent Skill for persistent project memory backed by Qdrant or PostgreSQL/pgvector (`MEMORY_BACKEND`, one env var). It lets Claude carry context, decisions, progress and patterns across conversations.

## What is an Agent Skill?

Agent Skills are filesystem-based modules that extend Claude's capabilities. They use progressive disclosure: metadata is always available (low token cost), detailed instructions load when needed, and supporting files load on-demand.

Learn more: [Agent Skills Documentation](https://docs.anthropic.com/en/docs/agents-and-tools/agent-skills)

## Skill Structure

```
skill/
├── SKILL.md                          # Main skill (YAML frontmatter + instructions)
├── API-REFERENCE.md                  # Tool reference (7 tools)
├── MCP-CONFIG.md                     # Configuration guide
├── README.md                         # This file
├── migrate-qdrant-to-pgvector.mjs    # One-time Qdrant -> Postgres data copy
└── *.example.json                    # MCP server config templates
```

**Progressive Loading:**
- **Level 1**: SKILL.md metadata (always loaded)
- **Level 2**: SKILL.md instructions (loaded when triggered)
- **Level 3+**: Supporting files (loaded as referenced)

## Installation

### Claude Code

**Project-specific:**
```bash
mkdir -p .claude/skills/memory-qdrant-mcp
cp skill/* .claude/skills/memory-qdrant-mcp/
```

**Global (all projects):**
```bash
mkdir -p ~/.claude/skills/memory-qdrant-mcp
cp skill/* ~/.claude/skills/memory-qdrant-mcp/
```

Claude Code auto-discovers filesystem-based Skills.

### Claude.ai

1. Zip the skill directory:
   ```bash
   cd skill && zip -r ../memory-qdrant-mcp-skill.zip .
   ```
2. Settings → Features → Skills → upload the zip.

Skills are per-user, not organization-wide.

### Agent SDK

```bash
mkdir -p .claude/skills/memory-qdrant-mcp
cp skill/* .claude/skills/memory-qdrant-mcp/
```

The SDK auto-discovers `.claude/skills/`.

## MCP Server Configuration

The skill is the instructions; the tools come from the MCP server, configured separately.

**Example configuration files included:**
- `claude-config.example.json` - Claude Code / Claude Desktop
- `vscode-mcp-config.example.json` - VS Code
- `cursor-config.example.json` - Cursor

Minimum config - the server runs via `npx`, embeds locally with ONNX, and needs a reachable Qdrant (default) or Postgres (`MEMORY_BACKEND=postgres`):

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "memory-qdrant-mcp"],
      "env": { "QDRANT_URL": "http://localhost:6333" }
    }
  }
}
```

**See [MCP-CONFIG.md](MCP-CONFIG.md) for the full environment-variable reference**, including the Postgres settings.

### Migrating existing Qdrant data into Postgres

`migrate-qdrant-to-pgvector.mjs` in this directory is a one-time, one-way copy for switching an existing Qdrant deployment to `MEMORY_BACKEND=postgres` without losing history. It handles source vectors of any dimension - truncating and re-normalizing when wider than the target `VECTOR_DIM`, refusing rather than padding when narrower. Pass `--project <name>` for one collection or `--all` for every `memory_bank_*` collection on the server (non-`memory_bank_` collections, e.g. from an unrelated app sharing the same Qdrant instance, are left alone); in `--all` mode a collection narrower than `--vector-dim` is skipped and reported rather than aborting the run.

```bash
node skill/migrate-qdrant-to-pgvector.mjs --project my-app \
  --qdrant-url http://localhost:6333 \
  --postgres-url postgresql://postgres@localhost:5432/memory

node skill/migrate-qdrant-to-pgvector.mjs --all \
  --qdrant-url https://your-qdrant-host \
  --qdrant-api-key "$QDRANT_API_KEY" \
  --postgres-url postgresql://postgres@localhost:5432/memory
```

`--help` lists every flag, including `--dry-run`. For an HTTPS Qdrant URL with no explicit port, the script talks to 443; the underlying client otherwise defaults to Qdrant's local dev port 6333.

## Tools

Seven tools, all taking `project_name`:

| Tool | Purpose |
|------|---------|
| `memory_create` | Store entries (`items[]`) of a given memory type, with optional filterable `metadata` |
| `memory_read` | Run one or more queries (`queries[]`): semantic search (`query_text`) or list by recency |
| `memory_update` | Update entries by id (`items[]`), re-embedding when content changes |
| `memory_delete` | Permanently delete entries by id |
| `memory_context` | Read, and optionally patch, product context / active context / system patterns |
| `memory_graph` | `link` / `neighbors` / `unlink` - typed edges between entries and traversal over them |
| `memory_admin` | `export` / `import` / `summarize` |

The four CRUD tools take arrays, so a single write and a batch write are the same call.

`memory_type` is one of: `productContext`, `activeContext`, `systemPatterns`, `decisionLog`, `progress`, `contextHistory`, `customData`, `knowledgeLink`.

**See [SKILL.md](SKILL.md) for usage guidance and [API-REFERENCE.md](API-REFERENCE.md) for parameters and return shapes.**

## Common Workflows

### Session start
```json
{ "tool": "memory_context", "project_name": "my-app" }
```
Returns product context, active context and system patterns. Initializes the workspace if it is empty.

### Record a decision
```json
{ "tool": "memory_create", "project_name": "my-app",
  "items": [{ "memory_type": "decisionLog", "content": "Using PostgreSQL - already self-hosted, no new service" }] }
```

### Recall
```json
{ "tool": "memory_read", "project_name": "my-app", "queries": [{ "query_text": "which database", "limit": 3 }] }
```

### Link related memories
```json
{ "tool": "memory_graph", "project_name": "my-app", "op": "link",
  "edges": [{ "from_id": "3f2a...", "to_id": "9c11...", "relation": "caused_by" }] }
```

### Update the current focus
```json
{ "tool": "memory_context", "project_name": "my-app",
  "active_context": { "focus": "auth module", "next": ["token refresh"] } }
```

## Testing

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

Opens http://localhost:6274 for interactive tool testing.

## Best Practices

1. **Consistent project names.** Same `project_name` everywhere; it is case-sensitive and decides the collection.
2. **Search the symptom, not a summary.** `memory_read` matches on meaning - query the words you would actually type when hitting the problem.
3. **Use list mode for browsing.** Omitting `query_text` lists by recency and embeds nothing, so it costs no model time.
4. **Keep entries short and single-idea.** One decision or one pattern per entry; long blobs retrieve poorly.
5. **Write as things settle**, not batched at the end of a session.
6. **Patterns as `SYMPTOM -> CAUSE -> FIX`**, one line each, so a search on the symptom matches.

## Troubleshooting

### Skill not available

**Claude Code:** check `.claude/skills/memory-qdrant-mcp/SKILL.md` exists, the YAML frontmatter is valid, then restart.

**Claude.ai:** Settings → Features → Skills; each user uploads their own copy.

### MCP server connection errors

Verify the server entry in the client config, check `MEMORY_BACKEND` and the matching `QDRANT_URL`/`QDRANT_API_KEY` or `POSTGRES_URL`/`POSTGRES_PASSWORD`, and test with MCP Inspector. See [MCP-CONFIG.md](MCP-CONFIG.md).

### Memory not found

- `project_name` must match exactly (case-sensitive).
- Check the `memory_bank_<project_name>` collection exists (Qdrant) or the matching rows exist in `memory_collections`/`memory_points` (Postgres).
- On Qdrant, if `VECTOR_DIM` changed, the collection was recreated empty and the old entries are gone - see the warning in MCP-CONFIG.md. On Postgres a `VECTOR_DIM` mismatch throws instead and changes nothing.

## Security

⚠️ **Only use Skills from trusted sources.** Skills can execute code and invoke tools.

**Before using:**
- Review all markdown files (SKILL.md, API-REFERENCE.md, etc.)
- Check for unexpected external URLs or network calls
- Verify no sensitive data exposure

**API Keys:**
- Never commit keys to version control
- Use environment variables
- Rotate keys regularly

With the default `onnx` provider no API key is needed at all - embeddings run in-process and nothing leaves the machine except the backend writes.

## Documentation

- **[SKILL.md](SKILL.md)** - Usage instructions and workflows
- **[API-REFERENCE.md](API-REFERENCE.md)** - Tool reference (7 tools)
- **[MCP-CONFIG.md](MCP-CONFIG.md)** - Configuration guide

## Resources

- **GitHub**: [memory-qdrant-mcp](https://github.com/balaji-g42/memory-qdrant-mcp)
- **Agent Skills Docs**: https://docs.anthropic.com/en/docs/agents-and-tools/agent-skills
- **MCP Protocol**: https://modelcontextprotocol.io/
- **Qdrant**: https://qdrant.tech/
- **pgvector**: https://github.com/pgvector/pgvector

## License

MIT License

## Version

3.0.0
