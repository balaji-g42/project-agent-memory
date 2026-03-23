# Memory Qdrant MCP

A production-ready TypeScript MCP (Model Context Protocol) server that provides comprehensive memory management capabilities using Qdrant vector database for storing and retrieving project context, decisions, progress, and patterns.

## 🚀 Features

- **35 MCP Tools**: Full suite of memory and context management operations
- **TypeScript Implementation**: Type-safe codebase with latest MCP SDK
- **Multiple Embedding Providers**: OpenRouter, Gemini, Ollama, and FastEmbed support
- **Intelligent Fallbacks**: Automatic fallback to FastEmbed for embeddings, OpenRouter for summarization
- **OpenAI SDK Integration**: Standard OpenAI client for OpenRouter API access
- **Vector Search**: Semantic search through memory entries using embeddings
- **Performance Optimization**: Connection pooling, LRU caching, and cache invalidation
- **Comprehensive Testing**: Jest test suite with 35 tool tests
- **MCP Inspector Support**: Interactive testing and debugging
- **Import/Export**: Markdown-based memory bank management
- **Conversation Analysis**: Automatic logging of relevant information from conversations

## 📋 Requirements

- Node.js 18+
- TypeScript 5+
- Qdrant vector database (local or cloud)
- API keys for chosen providers (OpenRouter, Gemini, or Ollama)

## 📦 Installation

### Using npx (Recommended)

```bash
npx memory-qdrant-mcp
```

This will download and run the server automatically.

### Manual Installation

```bash
npm install -g memory-qdrant-mcp
memory-qdrant-mcp
```

### From Source

```bash
git clone <repository-url>
cd memory-qdrant-mcp
npm install
npm run build  # Compile TypeScript to dist/
node dist/index.js
```

## 🔧 Setup

### 1. Qdrant Database

The server requires a running Qdrant instance.

**Option 1: Simple Docker run**
```bash
docker run -p 6333:6333 qdrant/qdrant
```

**Option 2: Docker Compose (Recommended for production)**
Create a `docker-compose.yml` file:
```yaml
services:
  qdrant:
    image: qdrant/qdrant:latest
    container_name: qdrant
    restart: unless-stopped
    ports:
      - "6333:6333"
      - "6334:6334"
    environment:
      QDRANT__SERVICE__CORS: "true"
    volumes:
      - qdrant_data:/qdrant/storage

volumes:
  qdrant_data:
    driver: local
```

Then run:
```bash
docker-compose up -d
```

### 2. Environment Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

**Configure your `.env` file:**

```env
# Qdrant Configuration
QDRANT_URL=https://localhost:6333
QDRANT_API_KEY=your_qdrant_api_key_here
DEFAULT_TOP_K_MEMORY_QUERY=3

# Embedding Configuration
# Options: openrouter, gemini, ollama, fastembed (default)
EMBEDDING_PROVIDER=openrouter
EMBEDDING_MODEL=qwen/qwen3-embedding-8b

# Summarizer Configuration
# Options: openrouter (default), gemini, ollama
SUMMARIZER_PROVIDER=openrouter
SUMMARIZER_MODEL=openai/gpt-oss-20b:free

# Provider API Keys
OPENROUTER_API_KEY=your_openrouter_key_here
GEMINI_API_KEY=your_gemini_key_here
OLLAMA_API_URL=http://localhost:11434
OLLAMA_API_KEY=
```

### Provider Selection

**OpenRouter (Recommended)**
- Best for embeddings: `qwen/qwen3-embedding-8b`
- Best for summarization: `openai/gpt-oss-20b:free`
- Requires API key from [openrouter.ai](https://openrouter.ai)
- Uses OpenAI SDK with proper headers

**Gemini**
- Good for both embeddings and summarization
- Free tier available
- Get API key from [Google AI Studio](https://makersuite.google.com/app/apikey)

**Ollama**
- Local, free, privacy-focused
- Requires Ollama running locally
- Supports cloud Ollama with API key
- Models: `nomic-embed-text:v1.5` (embedding), `llama2` (summarization)

**FastEmbed (Fallback)**
- Local embeddings
- No API key required
- Used as automatic fallback when other providers fail

## 🔌 MCP Configuration

### For VSCode GitHub Copilot

Create or update the MCP settings file at:
- **Windows**: `%APPDATA%\Code\User\globalStorage\github.copilot-chat\settings\mcp.json`
- **macOS**: `~/Library/Application Support/Code/User/globalStorage/github.copilot-chat/settings/mcp.json`
- **Linux**: `~/.config/Code/User/globalStorage/github.copilot-chat/settings/mcp.json`

Add the following configuration:

```json
{
  "mcpServers": {
    "memory-qdrant-mcp": {
      "command": "npx",
      "args": ["memory-qdrant-mcp"],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "EMBEDDING_PROVIDER": "openrouter",
        "EMBEDDING_MODEL": "qwen/qwen3-embedding-8b",
        "SUMMARIZER_PROVIDER": "openrouter",
        "SUMMARIZER_MODEL": "openai/gpt-oss-20b:free",
        "OPENROUTER_API_KEY": "your_openrouter_api_key_here",
        "GEMINI_API_KEY": "your_gemini_api_key_here",
        "DEFAULT_TOP_K_MEMORY_QUERY": "3"
      }
    }
  }
}
```

### For Roo

Add to your Roo MCP settings:

```json
{
  "mcpServers": {
    "memory-qdrant-mcp": {
      "command": "npx",
      "args": ["memory-qdrant-mcp"],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "EMBEDDING_PROVIDER": "openrouter",
        "OPENROUTER_API_KEY": "your_openrouter_api_key_here"
      }
    }
  }
}
```

## 🎯 Agent Skill

A complete **Claude Agent Skill** is available in the [`skill/`](skill/) directory. This allows Claude to automatically use this MCP server's memory management capabilities when relevant.

**What's included:**
- ✅ Complete SKILL.md with YAML frontmatter and progressive disclosure architecture
- ✅ Comprehensive API reference for all 35 tools  
- ✅ Configuration guides for multiple platforms
- ✅ Example workflows and best practices
- ✅ MCP server configuration templates

**Installation:**
- **Claude.ai**: Zip and upload via Settings → Features → Skills
- **Claude Code**: Copy to `.claude/skills/memory-qdrant-mcp/`
- **Claude API**: Upload via Skills API endpoint
- **Agent SDK**: Copy to `.claude/skills/` directory

See [`skill/README.md`](skill/README.md) for detailed installation and usage instructions.

## 🛠️ Available Tools (35 total)

### Core Memory Operations (3 tools)

#### log_memory
Store a memory entry to the vector database.
- `type`: Memory type (productContext, activeContext, systemPatterns, decisionLog, progress, customData)
- `content`: Content to store
- `project`: Project name
- `topLevelId` (optional): Hierarchical identifier

#### query_memory
Query memory entries with semantic search.
- `query`: Search query text
- `type` (optional): Filter by memory type
- `top_k` (optional): Number of results (default: 3)

#### query_memory_summarized
Query memory with automatic summarization of results.
- `query`: Search query text
- `type` (optional): Filter by memory type
- `top_k` (optional): Number of results
- `summarize` (optional): Enable summarization

### Decision Logging (3 tools)

#### log_decision
Log architectural or project decisions.
- `decision`: Decision text
- `reasoning`: Rationale behind the decision
- `alternatives`: Considered alternatives
- `impact`: Expected impact
- `project`: Project name

#### get_decisions
Retrieve decision history.
- `project`: Project name
- `limit` (optional): Number of decisions to retrieve

#### search_decisions_fts
Full-text search through decisions.
- `searchText`: Search query
- `project`: Project name
- `limit` (optional): Number of results

### Progress Tracking (4 tools)

#### log_progress
Log project milestone or progress.
- `milestone`: Milestone description
- `details`: Detailed information
- `project`: Project name

#### get_progress_with_status
Retrieve progress entries by status.
- `project`: Project name
- `status`: Progress status (pending, in_progress, completed)

#### update_progress_with_status
Update progress entry status.
- `progressId`: Progress entry ID
- `status`: New status
- `details` (optional): Updated details

#### search_progress_entries
Search progress entries with filters.
- `searchText`: Search query
- `project`: Project name
- `status` (optional): Filter by status

### Context Management (5 tools)

#### get_product_context
Retrieve product context for a project.
- `project`: Project name

#### update_product_context
Update product context information.
- `context`: New context content
- `project`: Project name

#### get_active_context
Get current active working context.
- `project`: Project name

#### update_active_context
Update active working context.
- `context`: New context content
- `project`: Project name

#### get_context_history
Retrieve context change history.
- `project`: Project name
- `limit` (optional): Number of history entries

### System Patterns (3 tools)

#### get_system_patterns
Retrieve system design patterns.
- `project`: Project name

#### update_system_patterns
Update system patterns.
- `patterns`: Pattern descriptions
- `project`: Project name

#### search_system_patterns
Search through system patterns.
- `searchText`: Search query
- `project`: Project name
- `limit` (optional): Number of results

### Knowledge Links (2 tools)

#### create_knowledge_link
Create relationship between memory entries.
- `sourceId`: Source memory ID
- `targetId`: Target memory ID
- `linkType`: Type of relationship
- `description`: Link description

#### get_knowledge_links
Retrieve knowledge links for a memory.
- `memoryId`: Memory entry ID
- `linkType` (optional): Filter by link type

### Search & Analysis (2 tools)

#### semantic_search
Perform semantic search across all memories.
- `query`: Search query
- `project`: Project name
- `top_k` (optional): Number of results

#### summarize_text
Summarize any text content.
- `text`: Text to summarize

### Custom Data (5 tools)

#### store_custom_data
Store custom key-value data.
- `key`: Data key
- `value`: Data value (any JSON type)
- `tags` (optional): Tags for categorization
- `project`: Project name

#### get_custom_data
Retrieve custom data by key.
- `key`: Data key
- `project`: Project name

#### query_custom_data
Query custom data with semantic search.
- `query`: Search query
- `project`: Project name
- `top_k` (optional): Number of results

#### search_custom_data
Full-text search in custom data.
- `searchText`: Search query
- `project`: Project name
- `tags` (optional): Filter by tags

#### update_custom_data
Update existing custom data.
- `key`: Data key
- `value`: New value
- `project`: Project name

### Batch Operations (3 tools)

#### batch_log_memory
Log multiple memory entries at once.
- `entries`: Array of memory entries

#### batch_query_memory
Query multiple terms simultaneously.
- `queries`: Array of query strings
- `type` (optional): Memory type filter
- `top_k` (optional): Results per query

#### batch_update_context
Update multiple context types at once.
- `updates`: Object with context updates
- `project`: Project name

### Workspace Management (2 tools)

#### initialize_workspace
Initialize a new project workspace.
- `project`: Project name
- `description`: Project description

#### sync_memory
Synchronize memory with current state.
- `project`: Project name
- `direction`: 'push' or 'pull'

### Import/Export (2 tools)

#### export_memory_to_markdown
Export memories to markdown files.
- `project`: Project name
- `outputPath`: Export directory path

#### import_memory_from_markdown
Import memories from markdown files.
- `markdownPath`: Import directory path
- `project`: Project name

### Conversation Analysis (1 tool)

#### analyze_conversation
Analyze conversation and extract insights.
- `messages`: Array of conversation messages
- `project`: Project name

## 🧪 Testing

### Run Test Suite

The project includes comprehensive Jest tests for all 35 MCP tools:

```bash
npm test
```

### Test Coverage

```bash
npm test -- --coverage
```

### MCP Inspector (Interactive Testing)

Test all tools interactively with MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

This opens a web interface at `http://localhost:6274` where you can:
- View all 35 registered tools
- Test individual tools with custom parameters
- Inspect request/response JSON-RPC messages
- Verify error handling and fallback mechanisms

### Test Results

All 35 tools are tested including:
- Core memory operations
- Decision logging and retrieval
- Progress tracking with status management
- Context management (product, active, history)
- System patterns
- Knowledge link creation
- Semantic search
- Text summarization (with provider fallbacks)
- Custom data CRUD operations
- Batch operations
- Workspace management
- Import/Export markdown functionality
- Conversation analysis

## 🏗️ Development

### Project Structure

```
memory-qdrant-mcp/
├── src/                      # TypeScript source files
│   ├── index.ts              # Main MCP server entry point
│   ├── types.ts              # TypeScript type definitions
│   ├── config.ts             # Configuration management
│   ├── cache.ts              # LRU caching implementation
│   ├── embeddings.ts         # Embedding provider factory
│   ├── embeddings/           # Embedding providers
│   │   ├── providerBase.ts   # Abstract base class
│   │   ├── openrouter.ts     # OpenRouter (OpenAI SDK)
│   │   ├── geminiVertex.ts   # Google Gemini
│   │   ├── ollama.ts         # Ollama (local/cloud)
│   │   └── fastEmbed.ts      # FastEmbed (fallback)
│   └── mcp_tools/            # MCP tool implementations
│       ├── memoryBankTools.ts  # 39 core functions
│       ├── contextTools.ts     # Context operations
│       ├── store.ts            # Decision & progress logging
│       ├── search.ts           # Search operations
│       └── summarizer.ts       # Text summarization
├── dist/                     # Compiled JavaScript (generated)
├── tests/                    # Test files
│   ├── all-tools.test.ts     # Comprehensive test suite
│   └── README.md             # Testing documentation
├── tests_backup_js/          # Archived JavaScript tests
├── server_backup_js/         # Archived JavaScript source
├── package.json              # Dependencies & scripts
├── tsconfig.json             # TypeScript configuration
├── jest.config.js            # Jest test configuration
└── README.md                 # This file
```

### Build

Compile TypeScript to JavaScript:

```bash
npm run build
```

### Development Mode

Watch for changes and recompile automatically:

```bash
npm run dev
```

### Adding New Tools

1. Implement the tool function in `src/mcp_tools/`
2. Register it in `src/index.ts` using `server.registerTool()`
3. Define Zod schema for parameter validation
4. Add test case in `tests/all-tools.test.ts`
5. Update this README

### Architecture Highlights

**TypeScript & Type Safety**
- Full TypeScript implementation with strict type checking
- Zod schemas for runtime parameter validation
- Type-safe MCP SDK integration

**Logging**
- All logs output to `stderr` for production visibility
- Logs don't interfere with MCP protocol on `stdout`
- Structured error logging with context

**Fallback Mechanisms**
- Embeddings: Primary provider → FastEmbed (local, no API needed)
- Summarization: Primary provider → OpenRouter → Original text
- Graceful degradation ensures service availability

**Performance Optimizations**
- Connection pooling for Qdrant client
- LRU caching for embeddings and query results
- Automatic cache invalidation on data updates
- Configurable cache sizes and TTL

## 🚀 Publishing to npm

To publish your own version:

1. Update `package.json` with your information:
   ```json
   {
     "name": "your-package-name",
     "version": "2.0.0",
     "author": "Your Name",
     "repository": "https://github.com/yourname/your-repo",
     "homepage": "https://github.com/yourname/your-repo"
   }
   ```

2. Build the project:
   ```bash
   npm run build
   ```

3. Login to npm:
   ```bash
   npm login
   ```

4. Publish:
   ```bash
   npm publish
   ```

5. Users can then install and run:
   ```bash
   npx your-package-name
   ```

## 📝 License

MIT

## 🤝 Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure `npm test` passes
5. Submit a pull request

## 📚 Resources

- [Model Context Protocol Documentation](https://modelcontextprotocol.io)
- [Qdrant Vector Database](https://qdrant.tech)
- [OpenRouter API](https://openrouter.ai)
- [Google Gemini API](https://ai.google.dev)
- [Ollama](https://ollama.ai)
