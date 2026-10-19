# Privacy Policy

Project Agent Memory is an open-source MCP server and Claude Code plugin. It runs on your machine and has no hosted service of its own.

## What it collects

Nothing is sent to the author. The plugin has no telemetry, analytics, or tracking.

## Where your data goes

The plugin stores the memory entries, project context, and code-graph data that your agent writes. That data goes only to the services you configure:

- **Storage backend** - the Qdrant instance or PostgreSQL/pgvector (direct or via pREST) set in your environment. You choose and control it.
- **Embedding provider** - `onnx` (the default) runs locally and sends nothing out. If you set `EMBEDDING_PROVIDER` to `openai`, `gemini`, or `openrouter`, memory text is sent to that provider to create embeddings.
- **Summarizer provider** - if you configure one (for example OpenRouter), text you ask it to summarize is sent to that provider.

Those third-party providers handle data under their own privacy policies.

## Credentials

API keys and database credentials are read from your environment or config files. They are used only to call the services above and are never sent anywhere else.

## Deleting data

Your data lives in your storage backend. Delete it with the `memory_delete` / `memory_admin` tools or directly in Qdrant or PostgreSQL.

## Contact

Questions or issues: https://github.com/balaji-g42/project-agent-memory/issues
