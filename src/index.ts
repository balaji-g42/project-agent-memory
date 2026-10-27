#!/usr/bin/env node

import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import {
    queryMemory,
    listMemory,
    searchHive,
    createMemory,
    toPointId,
    updateMemory,
    deleteMemory,
    deleteCollection,
    getStructuredContext,
    updateStructuredContext,
    getSystemPatterns,
    getContextHistory,
    initializeWorkspace,
    createKnowledgeLink,
    getKnowledgeLinks,
    getNeighbors,
    deleteKnowledgeLinks,
    exportMemoryToMarkdown,
    importMemoryFromMarkdown
} from "./mcp_tools/memoryBankTools.js";
import { summarizeText } from "./mcp_tools/summarizer.js";
import { indexCodeGraph, queryCodeGraph, codeGraphStats } from "./mcp_tools/codeGraph.js";
import { initMemoryBank } from "./init.js";
import {
    historyOf,
    listArchive,
    listProjects,
    looksSecret,
    purgeArchive,
    restoreFromArchive,
    setProjectVisibility,
    upgradeProjects
} from "./hive.js";

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
    name: "project-agent-memory",
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

async function settleAll<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<Array<R | { error: string }>> {
    const settled = await Promise.allSettled(items.map(run));
    if (settled.every(s => s.status === "rejected")) throw (settled[0] as PromiseRejectedResult).reason;
    return settled.map(s => s.status === "fulfilled"
        ? s.value
        : { error: s.reason instanceof Error ? s.reason.message : String(s.reason) });
}

server.registerTool('memory_create', {
    description: "Store one or more memory entries in a single call. Use memory_type to classify each: decisionLog for a choice plus rationale, progress for completed or blocked work, systemPatterns for a reusable rule, productContext/activeContext for project state, customData for verbatim documents. Use metadata for filterable fields such as status, priority or dataType.",
    inputSchema: z.object({
        project_name: z.string().describe("Project name, case-sensitive"),
        target_project: z.string().optional().describe("Other project to write to"),
        items: z.array(z.object({
            memory_type: memoryTypeSchema.describe("Memory type"),
            content: z.string().describe("Content to store"),
            id: z.string().optional().describe("Optional explicit id; overwrites an existing entry"),
            metadata: z.record(z.string(), z.any()).optional().describe("Filterable fields, e.g. { status: \"in_progress\", priority: \"high\" }"),
            private: z.boolean().optional().describe("Hide from other projects")
        })).min(1).describe("One entry for a single write, many for a batch")
    })
}, async (params) => {
    const results = await settleAll(params.items, async item => ({
        item,
        ids: await createMemory(params.project_name, params.target_project, item.memory_type, item.content, item.id ?? null, item.metadata ?? {}, item.private)
    }));
    return text(results.map(result => {
        if ("error" in result) return result;
        const { item, ids } = result;
        return {
            id: ids[0],
            type: item.memory_type,
            ...(ids.length > 1 ? { chunk_ids: ids } : {}),
            ...(params.target_project && params.target_project !== params.project_name ? { project: params.target_project } : {}),
            ...(looksSecret(item.content) ? { private: true, note: "Looks like a secret; marked private. Store secrets in a vault, not memory." } : {})
        };
    }));
});

server.registerTool('memory_read', {
    description: "Retrieve memory entries. Each query with query_text runs semantic search; without it, lists the most recent entries of the given type. metadata_filter narrows on fields stored via memory_create, with an array value matching any of its elements.",
    inputSchema: z.object({
        project_name: z.string().describe("Project name, case-sensitive"),
        target_project: z.array(z.string()).optional().describe("Other projects to search instead of your own (max 5)"),
        queries: z.array(z.object({
            query_text: z.string().optional().describe("Search text; omit to list by recency"),
            memory_type: memoryTypeSchema.optional().describe("Restrict to one memory type"),
            metadata_filter: z.record(z.string(), z.any()).optional().describe("Metadata equality filter, e.g. { status: [\"pending\", \"blocked\"] }"),
            limit: z.number().optional().describe("Maximum entries to return"),
            heat: z.number().int().min(1).max(10).optional().describe("Other projects only: 1 loose to 10 strict match")
        })).min(1).describe("One query for a single read, many for a batch")
    })
}, async (params) => {
    const targets = params.target_project;
    const results = await Promise.all(params.queries.map(q =>
        targets?.length
            ? searchHive(params.project_name, targets, q)
            : q.query_text
                ? queryMemory(params.project_name, q.query_text, q.memory_type ?? null, q.limit ?? 5, q.metadata_filter ?? null)
                : listMemory(params.project_name, q.memory_type ?? null, q.limit ?? 5, q.metadata_filter ?? null)
    ));
    return text(results.length === 1 ? results[0] : results);
});

server.registerTool('memory_update', {
    description: "Update existing memory entries by id. Content is re-embedded when supplied; metadata is shallow-merged into what is already stored.",
    inputSchema: z.object({
        project_name: z.string().describe("Project name, case-sensitive"),
        target_project: z.string().optional().describe("Other project that owns the entries"),
        items: z.array(z.object({
            id: z.string().describe("Id of the entry to update"),
            content: z.string().optional().describe("New content; omit to keep the existing content and vector"),
            metadata: z.record(z.string(), z.any()).optional().describe("Metadata fields to merge in"),
            expected_version: z.number().int().optional().describe("Version from your last read"),
            private: z.boolean().optional().describe("Hide from other projects")
        })).min(1).describe("One entry for a single update, many for a batch")
    })
}, async (params) => {
    const results = await settleAll(params.items, async item => ({
        id: item.id,
        ...await updateMemory(params.target_project ?? params.project_name, item.id, item.content, item.metadata, {
            caller: params.project_name,
            expectedVersion: item.expected_version,
            isPrivate: item.private
        })
    }));
    return text(results.map(result => "error" in result ? result : { ...result, updated: true }));
});

server.registerTool('memory_delete', {
    description: "Delete memory entries by id. Your own entries are deleted permanently; another project's entries are archived and can be restored by their owner.",
    inputSchema: z.object({
        project_name: z.string().describe("Project name, case-sensitive"),
        target_project: z.string().optional().describe("Other project that owns the entries"),
        ids: z.array(z.string()).min(1).describe("Ids of entries to delete")
    })
}, async (params) => {
    const foreign = params.target_project !== undefined && params.target_project !== params.project_name;
    const deleted = await deleteMemory(params.target_project ?? params.project_name, params.ids, params.project_name);
    return text({ deleted, ...(foreign ? { archived: true } : {}) });
});

server.registerTool('memory_context', {
    description: "Load or update the project's working context: product context, active context and system patterns. Call at session start with no update fields; pass product_context or active_context to patch them.",
    inputSchema: z.object({
        project_name: z.string().describe("Project name, case-sensitive"),
        product_context: z.record(z.string(), z.any()).optional().describe("Patch to merge into product context"),
        active_context: z.record(z.string(), z.any()).optional().describe("Patch to merge into active context"),
        pattern_limit: z.number().optional().default(20).describe("Maximum system patterns to return"),
        history_for: z.enum(["productContext", "activeContext"]).optional().describe("Also return recent change history for this context type"),
        history_limit: z.number().optional().default(10).describe("Maximum history entries to return when history_for is set")
    })
}, async (params) => {
    await initMemoryBank(params.project_name);
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

    const [product, active, patterns, history] = await Promise.all([
        getStructuredContext(params.project_name, "productContext"),
        getStructuredContext(params.project_name, "activeContext"),
        getSystemPatterns(params.project_name, params.pattern_limit),
        params.history_for
            ? getContextHistory(params.project_name, params.history_for, params.history_limit)
            : Promise.resolve(undefined)
    ]);

    return text({ productContext: product, activeContext: active, systemPatterns: patterns, ...(history ? { history } : {}) });
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
    description: "Maintenance operations. op=export dumps the memory bank as markdown, op=import loads markdown produced by export, op=summarize condenses a long text before storing it, op=delete_collection permanently deletes the entire memory bank for a project. op=list_projects lists other projects you can read; op=set_visibility sets this project's default; op=list_archive, restore, purge and history manage entries other projects deleted or edited here.",
    inputSchema: z.object({
        project_name: z.string().describe("Project name, case-sensitive"),
        op: z.enum(["export", "import", "summarize", "delete_collection", "list_projects", "set_visibility", "list_archive", "restore", "purge", "history"]).describe("Admin operation"),
        memory_types: z.array(memoryTypeSchema).optional().describe("op=export: types to include; defaults to the structured contexts, decisions and progress"),
        markdown: z.string().optional().describe("op=import: markdown in this server's export format"),
        content: z.string().optional().describe("op=summarize: text to condense"),
        ids: z.array(z.string()).optional().describe("op=restore, purge, history: entry ids"),
        visibility: z.enum(["public", "private"]).optional().describe("op=set_visibility: project default")
    })
}, async (params) => {
    if (params.op === "list_projects") {
        return text(await listProjects(params.project_name));
    }
    if (params.op === "set_visibility") {
        if (!params.visibility) throw new Error("op=set_visibility requires visibility");
        return text({ visibility: await setProjectVisibility(params.project_name, params.visibility) });
    }
    if (params.op === "list_archive") {
        return text(await listArchive(params.project_name));
    }
    if (params.op === "restore" || params.op === "purge" || params.op === "history") {
        if (!params.ids?.length) throw new Error(`op=${params.op} requires ids`);
        const ids = params.ids.map(toPointId);
        if (params.op === "restore") return text(await restoreFromArchive(params.project_name, ids));
        if (params.op === "purge") return text({ purged: await purgeArchive(params.project_name, ids) });
        return text(await historyOf(params.project_name, ids[0]));
    }
    if (params.op === "export") {
        return text(await exportMemoryToMarkdown(params.project_name, params.memory_types ?? null));
    }
    if (params.op === "import") {
        if (!params.markdown) throw new Error("op=import requires markdown");
        return text(await importMemoryFromMarkdown(params.project_name, params.markdown));
    }
    if (params.op === "delete_collection") {
        return text({ deleted: await deleteCollection(params.project_name) });
    }
    if (!params.content) throw new Error("op=summarize requires content");
    return text(await summarizeText(params.content));
});

server.registerTool('code_graph', {
    _meta: { "anthropic/alwaysLoad": true },
    description: "Code structure graph built from a full tree-sitter parse of every source file in the repo (functions, classes, imports, calls). For any question about where a symbol lives, what calls it or what it calls, call op=query first and on its own, before Grep or Glob, and answer from its result directly: caller and callee lists are complete for statically resolvable calls, so do not re-verify them with grep or by reading files. Read a file only when you need the code itself. op=query matches by exact name first (falling back to semantic matches when no symbol has that name), then walks call/import edges up to depth hops. op=index (re)builds the graph incrementally from root with the built-in tree-sitter extractor; op=stats reports whether it is indexed.",
    inputSchema: z.object({
        project_name: z.string().describe("Project name, case-sensitive"),
        op: z.enum(["query", "index", "stats"]).describe("Code graph operation"),
        query: z.string().optional().describe("op=query: symbol name or description of the code you are looking for"),
        depth: z.number().int().min(0).max(3).default(1).describe("op=query: edge hops to walk from the matches"),
        limit: z.number().int().min(1).max(20).default(5).describe("op=query: number of seed matches"),
        relation: z.string().optional().describe("op=query: only walk edges of this relation, e.g. calls, imports"),
        root: z.string().optional().describe("op=index: absolute repo path (required)")
    })
}, async (params) => {
    if (params.op === "index") {
        if (!params.root) throw new Error("op=index requires root (absolute repo path)");
        return text(await indexCodeGraph(params.project_name, params.root));
    }
    if (params.op === "stats") {
        return text(await codeGraphStats(params.project_name));
    }
    if (!params.query) throw new Error("op=query requires query");
    return text(await queryCodeGraph(params.project_name, params.query, params.depth, params.limit, params.relation ?? null));
});

async function main() {
    const transport = new StdioServerTransport();

    try {
        await server.connect(transport);
        console.error("Project Agent Memory server running on stdio");
        upgradeProjects().catch(err => console.error("Hive upgrade skipped:", err instanceof Error ? err.message : err));
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
