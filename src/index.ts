#!/usr/bin/env node

import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import {
    logMemory,
    queryMemory,
    listMemory,
    updateMemory,
    deleteMemory,
    getStructuredContext,
    updateStructuredContext,
    getSystemPatterns,
    initializeWorkspace,
    createKnowledgeLink,
    getKnowledgeLinks,
    getNeighbors,
    deleteKnowledgeLinks,
    exportMemoryToMarkdown,
    importMemoryFromMarkdown
} from "./mcp_tools/memoryBankTools.js";
import { summarizeText } from "./mcp_tools/summarizer.js";

process.on("unhandledRejection", (reason) => {
    console.error("UnhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
    console.error("UncaughtException:", err);
    process.exit(1);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf-8")
);

const MEMORY_TYPES = [
    "productContext",
    "activeContext",
    "systemPatterns",
    "decisionLog",
    "progress",
    "contextHistory",
    "customData",
    "knowledgeLink"
] as const;

const memoryTypeSchema = z.enum(MEMORY_TYPES);

const server = new McpServer({
    name: "memory-qdrant-mcp",
    version: packageJson.version,
});

function text(payload: unknown) {
    return {
        content: [{
            type: "text" as const,
            text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)
        }]
    };
}

server.registerTool('memory_create', {
    description: "Store one or more memory entries in a single call. Use memory_type to classify each: decisionLog for a choice plus rationale, progress for completed or blocked work, systemPatterns for a reusable rule, productContext/activeContext for project state, customData for verbatim documents. Use metadata for filterable fields such as status, priority or dataType.",
    inputSchema: z.object({
        project_name: z.string().describe("Project name, case-sensitive"),
        items: z.array(z.object({
            memory_type: memoryTypeSchema.describe("Memory type"),
            content: z.string().describe("Content to store"),
            id: z.string().optional().describe("Optional explicit id; overwrites an existing entry"),
            metadata: z.record(z.any()).optional().describe("Filterable fields, e.g. { status: \"in_progress\", priority: \"high\" }")
        })).min(1).describe("One entry for a single write, many for a batch")
    })
}, async (params) => {
    const ids = await Promise.all(params.items.map(item =>
        logMemory(params.project_name, item.memory_type, item.content, item.id ?? null, item.metadata ?? {})
    ));
    return text(ids.map((id, i) => ({ id, type: params.items[i].memory_type })));
});

server.registerTool('memory_read', {
    description: "Retrieve memory entries. Each query with query_text runs semantic search; without it, lists the most recent entries of the given type. metadata_filter narrows on fields stored via memory_create, with an array value matching any of its elements.",
    inputSchema: z.object({
        project_name: z.string().describe("Project name, case-sensitive"),
        queries: z.array(z.object({
            query_text: z.string().optional().describe("Search text; omit to list by recency"),
            memory_type: memoryTypeSchema.optional().describe("Restrict to one memory type"),
            metadata_filter: z.record(z.any()).optional().describe("Metadata equality filter, e.g. { status: [\"pending\", \"blocked\"] }"),
            limit: z.number().optional().default(5).describe("Maximum entries to return")
        })).min(1).describe("One query for a single read, many for a batch")
    })
}, async (params) => {
    const results = await Promise.all(params.queries.map(q =>
        q.query_text
            ? queryMemory(params.project_name, q.query_text, q.memory_type ?? null, q.limit, q.metadata_filter ?? null)
            : listMemory(params.project_name, q.memory_type ?? null, q.limit, q.metadata_filter ?? null)
    ));
    return text(results.length === 1 ? results[0] : results);
});

server.registerTool('memory_update', {
    description: "Update existing memory entries by id. Content is re-embedded when supplied; metadata is shallow-merged into what is already stored.",
    inputSchema: z.object({
        project_name: z.string().describe("Project name, case-sensitive"),
        items: z.array(z.object({
            id: z.string().describe("Id of the entry to update"),
            content: z.string().optional().describe("New content; omit to keep the existing content and vector"),
            metadata: z.record(z.any()).optional().describe("Metadata fields to merge in")
        })).min(1).describe("One entry for a single update, many for a batch")
    })
}, async (params) => {
    await Promise.all(params.items.map(item =>
        updateMemory(params.project_name, item.id, item.content, item.metadata)
    ));
    return text(params.items.map(item => ({ id: item.id, updated: true })));
});

server.registerTool('memory_delete', {
    description: "Permanently delete memory entries by id.",
    inputSchema: z.object({
        project_name: z.string().describe("Project name, case-sensitive"),
        ids: z.array(z.string()).min(1).describe("Ids of entries to delete")
    })
}, async (params) => {
    const deleted = await deleteMemory(params.project_name, params.ids);
    return text({ deleted });
});

server.registerTool('memory_context', {
    description: "Load or update the project's working context: product context, active context and system patterns. Call at session start with no update fields; pass product_context or active_context to patch them.",
    inputSchema: z.object({
        project_name: z.string().describe("Project name, case-sensitive"),
        product_context: z.record(z.any()).optional().describe("Patch to merge into product context"),
        active_context: z.record(z.any()).optional().describe("Patch to merge into active context"),
        pattern_limit: z.number().optional().default(20).describe("Maximum system patterns to return")
    })
}, async (params) => {
    if (params.product_context) {
        await updateStructuredContext(params.project_name, "productContext", params.product_context);
    }
    if (params.active_context) {
        await updateStructuredContext(params.project_name, "activeContext", params.active_context);
    }

    const productContext = await getStructuredContext(params.project_name, "productContext");
    if (Object.keys(productContext).length === 0) {
        await initializeWorkspace(params.project_name);
    }

    const [product, active, patterns] = await Promise.all([
        getStructuredContext(params.project_name, "productContext"),
        getStructuredContext(params.project_name, "activeContext"),
        getSystemPatterns(params.project_name, params.pattern_limit)
    ]);

    return text({ productContext: product, activeContext: active, systemPatterns: patterns });
});

server.registerTool('memory_graph', {
    description: "Knowledge graph over memory entries. op=link creates typed edges between entries, op=neighbors walks the graph outwards from an entry up to the given depth, op=unlink deletes edges by their own ids.",
    inputSchema: z.object({
        project_name: z.string().describe("Project name, case-sensitive"),
        op: z.enum(["link", "neighbors", "unlink"]).describe("Graph operation"),
        edges: z.array(z.object({
            from_id: z.string().describe("Source memory id"),
            to_id: z.string().describe("Target memory id"),
            relation: z.string().describe("Relation name, e.g. \"caused_by\", \"supersedes\""),
            description: z.string().optional().describe("Human-readable edge label")
        })).optional().describe("op=link: edges to create"),
        id: z.string().optional().describe("op=neighbors: entry to start from"),
        relation: z.string().optional().describe("op=neighbors: restrict traversal to one relation"),
        depth: z.number().optional().default(1).describe("op=neighbors: how many hops to walk"),
        direction: z.enum(["outgoing", "incoming", "both"]).optional().default("both").describe("op=neighbors: edge direction to follow"),
        link_ids: z.array(z.string()).optional().describe("op=unlink: edge ids to delete")
    })
}, async (params) => {
    if (params.op === "link") {
        if (!params.edges?.length) throw new Error("op=link requires edges");
        return text(await createKnowledgeLink(params.project_name, params.edges));
    }
    if (params.op === "neighbors") {
        if (!params.id) throw new Error("op=neighbors requires id");
        const [neighbors, edges] = await Promise.all([
            getNeighbors(params.project_name, params.id, params.relation ?? null, params.depth, params.direction),
            getKnowledgeLinks(params.project_name, params.id, params.relation ?? null, params.direction)
        ]);
        return text({ neighbors, edges });
    }
    if (!params.link_ids?.length) throw new Error("op=unlink requires link_ids");
    return text({ deleted: await deleteKnowledgeLinks(params.project_name, params.link_ids) });
});

server.registerTool('memory_admin', {
    description: "Maintenance operations. op=export dumps the memory bank as markdown, op=import loads markdown produced by export, op=summarize condenses a long text before storing it.",
    inputSchema: z.object({
        project_name: z.string().describe("Project name, case-sensitive"),
        op: z.enum(["export", "import", "summarize"]).describe("Admin operation"),
        memory_types: z.array(memoryTypeSchema).optional().describe("op=export: types to include; defaults to the structured contexts, decisions and progress"),
        markdown: z.string().optional().describe("op=import: markdown in this server's export format"),
        content: z.string().optional().describe("op=summarize: text to condense")
    })
}, async (params) => {
    if (params.op === "export") {
        return text(await exportMemoryToMarkdown(params.project_name, params.memory_types ?? null));
    }
    if (params.op === "import") {
        if (!params.markdown) throw new Error("op=import requires markdown");
        return text(await importMemoryFromMarkdown(params.project_name, params.markdown));
    }
    if (!params.content) throw new Error("op=summarize requires content");
    return text(await summarizeText(params.content));
});

async function main() {
    const transport = new StdioServerTransport();

    try {
        await server.connect(transport);
        console.error("Memory Qdrant MCP server running on stdio");
    } catch (error) {
        const err = error as Error;
        console.error("Error connecting server:", err.stack || err);
        process.exit(1);
    }
}

main().catch((error) => {
    const err = error as Error;
    console.error("Fatal error in main():", err.stack || err);
    process.exit(1);
});
