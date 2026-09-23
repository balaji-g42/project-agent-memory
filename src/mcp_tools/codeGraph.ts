import { execFile } from "child_process";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { tmpdir } from "os";
import { isAbsolute, join, relative, resolve } from "path";
import { promisify } from "util";
import { v5 as uuidv5 } from "uuid";
import config from "../config.js";
import { client } from "../init.js";
import { embedTexts } from "../embeddings.js";

const execFileAsync = promisify(execFile);

const CODE_NODE_NAMESPACE = "3c1e8f2a-7b4d-5e6f-9a0b-1c2d3e4f5a6b";
const MAX_CODE_NODES = 100000;
const EMBED_BATCH = 64;
const UPSERT_BATCH = 256;
const MAX_QUERY_NODES = 40;
const MAX_EDGES_SHOWN = 12;
const MAX_OUTPUT_CHARS = 6000;

interface CodeEdge {
    id: string;
    relation: string;
    confidence?: string;
}

interface CodeNode {
    node_id: string;
    label: string;
    source_file: string;
    source_location: string;
    out: CodeEdge[];
    in: CodeEdge[];
    hash: string;
}

interface IndexResult {
    nodes: number;
    upserted: number;
    deleted: number;
}

function codeCollection(projectName: string): string {
    return `code_graph_${projectName}`;
}

function codePointId(projectName: string, nodeId: string): string {
    return uuidv5(`${projectName}:${nodeId}`, CODE_NODE_NAMESPACE);
}

function graphifyOutDir(projectName: string): string {
    return join(tmpdir(), "project-agent-memory", "graphify", projectName.replace(/[^\w.-]/g, "_"));
}

async function ensureCodeCollection(projectName: string): Promise<string> {
    const name = codeCollection(projectName);
    const { collections } = await client.getCollections();
    if (!collections.some((c) => c.name === name)) {
        await client.createCollection(name, {
            vectors: { size: config.VECTOR_DIM as number, distance: config.DISTANCE_METRIC || "Cosine" }
        });
    }
    return name;
}

function toRelativePath(root: string, file: string): string {
    if (!file) return "";
    const rel = isAbsolute(file) ? relative(root, file) : file;
    return rel.replace(/\\/g, "/");
}

function nodeHash(node: Omit<CodeNode, "hash">): string {
    return createHash("sha1").update(JSON.stringify(node)).digest("hex");
}

function parseGraph(raw: any, root: string): CodeNode[] {
    const nodes = new Map<string, Omit<CodeNode, "hash">>();
    for (const n of raw?.nodes ?? []) {
        if (n?.id === undefined || n.id === null) continue;
        const id = String(n.id);
        nodes.set(id, {
            node_id: id,
            label: String(n.label ?? id),
            source_file: toRelativePath(root, String(n.source_file ?? "")),
            source_location: String(n.source_location ?? ""),
            out: [],
            in: []
        });
    }

    const seen = new Set<string>();
    for (const e of raw?.edges ?? raw?.links ?? []) {
        const source = String(e?.source ?? e?._src ?? "");
        const target = String(e?.target ?? e?._tgt ?? "");
        const from = nodes.get(source);
        const to = nodes.get(target);
        if (!from || !to || source === target) continue;
        const relation = String(e.relation ?? "related");
        const key = `${source}\u0000${target}\u0000${relation}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const confidence = e.confidence ? String(e.confidence) : undefined;
        from.out.push({ id: target, relation, ...(confidence ? { confidence } : {}) });
        to.in.push({ id: source, relation, ...(confidence ? { confidence } : {}) });
    }

    return [...nodes.values()].map((n) => ({ ...n, hash: nodeHash(n) }));
}

function embedText(node: CodeNode): string {
    return `${node.label} ${node.source_file}`.trim();
}

async function runGraphify(root: string, outDir: string): Promise<any> {
    try {
        await execFileAsync(
            "graphify",
            ["extract", root, "--code-only", "--no-cluster", "--out", outDir],
            { maxBuffer: 64 * 1024 * 1024, windowsHide: true }
        );
    } catch (error) {
        const err = error as NodeJS.ErrnoException & { stderr?: string };
        if (err.code === "ENOENT") {
            throw new Error("graphify is not installed. Install it with: pipx install graphifyy");
        }
        throw new Error(`graphify extract failed: ${(err.stderr || err.message || "").slice(-2000)}`);
    }
    return JSON.parse(await readFile(join(outDir, "graphify-out", "graph.json"), "utf-8"));
}

async function indexCodeGraph(projectName: string, rootDir: string): Promise<IndexResult> {
    const root = resolve(rootDir);
    const graph = await runGraphify(root, graphifyOutDir(projectName));
    const nodes = parseGraph(graph, root);
    const collectionName = await ensureCodeCollection(projectName);

    const { points: existing } = await client.scroll(collectionName, {
        filter: { must: [{ key: "project", match: { value: projectName } }] },
        limit: MAX_CODE_NODES,
        with_payload: true,
        with_vector: false
    });
    const existingHash = new Map<string, string>();
    for (const p of existing) existingHash.set(String(p.id), p.payload?.metadata?.hash);

    const changed = nodes.filter((n) => existingHash.get(codePointId(projectName, n.node_id)) !== n.hash);
    const liveIds = new Set(nodes.map((n) => codePointId(projectName, n.node_id)));
    const stale = [...existingHash.keys()].filter((id) => !liveIds.has(id));

    const timestamp = new Date().toISOString();
    for (let i = 0; i < changed.length; i += EMBED_BATCH) {
        const batch = changed.slice(i, i + EMBED_BATCH);
        const vectors = await embedTexts(batch.map(embedText));
        const points = batch.map((node, j) => ({
            id: codePointId(projectName, node.node_id),
            vector: vectors[j],
            payload: {
                type: "codeNode",
                content: embedText(node),
                metadata: node,
                timestamp,
                project: projectName
            }
        }));
        for (let k = 0; k < points.length; k += UPSERT_BATCH) {
            await client.upsert(collectionName, { wait: true, points: points.slice(k, k + UPSERT_BATCH) });
        }
    }

    if (stale.length > 0) {
        await client.delete(collectionName, { wait: true, points: stale });
    }

    return { nodes: nodes.length, upserted: changed.length, deleted: stale.length };
}

async function hasCodeGraph(projectName: string): Promise<boolean> {
    const { collections } = await client.getCollections();
    return collections.some((c) => c.name === codeCollection(projectName));
}

async function codeGraphStats(projectName: string): Promise<{ indexed: boolean; nodes: number }> {
    if (!(await hasCodeGraph(projectName))) return { indexed: false, nodes: 0 };
    const info = await client.getCollection(codeCollection(projectName));
    return { indexed: true, nodes: Number(info.points_count ?? 0) };
}

function location(node: CodeNode): string {
    return node.source_location ? `${node.source_file}:${node.source_location}` : node.source_file;
}

function renderEdges(edges: CodeEdge[], arrow: string, nodes: Map<string, CodeNode>): string[] {
    const lines = edges.slice(0, MAX_EDGES_SHOWN).map((e) => {
        const other = nodes.get(e.id);
        const name = other ? `${other.label} (${location(other)})` : e.id;
        return `  ${arrow.replace("%", e.relation)} ${name}`;
    });
    if (edges.length > MAX_EDGES_SHOWN) lines.push(`  ... ${edges.length - MAX_EDGES_SHOWN} more`);
    return lines;
}

function renderCodeGraph(seeds: string[], nodes: Map<string, CodeNode>): string {
    const order = [...seeds, ...[...nodes.keys()].filter((id) => !seeds.includes(id))];
    let out = "";
    for (const id of order) {
        const node = nodes.get(id);
        if (!node) continue;
        const block = [
            `${seeds.includes(id) ? "*" : "-"} ${node.label}  ${location(node)}`,
            ...renderEdges(node.out, "-%->", nodes),
            ...renderEdges(node.in, "<-%-", nodes)
        ].join("\n") + "\n";
        if (out.length + block.length > MAX_OUTPUT_CHARS) {
            out += `... output truncated at ${MAX_OUTPUT_CHARS} chars; narrow the query or lower depth\n`;
            break;
        }
        out += block;
    }
    return out || "No matching code nodes.";
}

async function queryCodeGraph(
    projectName: string,
    query: string,
    depth: number = 1,
    limit: number = 5,
    relation: string | null = null
): Promise<string> {
    if (!(await hasCodeGraph(projectName))) {
        return "No code graph for this project. Run code_graph with op=index first.";
    }
    const collectionName = codeCollection(projectName);
    const projectFilter = { key: "project", match: { value: projectName } };

    const [vector] = await embedTexts([query]);
    const [byVector, byName] = await Promise.all([
        client.query(collectionName, { query: vector, limit, filter: { must: [projectFilter] }, with_payload: true }),
        client.scroll(collectionName, {
            filter: { must: [projectFilter, { key: "metadata.label", match: { any: [query, `${query}()`] } }] },
            limit,
            with_payload: true,
            with_vector: false
        })
    ]);

    const nodes = new Map<string, CodeNode>();
    const seeds: string[] = [];
    for (const p of [...byName.points, ...byVector.points]) {
        const node = p.payload?.metadata as CodeNode | undefined;
        if (!node || nodes.has(node.node_id)) continue;
        nodes.set(node.node_id, node);
        seeds.push(node.node_id);
    }

    let frontier = [...seeds];
    for (let d = 0; d < depth && frontier.length > 0 && nodes.size < MAX_QUERY_NODES; d++) {
        const next = new Set<string>();
        for (const id of frontier) {
            const node = nodes.get(id)!;
            for (const e of [...node.out, ...node.in]) {
                if (relation && e.relation !== relation) continue;
                if (!nodes.has(e.id)) next.add(e.id);
            }
        }
        const wanted = [...next].slice(0, MAX_QUERY_NODES - nodes.size);
        if (wanted.length === 0) break;
        const fetched = await client.retrieve(collectionName, {
            ids: wanted.map((id) => codePointId(projectName, id)),
            with_payload: true
        });
        frontier = [];
        for (const p of fetched) {
            const node = p.payload?.metadata as CodeNode | undefined;
            if (!node || nodes.has(node.node_id)) continue;
            nodes.set(node.node_id, node);
            frontier.push(node.node_id);
        }
    }

    return renderCodeGraph(seeds, nodes);
}

async function searchCodeNodes(projectName: string, query: string, limit: number = 3): Promise<Array<{ score: number; label: string; location: string }>> {
    if (!(await hasCodeGraph(projectName))) return [];
    const [vector] = await embedTexts([query]);
    const { points } = await client.query(codeCollection(projectName), {
        query: vector,
        limit,
        filter: { must: [{ key: "project", match: { value: projectName } }] },
        with_payload: true
    });
    return points
        .filter((p) => p.payload?.metadata)
        .map((p) => ({ score: p.score, label: p.payload!.metadata.label, location: location(p.payload!.metadata) }));
}

export { parseGraph, renderCodeGraph, indexCodeGraph, queryCodeGraph, codeGraphStats, searchCodeNodes };
export type { CodeNode };
