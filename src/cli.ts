#!/usr/bin/env node

import "dotenv/config";

const PLUGIN_OPTIONS: Record<string, string> = {
    CLAUDE_PLUGIN_OPTION_MEMORY_BACKEND: "MEMORY_BACKEND",
    CLAUDE_PLUGIN_OPTION_QDRANT_URL: "QDRANT_URL",
    CLAUDE_PLUGIN_OPTION_QDRANT_API_KEY: "QDRANT_API_KEY",
    CLAUDE_PLUGIN_OPTION_POSTGRES_URL: "POSTGRES_URL",
    CLAUDE_PLUGIN_OPTION_POSTGRES_PASSWORD: "POSTGRES_PASSWORD"
};

const MIN_MEMORY_SCORE = 0.5;
const MIN_CODE_SCORE = 0.5;
const MAX_MEMORY_CHARS = 300;
const MAX_CONTEXT_PATTERNS = 20;
const MAX_CONTEXT_CHARS = 3000;

for (const [from, to] of Object.entries(PLUGIN_OPTIONS)) {
    if (process.env[from] && !process.env[to]) process.env[to] = process.env[from];
}

async function recall(projectName: string, prompt: string): Promise<string> {
    const { queryMemory } = await import("./mcp_tools/memoryBankTools.js");
    const { searchCodeNodes } = await import("./mcp_tools/codeGraph.js");
    const [memories, code] = await Promise.all([
        queryMemory(projectName, prompt, null, 5).catch(() => []),
        searchCodeNodes(projectName, prompt, 3).catch(() => [])
    ]);

    const lines: string[] = [];
    const relevant = memories.filter((m) => m.score >= MIN_MEMORY_SCORE).slice(0, 3);
    if (relevant.length > 0) {
        lines.push("Recalled memory (memory_read for more):");
        for (const m of relevant) {
            const content = String(m.content ?? "").replace(/\s+/g, " ");
            const clipped = content.length > MAX_MEMORY_CHARS ? `${content.slice(0, MAX_MEMORY_CHARS)}...` : content;
            lines.push(`- [${m.type} ${m.id}] ${clipped}`);
        }
    }
    const nodes = code.filter((c) => c.score >= MIN_CODE_SCORE);
    if (nodes.length > 0) {
        lines.push("Related code (code_graph op=query for callers/callees):");
        for (const n of nodes) lines.push(`- ${n.label}  ${n.location}`);
    }
    return lines.join("\n");
}

async function context(projectName: string): Promise<string> {
    const { getStructuredContext, getSystemPatterns } = await import("./mcp_tools/memoryBankTools.js");
    const { codeGraphStats } = await import("./mcp_tools/codeGraph.js");
    const [product, active, patterns, code] = await Promise.all([
        getStructuredContext(projectName, "productContext").catch(() => ({})),
        getStructuredContext(projectName, "activeContext").catch(() => ({})),
        getSystemPatterns(projectName, MAX_CONTEXT_PATTERNS).catch(() => []),
        codeGraphStats(projectName).catch(() => ({ indexed: false, nodes: 0 }))
    ]);
    const clip = (value: unknown) => {
        const s = JSON.stringify(value);
        return s.length > MAX_CONTEXT_CHARS ? `${s.slice(0, MAX_CONTEXT_CHARS)}...` : s;
    };
    return JSON.stringify({
        code,
        text: `productContext: ${clip(product)}\nactiveContext: ${clip(active)}\nsystemPatterns: ${clip(patterns)}`
    });
}

async function readStdin(): Promise<string> {
    let data = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) data += chunk;
    return data;
}

async function main() {
    const [command, projectName, arg] = process.argv.slice(2);
    if (!projectName) throw new Error("Usage: project-agent-memory-cli <recall|context|index|stats> <project_name> [root]");

    if (command === "recall") {
        process.stdout.write(await recall(projectName, await readStdin()));
    } else if (command === "context") {
        process.stdout.write(await context(projectName));
    } else if (command === "index") {
        const { indexCodeGraph } = await import("./mcp_tools/codeGraph.js");
        process.stdout.write(JSON.stringify(await indexCodeGraph(projectName, arg ?? process.cwd())));
    } else if (command === "stats") {
        const { codeGraphStats } = await import("./mcp_tools/codeGraph.js");
        process.stdout.write(JSON.stringify(await codeGraphStats(projectName)));
    } else {
        throw new Error(`Unknown command: ${command}`);
    }
}

main().catch((error) => {
    const err = error as Error;
    console.error(err.message || err);
    process.exit(1);
});
