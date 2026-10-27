import { initMemoryBank, client } from "../init.js";
import { v4 as uuidv4, v5 as uuidv5 } from "uuid";
import { embeddingCache, queryCache, contextCache, patternCache, cacheKeys, cacheUtils } from "../cache.js";
import type { 
    MemoryType, 
    BatchLogEntry, 
    WorkspaceInfo,
    LinkDirection
} from "../types.js";

import { getEmbeddingProvider } from "../embeddings.js";
import { MAX_TEXT_LENGTH_FOR_EMBEDDING } from "../constants.js";
import config from "../config.js";
import {
    DEFAULT_HEAT,
    HIVE_DEFAULT_LIMIT,
    HIVE_MAX_LIMIT,
    MAX_HIVE_PROJECTS,
    SESSION_ID,
    SETTINGS_TYPE,
    archiveName,
    bankName,
    minScoreForHeat
} from "../hiveConstants.js";
import {
    archiveDeleted,
    archiveSuperseded,
    bankExists,
    casFilter,
    conflictMessage,
    foreignFilter,
    isVisibleToForeign,
    looksSecret,
    projectVisibility,
    snapshotOf,
    versionOf,
    visibilityFromFlag,
    type Visibility
} from "../hive.js";

/**
 * Cached embedding generation with performance optimization
 * @param texts - Array of texts to embed
 * @returns Array of embeddings
 */
async function getCachedEmbeddings(texts: string[]): Promise<number[][]> {
    const provider = getEmbeddingProvider();
    const results: number[][] = [];
    const uncachedTexts: string[] = [];
    const uncachedIndices: number[] = [];

    // Check cache for each text
    texts.forEach((text, index) => {
        const cacheKey = cacheKeys.embedding(text);
        const cached = cacheUtils.getCached(embeddingCache, cacheKey);
        if (cached) {
            results[index] = cached;
        } else {
            uncachedTexts.push(text);
            uncachedIndices.push(index);
        }
    });

    // Generate embeddings for uncached texts
    if (uncachedTexts.length > 0) {
        const newEmbeddings = await provider.embedTexts(uncachedTexts);

        // Cache and store results
        uncachedTexts.forEach((text, i) => {
            const embedding = newEmbeddings[i];
            const cacheKey = cacheKeys.embedding(text);
            cacheUtils.setCached(embeddingCache, cacheKey, embedding);
            results[uncachedIndices[i]] = embedding;
        });
    }

    return results;
}

const MEMORY_TYPES: MemoryType[] = ["productContext", "activeContext", "systemPatterns", "decisionLog", "progress", "contextHistory", "customData", "knowledgeLink"];

// Context structured context types
const LIST_PAGE_SIZE = 256;
const PLACEHOLDER_PREFIX = "Initial placeholder for ";
const STRUCTURED_CONTEXT_TYPES:("productContext" | "activeContext")[] = ["productContext", "activeContext"];
const SYSTEM_PATTERN_TYPE: MemoryType = "systemPatterns";

// Interface definitions for return types
interface QueryResult {
    id: string | number;
    score: number;
    content: string;
    type: string;
    timestamp: string;
    metadata: Record<string, any>;
    version?: number;
    private?: boolean;
    previous?: Record<string, any>;
    project?: string;
}

interface WriteStamp {
    writtenBy?: string;
    visibility?: Visibility;
}

interface UpdateOptions {
    caller?: string;
    expectedVersion?: number;
    isPrivate?: boolean;
}

interface GraphEdgeInput {
    from_id: string;
    to_id: string;
    relation: string;
    description?: string;
}

interface NeighborResult {
    id: string;
    depth: number;
    via: string;
    content: string;
    type: string;
}

interface KnowledgeLink {
    id: string | number;
    sourceId: string;
    targetId: string;
    linkType: string;
    description: string;
    timestamp: string;
}

interface ContextHistoryEntry {
    id: string | number;
    contextType: string;
    changes: Record<string, any>;
    timestamp: string;
    pointId: string;
}

interface SystemPattern {
    id: string | number;
    pattern: string;
    timestamp: string;
}

interface WorkspaceStructure {
    projectName: string;
    detectedFiles: string[];
    detectedDirectories: string[];
    language: string;
    framework: string;
    timestamp: string;
}

interface InitializationResult {
    workspaceId: string | null;
    structure: WorkspaceStructure;
    initialized: boolean;
    error?: string;
}

interface ExportData {
    projectName: string;
    exportDate: string;
    sections: Record<string, any>;
}

interface ImportResult {
    imported: number;
    errors: string[];
    timestamp: string;
}

// ----- Log memory entry -----
async function logMemory(projectName: string, memoryType: MemoryType, content: string, topLevelId: string | null = null, metadata: Record<string, any> = {}, stamp: WriteStamp = {}): Promise<string> {
    if (!MEMORY_TYPES.includes(memoryType)) {
        throw new Error(`Invalid memory type: ${memoryType}`);
    }

    const collectionName = await initMemoryBank(projectName);

    // Embed content with caching
    const vectors = await getCachedEmbeddings([content]);
    const vector = vectors[0];

    const pointId = topLevelId ? toPointId(topLevelId) : uuidv4();

    let version = 1;
    let visibility: Visibility | undefined = looksSecret(content) ? "private" : stamp.visibility;
    if (topLevelId) {
        const [existing] = await client.retrieve(collectionName, { ids: [pointId], with_payload: true });
        if (existing) {
            version = versionOf(existing.payload) + 1;
            visibility = visibility ?? existing.payload?.visibility;
        }
    }

    const point = {
        id: pointId,
        vector,
        payload: {
            type: memoryType,
            content,
            metadata,
            timestamp: new Date().toISOString(),
            project: projectName,
            version,
            written_by: stamp.writtenBy ?? projectName,
            written_by_session: SESSION_ID,
            write_token: uuidv4(),
            ...(visibility ? { visibility } : {})
        }
    };

    await client.upsert(collectionName, { wait: true, points: [point] });

    // Invalidate relevant caches
    cacheUtils.invalidateProjectCache(projectName);

    return pointId;
}

// ----- Query memory -----
function metadataFilterClauses(metadataFilter: Record<string, any> | null): any[] {
    if (!metadataFilter) return [];
    return Object.entries(metadataFilter).map(([key, value]) => (
        Array.isArray(value)
            ? { key: `metadata.${key}`, match: { any: value } }
            : { key: `metadata.${key}`, match: { value } }
    ));
}

function toQueryResult(point: { id: string | number; score?: number; payload?: Record<string, any> | null }, project?: string): QueryResult {
    const payload = point.payload ?? {};
    return {
        id: point.id,
        score: point.score ?? 0,
        content: payload.content,
        type: payload.type,
        timestamp: payload.timestamp,
        metadata: payload.metadata ?? {},
        ...(payload.version !== undefined ? { version: payload.version } : {}),
        ...(payload.visibility === "private" ? { private: true } : {}),
        ...(payload.previous ? { previous: payload.previous } : {}),
        ...(project ? { project } : {})
    };
}

async function queryMemory(projectName: string, queryText: string, memoryType: string | null = null, topK: number = 5, metadataFilter: Record<string, any> | null = null): Promise<QueryResult[]> {
    // Check cache first
    const cacheKey = cacheKeys.query(projectName, queryText, memoryType || undefined, topK) + (metadataFilter ? `:${JSON.stringify(metadataFilter)}` : "");
    const cachedResult = cacheUtils.getCached(queryCache, cacheKey);
    if (cachedResult) {
        return cachedResult;
    }

    const collectionName = `memory_bank_${projectName}`;

    // Use cached embeddings
    const vectors = await getCachedEmbeddings([queryText]);
    const vector = vectors[0];

    // Build filter
    const mustFilter: any[] = [{ key: "project", match: { value: projectName } }];
    if (memoryType) mustFilter.push({ key: "type", match: { value: memoryType } });
    mustFilter.push(...metadataFilterClauses(metadataFilter));

    const { points: results } = await client.query(collectionName, {
        with_payload: true,
        query: vector,
        limit: topK,
        filter: { must: mustFilter, must_not: [{ key: "type", match: { value: SETTINGS_TYPE } }] }
    });

    const formattedResults: QueryResult[] = results.map((hit: any) => toQueryResult(hit));

    // Cache the results
    cacheUtils.setCached(queryCache, cacheKey, formattedResults);

    return formattedResults;
}

async function logMemoryChunked(projectName: string, memoryType: MemoryType, content: string, topLevelId: string | null = null, metadata: Record<string, any> = {}, stamp: WriteStamp = {}): Promise<string[]> {
    if (content.length <= MAX_TEXT_LENGTH_FOR_EMBEDDING) {
        return [await logMemory(projectName, memoryType, content, topLevelId, metadata, stamp)];
    }

    const chunks = getEmbeddingProvider().chunkText(content, Infinity);
    const headId = topLevelId ? toPointId(topLevelId) : uuidv4();
    const ids: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
        ids.push(await logMemory(projectName, memoryType, chunks[i], i === 0 ? headId : null, {
            ...metadata,
            chunkGroup: headId,
            chunkIndex: i,
            chunkCount: chunks.length
        }, stamp));
    }

    await createKnowledgeLink(projectName, ids.slice(1).map((toId, i) => ({
        from_id: ids[i],
        to_id: toId,
        relation: "next_chunk"
    })));
    return ids;
}

async function listMemory(projectName: string, memoryType: string | null = null, limit: number = 20, metadataFilter: Record<string, any> | null = null): Promise<QueryResult[]> {
    const collectionName = await initMemoryBank(projectName);

    const mustFilter: any[] = [{ key: "project", match: { value: projectName } }];
    if (memoryType) mustFilter.push({ key: "type", match: { value: memoryType } });
    mustFilter.push(...metadataFilterClauses(metadataFilter));

    const points: any[] = [];
    let offset: string | number | null | undefined;
    do {
        const page = await client.scroll(collectionName, {
            filter: { must: mustFilter, must_not: [{ key: "type", match: { value: SETTINGS_TYPE } }] },
            limit: Math.max(limit, LIST_PAGE_SIZE),
            ...(offset != null ? { offset } : {}),
            with_payload: true,
            with_vector: false
        });
        points.push(...page.points);
        offset = page.next_page_offset;
    } while (offset != null);

    return points
        .filter((point: any) => !String(point.payload?.content ?? "").startsWith(PLACEHOLDER_PREFIX))
        .map((point: any) => toQueryResult(point))
        .sort((a: QueryResult, b: QueryResult) => String(b.timestamp).localeCompare(String(a.timestamp)))
        .slice(0, limit);
}

interface HiveQuery {
    query_text?: string;
    memory_type?: string;
    metadata_filter?: Record<string, any>;
    limit?: number;
    heat?: number;
}

async function searchHive(caller: string, targets: string[], q: HiveQuery): Promise<QueryResult[]> {
    const projects = [...new Set(targets)];
    if (projects.length > MAX_HIVE_PROJECTS) {
        throw new Error(`At most ${MAX_HIVE_PROJECTS} projects per call; pick the most relevant from memory_admin op=list_projects.`);
    }
    const limit = Math.min(q.limit ?? HIVE_DEFAULT_LIMIT, HIVE_MAX_LIMIT);
    const minScore = (config.DISTANCE_METRIC || "Cosine") === "Cosine" ? minScoreForHeat(q.heat ?? DEFAULT_HEAT) : -Infinity;
    const vector = q.query_text ? (await getCachedEmbeddings([q.query_text]))[0] : null;

    const perProject = await Promise.all(projects.map(async (project): Promise<QueryResult[]> => {
        if (project === caller) {
            const own = q.query_text
                ? await queryMemory(project, q.query_text, q.memory_type ?? null, limit, q.metadata_filter ?? null)
                : await listMemory(project, q.memory_type ?? null, limit, q.metadata_filter ?? null);
            return own.map(r => ({ ...r, project }));
        }
        if (!(await bankExists(project))) return [];
        const visibility = await projectVisibility(project);
        const extra = [
            ...(q.memory_type ? [{ key: "type", match: { value: q.memory_type } }] : []),
            ...metadataFilterClauses(q.metadata_filter ?? null)
        ];
        const filter = foreignFilter(project, visibility, extra);
        if (vector) {
            const { points } = await client.query(bankName(project), { query: vector, limit, filter, with_payload: true });
            return points
                .filter(hit => hit.score >= minScore && isVisibleToForeign(hit.payload, visibility))
                .map(hit => toQueryResult(hit, project));
        }
        const page = await client.scroll(bankName(project), { filter, limit: Math.max(limit, LIST_PAGE_SIZE), with_payload: true, with_vector: false });
        return page.points
            .filter(point => isVisibleToForeign(point.payload, visibility))
            .map(point => toQueryResult(point, project))
            .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    }));

    const merged = perProject.flat();
    return (vector
        ? merged.sort((a, b) => b.score - a.score)
        : merged.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    ).slice(0, limit);
}

async function createMemory(
    caller: string,
    target: string | undefined,
    memoryType: MemoryType,
    content: string,
    id: string | null,
    metadata: Record<string, any>,
    isPrivate?: boolean
): Promise<string[]> {
    const project = target ?? caller;
    const visibility = visibilityFromFlag(isPrivate);
    if (project !== caller) {
        if (!(await bankExists(project))) throw new Error(`Project ${project} not found or not shared`);
        const effective = visibility ?? await projectVisibility(project);
        if (effective !== "public") throw new Error(`Project ${project} not found or not shared`);
        if (looksSecret(content)) throw new Error("Content looks like a secret; not written to another project");
        if (id) {
            const [existing] = await client.retrieve(bankName(project), { ids: [toPointId(id)], with_payload: false });
            if (existing) throw new Error(`${id} already exists in ${project}; use memory_update with expected_version`);
        }
    }
    return logMemoryChunked(project, memoryType, content, id, metadata, { writtenBy: caller, visibility });
}

async function updateMemory(projectName: string, memoryId: string, content?: string, metadata?: Record<string, any>, options: UpdateOptions = {}): Promise<{ version: number; private?: boolean }> {
    const caller = options.caller ?? projectName;
    const foreign = caller !== projectName;
    const notFound = () => new Error(`Memory ${memoryId} not found in project ${projectName}`);

    let visibilityDefault: Visibility = "public";
    if (foreign) {
        if (!(await bankExists(projectName))) throw notFound();
        if (options.isPrivate !== undefined) throw new Error("Only the owning project can change an entry's visibility");
        if (options.expectedVersion === undefined) {
            throw new Error("expected_version is required when updating another project's entry; read the entry first and pass its version");
        }
        if (content !== undefined && looksSecret(content)) throw new Error("Content looks like a secret; not written to another project");
        visibilityDefault = await projectVisibility(projectName);
    }
    const collectionName = foreign ? bankName(projectName) : await initMemoryBank(projectName);

    const pointId = toPointId(memoryId);
    const attempts = options.expectedVersion === undefined ? 3 : 1;
    const vectorOfNewContent = content !== undefined ? (await getCachedEmbeddings([content]))[0] : null;

    for (let attempt = 1; ; attempt++) {
        const [previous] = await client.retrieve(collectionName, { ids: [pointId], with_payload: true, with_vector: true });
        if (!previous || (foreign && !isVisibleToForeign(previous.payload, visibilityDefault))) throw notFound();

        const previousPayload = previous.payload ?? {};
        if (options.expectedVersion !== undefined && options.expectedVersion !== versionOf(previousPayload)) {
            throw new Error(conflictMessage(memoryId, previousPayload));
        }

        const nextContent = content ?? String(previousPayload.content ?? "");
        const vector = vectorOfNewContent ?? previous.vector as number[];
        const nextMetadata = metadata
            ? { ...(previousPayload.metadata as Record<string, any> ?? {}), ...metadata }
            : previousPayload.metadata ?? {};

        let visibility: Visibility | undefined = options.isPrivate !== undefined ? visibilityFromFlag(options.isPrivate) : previousPayload.visibility;
        if (content !== undefined && looksSecret(content)) visibility = "private";

        const token = uuidv4();
        const { previous: _superseded, ...basePayload } = previousPayload;
        const payload = {
            ...basePayload,
            content: nextContent,
            metadata: nextMetadata,
            timestamp: new Date().toISOString(),
            version: versionOf(previousPayload) + 1,
            written_by: caller,
            written_by_session: SESSION_ID,
            write_token: token,
            ...(visibility ? { visibility } : {}),
            ...(foreign ? { previous: snapshotOf(previousPayload) } : {})
        };

        if (foreign) await archiveSuperseded(projectName, pointId, previous.vector as number[], previousPayload);
        await client.upsert(collectionName, {
            wait: true,
            update_mode: "update_only",
            update_filter: casFilter(previousPayload),
            points: [{ id: pointId, vector, payload }]
        });

        const [written] = await client.retrieve(collectionName, { ids: [pointId], with_payload: true });
        if (!written) throw notFound();
        if (written.payload?.write_token === token) {
            cacheUtils.invalidateProjectCache(projectName);
            return { version: payload.version, ...(visibility === "private" ? { private: true } : {}) };
        }
        if (attempt >= attempts) {
            throw new Error(options.expectedVersion !== undefined
                ? conflictMessage(memoryId, written.payload ?? {})
                : `Could not update ${memoryId}: it kept changing. Re-read and retry.`);
        }
    }
}

async function deleteMemory(projectName: string, memoryIds: string[], caller: string = projectName): Promise<number> {
    if (caller !== projectName) {
        if (!(await bankExists(projectName))) return 0;
        const visibility = await projectVisibility(projectName);
        const records = await client.retrieve(bankName(projectName), { ids: memoryIds.map(toPointId), with_payload: true, with_vector: true });
        const visible = records.filter(record => isVisibleToForeign(record.payload, visibility));
        for (const record of visible) {
            await archiveDeleted(projectName, caller, record.id, record.vector as number[], record.payload ?? {});
        }
        if (visible.length > 0) {
            await client.delete(bankName(projectName), { wait: true, points: visible.map(record => record.id) });
            cacheUtils.invalidateProjectCache(projectName);
        }
        return visible.length;
    }

    const collectionName = await initMemoryBank(projectName);

    const existing = await client.retrieve(collectionName, { ids: memoryIds.map(toPointId), with_payload: false });
    if (existing.length === 0) {
        return 0;
    }

    await client.delete(collectionName, { wait: true, points: existing.map((point: { id: string | number }) => point.id) });
    cacheUtils.invalidateProjectCache(projectName);
    return existing.length;
}

async function deleteCollection(projectName: string): Promise<boolean> {
    const collectionName = `memory_bank_${projectName}`;
    const result = await client.deleteCollection(collectionName);
    await client.deleteCollection(archiveName(projectName)).catch(() => undefined);
    cacheUtils.invalidateProjectCache(projectName);
    return result;
}

// ----- Log structured memory entry (for ConPort contexts) -----
const STRUCTURED_CONTEXT_NAMESPACE = "6f9b6c1e-4c4e-5a2f-9a7c-0d1f2e3a4b5c";
const EXTERNAL_ID_NAMESPACE = "1b4d7c8a-9e2f-5b3c-8d6a-7f0e1c2b3a4d";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toPointId(externalId: string): string {
    if (UUID_RE.test(externalId)) return externalId;
    if (/^\d+$/.test(externalId)) return externalId;
    return uuidv5(externalId, EXTERNAL_ID_NAMESPACE);
}

function structuredContextId(projectName: string, contextType: string): string {
    return uuidv5(`${projectName}:${contextType}`, STRUCTURED_CONTEXT_NAMESPACE);
}

async function logStructuredMemory(projectName: string, contextType: "productContext" | "activeContext", content: string | Record<string, any>, topLevelId: string | null = null): Promise<string> {
    if (!STRUCTURED_CONTEXT_TYPES.includes(contextType)) {
        throw new Error(`Invalid structured context type: ${contextType}`);
    }

    const collectionName = await initMemoryBank(projectName);

    // Embed content - convert to string for embedding
    const contentString = typeof content === 'string' ? content : JSON.stringify(content);
    const vector = (await getEmbeddingProvider().embedTexts([contentString]))[0];

    const pointId = topLevelId || structuredContextId(projectName, contextType);

    const point = {
        id: pointId,
        vector,
        payload: {
            type: contextType,
            content: typeof content === 'string' ? content : JSON.stringify(content),
            structured: true,
            timestamp: new Date().toISOString(),
            project: projectName
        }
    };

    await client.upsert(collectionName, { wait: true, points: [point] });
    contextCache.getCache().delete(cacheKeys.structuredContext(projectName, contextType));
    return pointId;
}

// ----- Get structured context -----
async function getStructuredContext(projectName: string, contextType: "productContext" | "activeContext"): Promise<Record<string, any>> {
    if (!STRUCTURED_CONTEXT_TYPES.includes(contextType)) {
        throw new Error(`Invalid structured context type: ${contextType}`);
    }

    // Check cache first
    const cacheKey = cacheKeys.structuredContext(projectName, contextType);
    const cachedResult = cacheUtils.getCached(contextCache, cacheKey);
    if (cachedResult) {
        return cachedResult;
    }

    const collectionName = `memory_bank_${projectName}`;

    // Get the most recent entry for this context type
    let results: Array<{ payload?: Record<string, any> | null }> = await client.retrieve(collectionName, {
        ids: [structuredContextId(projectName, contextType)],
        with_payload: true,
        with_vector: false
    });

    if (results.length === 0) {
        results = (await client.query(collectionName, {
            query: (await getCachedEmbeddings([`context type: ${contextType}`]))[0],
            limit: 1,
            filter: {
                must: [
                    { key: "project", match: { value: projectName } },
                    { key: "type", match: { value: contextType } },
                    { key: "structured", match: { value: true } }
                ]
            },
            with_payload: true,
            with_vector: false
        })).points;
    }

    let contextResult: Record<string, any>;
    if (results.length === 0) {
        contextResult = {}; // Return empty object if no context exists
    } else {
        const payload = results[0].payload;
        try {
            contextResult = typeof payload?.content === 'string' ? JSON.parse(payload.content) : payload?.content;
        } catch (e) {
            contextResult = payload?.content || {}; // Return as string if not valid JSON
        }
    }

    // Cache the result
    cacheUtils.setCached(contextCache, cacheKey, contextResult);

    return contextResult;
}

// ----- Update structured context with patch -----
async function updateStructuredContext(projectName: string, contextType: "productContext" | "activeContext", patchContent: Record<string, any>): Promise<string> {
    if (!STRUCTURED_CONTEXT_TYPES.includes(contextType)) {
        throw new Error(`Invalid structured context type: ${contextType}`);
    }

    // Get current context
    const currentContext = await getStructuredContext(projectName, contextType);

    // Apply patch - merge objects
    const updatedContext = { ...currentContext, ...patchContent };

    // Handle special delete sentinel
    Object.keys(patchContent).forEach(key => {
        if (patchContent[key] === "__DELETE__") {
            delete updatedContext[key];
        }
    });

    // Log the updated context with history tracking
    const pointId = await logStructuredMemory(projectName, contextType, updatedContext);

    // Store history entry
    const historyEntry = {
        contextType,
        changes: patchContent,
        timestamp: new Date().toISOString(),
        pointId
    };

    await logMemory(projectName, "contextHistory", JSON.stringify(historyEntry));

    // Invalidate context cache
    const cacheKey = cacheKeys.structuredContext(projectName, contextType);
    contextCache.getCache().delete(cacheKey);

    return pointId;
}

// ----- Knowledge graph linking -----
const MAX_GRAPH_EDGES = 10000;

async function createKnowledgeLink(projectName: string, edges: GraphEdgeInput[]): Promise<KnowledgeLink[]> {
    const collectionName = await initMemoryBank(projectName);

    const timestamp = new Date().toISOString();
    const contents = edges.map(edge =>
        edge.description || `${edge.from_id} ${edge.relation} ${edge.to_id}`
    );
    const vectors = await getCachedEmbeddings(contents);

    const points = edges.map((edge, i) => ({
        id: uuidv4(),
        vector: vectors[i],
        payload: {
            type: "knowledgeLink",
            content: contents[i],
            metadata: {
                sourceId: toPointId(edge.from_id),
                targetId: toPointId(edge.to_id),
                linkType: edge.relation
            },
            timestamp,
            project: projectName
        }
    }));

    await client.upsert(collectionName, { wait: true, points });
    cacheUtils.invalidateProjectCache(projectName);

    return points.map(point => ({
        id: point.id,
        sourceId: point.payload.metadata.sourceId,
        targetId: point.payload.metadata.targetId,
        linkType: point.payload.metadata.linkType,
        description: point.payload.content,
        timestamp
    }));
}

async function getAllKnowledgeLinks(projectName: string, linkType: string | null = null): Promise<KnowledgeLink[]> {
    const collectionName = await initMemoryBank(projectName);

    const mustFilter: any[] = [
        { key: "project", match: { value: projectName } },
        { key: "type", match: { value: "knowledgeLink" } }
    ];
    if (linkType) mustFilter.push({ key: "metadata.linkType", match: { value: linkType } });

    const response = await client.scroll(collectionName, {
        filter: { must: mustFilter },
        limit: MAX_GRAPH_EDGES,
        with_payload: true,
        with_vector: false
    });

    return response.points.map((point: any) => ({
        id: point.id,
        sourceId: point.payload?.metadata?.sourceId,
        targetId: point.payload?.metadata?.targetId,
        linkType: point.payload?.metadata?.linkType,
        description: point.payload?.content,
        timestamp: point.payload?.timestamp
    }));
}

async function getKnowledgeLinks(projectName: string, entityId: string, linkType: string | null = null, direction: LinkDirection = "both"): Promise<KnowledgeLink[]> {
    const links = await getAllKnowledgeLinks(projectName, linkType);
    const nodeId = toPointId(entityId);
    return links.filter(link =>
        (direction !== "incoming" && link.sourceId === nodeId) ||
        (direction !== "outgoing" && link.targetId === nodeId)
    );
}

async function getNeighbors(projectName: string, entityId: string, linkType: string | null = null, depth: number = 1, direction: LinkDirection = "both"): Promise<NeighborResult[]> {
    const links = await getAllKnowledgeLinks(projectName, linkType);

    const nodeId = toPointId(entityId);
    const reached = new Map<string, { depth: number; via: string }>();
    let frontier = [nodeId];
    const seen = new Set<string>([nodeId]);

    for (let level = 1; level <= depth && frontier.length > 0; level++) {
        const next: string[] = [];
        for (const link of links) {
            const hops: [string, string][] = [];
            if (direction !== "incoming" && frontier.includes(link.sourceId)) {
                hops.push([link.targetId, link.linkType]);
            }
            if (direction !== "outgoing" && frontier.includes(link.targetId)) {
                hops.push([link.sourceId, link.linkType]);
            }
            for (const [id, relation] of hops) {
                if (seen.has(id)) continue;
                seen.add(id);
                reached.set(id, { depth: level, via: relation });
                next.push(id);
            }
        }
        frontier = next;
    }

    if (reached.size === 0) return [];

    const collectionName = await initMemoryBank(projectName);
    const points = await client.retrieve(collectionName, {
        ids: [...reached.keys()],
        with_payload: true,
        with_vector: false
    });

    return points.map((point: any) => ({
        id: String(point.id),
        depth: reached.get(String(point.id))!.depth,
        via: reached.get(String(point.id))!.via,
        content: point.payload?.content,
        type: point.payload?.type
    })).sort((a: { depth: number }, b: { depth: number }) => a.depth - b.depth);
}

async function deleteKnowledgeLinks(projectName: string, linkIds: string[]): Promise<number> {
    const collectionName = await initMemoryBank(projectName);
    await client.delete(collectionName, { points: linkIds });
    cacheUtils.invalidateProjectCache(projectName);
    return linkIds.length;
}

// ----- Get context history -----
async function getContextHistory(projectName: string, contextType: "productContext" | "activeContext", limit: number = 10): Promise<ContextHistoryEntry[]> {
    if (!STRUCTURED_CONTEXT_TYPES.includes(contextType)) {
        throw new Error(`Invalid structured context type: ${contextType}`);
    }

    const collectionName = `memory_bank_${projectName}`;

    const { points: results } = await client.query(collectionName, {
        with_payload: true,
        query: (await getEmbeddingProvider().embedTexts(["context history"]))[0],
        limit: limit * 4,
        filter: {
            must: [
                { key: "project", match: { value: projectName } },
                { key: "type", match: { value: "contextHistory" } }
            ]
        }
    });

    return results.map((hit: any) => {
        try {
            const historyData = JSON.parse(hit.payload?.content);
            if (historyData.contextType !== contextType) return null;
            return {
                id: hit.id,
                contextType: historyData.contextType,
                changes: historyData.changes,
                timestamp: historyData.timestamp,
                pointId: historyData.pointId
            };
        } catch (e) {
            return null;
        }
    }).filter((item: any): item is ContextHistoryEntry => item !== null).slice(0, limit);
}

// ----- Batch operations -----

/**
 * Batch log multiple memory entries
 * @param projectName - Name of the project
 * @param entries - Array of {memoryType, content, topLevelId} objects
 * @returns Array of logged entry IDs
 */
async function batchLogMemory(projectName: string, entries: BatchLogEntry[]): Promise<string[]> {
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error("Entries must be a non-empty array");
    }

    const collectionName = await initMemoryBank(projectName);
    const points: any[] = [];

    // Process all entries in parallel for embedding
    const embedPromises = entries.map(entry => {
        if (!MEMORY_TYPES.includes(entry.memoryType)) {
            throw new Error(`Invalid memory type: ${entry.memoryType}`);
        }
        return getCachedEmbeddings([entry.content]);
    });

    const vectors = await Promise.all(embedPromises);

    // Create points
    entries.forEach((entry, index) => {
        const pointId = entry.topLevelId ? toPointId(entry.topLevelId) : uuidv4();
        const point = {
            id: pointId,
            vector: vectors[index][0],
            payload: {
                type: entry.memoryType,
                content: entry.content,
                timestamp: new Date().toISOString(),
                project: projectName
            }
        };
        points.push(point);
    });

    await client.upsert(collectionName, { wait: true, points });
    return points.map(point => point.id);
}

// ----- System patterns management -----

/**
 * Get all system patterns for a project
 * @param projectName - Name of the project
 * @param limit - Maximum number of patterns to return
 * @returns Array of system patterns
 */
async function getSystemPatterns(projectName: string, limit: number = 50): Promise<SystemPattern[]> {
    // Check cache first
    const cacheKey = cacheKeys.systemPatterns(projectName, limit);
    const cachedResult = cacheUtils.getCached(patternCache, cacheKey);
    if (cachedResult) {
        return cachedResult;
    }

    const collectionName = `memory_bank_${projectName}`;

    const { points: results } = await client.query(collectionName, {
        with_payload: true,
        query: (await getCachedEmbeddings(["system patterns and conventions"]))[0],
        limit: limit,
        filter: {
            must: [
                { key: "project", match: { value: projectName } },
                { key: "type", match: { value: SYSTEM_PATTERN_TYPE } }
            ]
        }
    });

    const formattedResults: SystemPattern[] = results.map((hit: any) => ({
        id: hit.id,
        pattern: hit.payload?.content,
        timestamp: hit.payload?.timestamp
    }));

    // Cache the results
    cacheUtils.setCached(patternCache, cacheKey, formattedResults);

    return formattedResults;
}

// ----- Progress tracking with status updates -----

// ----- Custom data storage -----

/**
 * Initialize workspace and detect project structure
 * @param projectName - Name of the project
 * @param workspaceInfo - Workspace information (optional)
 * @returns Initialization result with detected workspace structure
 */
async function initializeWorkspace(projectName: string, workspaceInfo: WorkspaceInfo = {}): Promise<InitializationResult> {
    try {
        const collectionName = await initMemoryBank(projectName);

        // Detect workspace structure
        const workspaceStructure: WorkspaceStructure = {
            projectName,
            detectedFiles: workspaceInfo.files || [],
            detectedDirectories: workspaceInfo.directories || [],
            language: detectProjectLanguage(workspaceInfo),
            framework: detectFramework(workspaceInfo),
            timestamp: new Date().toISOString()
        };

        // Store workspace detection result
        const workspaceData = JSON.stringify(workspaceStructure);
        const vector = (await getEmbeddingProvider().embedTexts([workspaceData]))[0];

        const pointId = uuidv4();
        const point = {
            id: pointId,
            vector,
            payload: {
                type: "workspaceInit",
                content: workspaceData,
                project: projectName,
                timestamp: new Date().toISOString()
            }
        };

        await client.upsert(collectionName, { wait: true, points: [point] });

        // Initialize basic memory contexts if they don't exist
        await initializeBasicContexts(projectName);

        return {
            workspaceId: pointId,
            structure: workspaceStructure,
            initialized: true
        };
    } catch (error) {
        // Fallback: return workspace structure without storing when Qdrant is unavailable
        const workspaceStructure: WorkspaceStructure = {
            projectName,
            detectedFiles: workspaceInfo.files || [],
            detectedDirectories: workspaceInfo.directories || [],
            language: detectProjectLanguage(workspaceInfo),
            framework: detectFramework(workspaceInfo),
            timestamp: new Date().toISOString()
        };

        return {
            workspaceId: null,
            structure: workspaceStructure,
            initialized: false,
            error: "Qdrant unavailable"
        };
    }
}

/**
 * Detect project language from file extensions
 * @param workspaceInfo - Workspace information
 * @returns Detected language
 */
function detectProjectLanguage(workspaceInfo: WorkspaceInfo): string {
    const files = workspaceInfo.files || [];
    const extensions = files.map(f => f.split('.').pop()).filter((ext): ext is string => !!ext);

    const languageMap: Record<string, string> = {
        'js': 'JavaScript',
        'ts': 'TypeScript',
        'py': 'Python',
        'java': 'Java',
        'cpp': 'C++',
        'c': 'C',
        'cs': 'C#',
        'php': 'PHP',
        'rb': 'Ruby',
        'go': 'Go',
        'rs': 'Rust'
    };

    for (const ext of extensions) {
        if (languageMap[ext]) {
            return languageMap[ext];
        }
    }

    return 'Unknown';
}

/**
 * Detect framework from common files/directories
 * @param workspaceInfo - Workspace information
 * @returns Detected framework
 */
function detectFramework(workspaceInfo: WorkspaceInfo): string {
    const files = workspaceInfo.files || [];
    const directories = workspaceInfo.directories || [];

    // Node.js frameworks
    if (files.includes('package.json')) {
        if (files.includes('next.config.js') || directories.includes('pages') || directories.includes('app')) {
            return 'Next.js';
        }
        if (files.includes('nuxt.config.js')) {
            return 'Nuxt.js';
        }
        if (directories.includes('src') && files.includes('angular.json')) {
            return 'Angular';
        }
        if (files.includes('vue.config.js') || directories.includes('src') && files.some(f => f.includes('vue'))) {
            return 'Vue.js';
        }
        return 'Node.js';
    }

    // Python frameworks
    if (files.includes('requirements.txt') || files.includes('setup.py')) {
        if (directories.includes('migrations') && files.includes('manage.py')) {
            return 'Django';
        }
        if (files.includes('app.py') && directories.includes('templates')) {
            return 'Flask';
        }
        return 'Python';
    }

    // .NET
    if (files.some(f => f.endsWith('.csproj'))) {
        return '.NET';
    }

    return 'Unknown';
}

/**
 * Initialize basic memory contexts for a new project
 * @param projectName - Name of the project
 */
async function initializeBasicContexts(projectName: string): Promise<void> {
    // Check if contexts already exist
    const existingProductContext = await getStructuredContext(projectName, 'productContext');
    const existingActiveContext = await getStructuredContext(projectName, 'activeContext');

    if (!existingProductContext || Object.keys(existingProductContext).length === 0) {
        await logStructuredMemory(projectName, 'productContext', {
            projectName,
            description: `Project ${projectName} initialized`,
            goals: [],
            features: [],
            technologies: [],
            status: 'initialized'
        });
    }

    if (!existingActiveContext || Object.keys(existingActiveContext).length === 0) {
        await logStructuredMemory(projectName, 'activeContext', {
            currentFocus: `Project ${projectName} workspace initialized`,
            recentChanges: ['Workspace detection completed'],
            openQuestions: [],
            nextSteps: ['Configure project settings', 'Set up development environment']
        });
    }
}

/**
 * Export memory data to markdown format
 * @param projectName - Name of the project
 * @param memoryTypes - Types of memory to export
 * @returns Markdown formatted export
 */
async function exportMemoryToMarkdown(projectName: string, memoryTypes: MemoryType[] | null = null): Promise<string> {
    try {
        const exportData: ExportData = {
            projectName,
            exportDate: new Date().toISOString(),
            sections: {}
        };

        const typesToExport = memoryTypes || ['productContext', 'activeContext', 'systemPatterns', 'decisionLog', 'progress'] as MemoryType[];

        for (const type of typesToExport) {
            if (STRUCTURED_CONTEXT_TYPES.includes(type as any)) {
                const context = await getStructuredContext(projectName, type as "productContext" | "activeContext");
                exportData.sections[type] = context;
            } else {
                // For non-structured types, get recent entries
                const results = await queryMemory(projectName, type, type, 50);
                exportData.sections[type] = results.map(r => ({
                    content: r.content,
                    timestamp: r.timestamp
                }));
            }
        }

        // Convert to markdown
        return convertToMarkdown(exportData);
    } catch (error) {
        // Fallback: return basic markdown when Qdrant is unavailable
        const exportData: ExportData = {
            projectName,
            exportDate: new Date().toISOString(),
            sections: {
                error: "Qdrant database unavailable for export"
            }
        };

        return convertToMarkdown(exportData);
    }
}

/**
 * Import memory data from markdown
 * @param projectName - Name of the project
 * @param markdownContent - Markdown content to import
 * @returns Import results
 */
async function importMemoryFromMarkdown(projectName: string, markdownContent: string): Promise<ImportResult> {
    const importResults: ImportResult = {
        imported: 0,
        errors: [],
        timestamp: new Date().toISOString()
    };

    let parsedData: { sections: Record<string, Array<{ heading: string; content: string }>> };
    try {
        parsedData = parseMarkdownToMemory(markdownContent);
    } catch (error) {
        importResults.errors.push((error as Error).message);
        return importResults;
    }

    for (const [type, entries] of Object.entries(parsedData.sections)) {
        if (!ALL_MEMORY_TYPES.includes(type as MemoryType)) {
            importResults.errors.push(`Unknown section, skipped: ${type}`);
            continue;
        }

        try {
            if (STRUCTURED_CONTEXT_TYPES.includes(type as any)) {
                const context = entriesToStructuredObject(entries);
                if (Object.keys(context).length === 0) continue;
                await updateStructuredContext(projectName, type as "productContext" | "activeContext", context);
                importResults.imported++;
            } else {
                for (const entry of entries) {
                    const content = entry.content.replace(/\n?\*[^*\n]*\*$/, '').trim();
                    if (!content) continue;
                    await logMemory(projectName, type as MemoryType, content);
                    importResults.imported++;
                }
            }
        } catch (error) {
            importResults.errors.push(`${type}: ${(error as Error).message}`);
        }
    }

    return importResults;
}

/**
 * Convert memory data to markdown format
 * @param exportData - Data to convert
 * @returns Markdown string
 */
function convertToMarkdown(exportData: ExportData): string {
    let markdown = `# Memory Export - ${exportData.projectName}\n\n`;
    markdown += `**Export Date:** ${new Date(exportData.exportDate).toLocaleString()}\n\n`;

    for (const [section, data] of Object.entries(exportData.sections)) {
        markdown += `## ${section.charAt(0).toUpperCase() + section.slice(1)}\n\n`;

        if (Array.isArray(data)) {
            data.forEach((item: any, index: number) => {
                markdown += `### Entry ${index + 1}\n`;
                markdown += `${item.content}\n\n`;
                if (item.timestamp) {
                    markdown += `*${new Date(item.timestamp).toLocaleString()}*\n\n`;
                }
            });
        } else if (typeof data === 'object') {
            for (const [key, value] of Object.entries(data)) {
                markdown += `### ${key}\n`;
                if (Array.isArray(value)) {
                    markdown += value.map(v => `- ${v}`).join('\n') + '\n\n';
                } else {
                    markdown += `${value}\n\n`;
                }
            }
        }

        markdown += '---\n\n';
    }

    return markdown;
}

/**
 * Parse markdown back to memory structure
 * @param markdown - Markdown content
 * @returns Parsed memory data
 */
const ALL_MEMORY_TYPES: MemoryType[] = [
    "productContext",
    "activeContext",
    "systemPatterns",
    "decisionLog",
    "progress",
    "contextHistory",
    "customData"
];

function canonicalMemoryType(heading: string): MemoryType | null {
    const normalized = heading.trim().toLowerCase().replace(/\s+/g, '');
    return ALL_MEMORY_TYPES.find(t => t.toLowerCase() === normalized) ?? null;
}

function parseMarkdownToMemory(markdown: string): { sections: Record<string, Array<{ heading: string; content: string }>> } {
    const sections: Record<string, Array<{ heading: string; content: string }>> = {};
    const lines = markdown.split('\n');
    let currentSection: string | null = null;
    let currentEntry: { heading: string; content: string } | null = null;

    for (const line of lines) {
        if (line.startsWith('## ')) {
            const type = canonicalMemoryType(line.substring(3));
            currentSection = type ?? line.substring(3).trim();
            currentEntry = null;
            sections[currentSection] = [];
        } else if (line.startsWith('### ') && currentSection) {
            currentEntry = { heading: line.substring(4).trim(), content: '' };
            sections[currentSection].push(currentEntry);
        } else if (currentEntry && line.trim()) {
            currentEntry.content = currentEntry.content
                ? currentEntry.content + '\n' + line
                : line;
        }
    }

    return { sections };
}

function entriesToStructuredObject(entries: Array<{ heading: string; content: string }>): Record<string, any> {
    const result: Record<string, any> = {};
    for (const entry of entries) {
        const lines = entry.content.split('\n').filter(l => l.trim());
        if (lines.length > 0 && lines.every(l => l.trimStart().startsWith('- '))) {
            result[entry.heading] = lines.map(l => l.trimStart().slice(2));
        } else {
            result[entry.heading] = entry.content;
        }
    }
    return result;
}

export {
    logMemory,
    queryMemory,
    listMemory,
    logMemoryChunked,
    searchHive,
    createMemory,
    toPointId,
    updateMemory,
    deleteMemory,
    deleteCollection,
    logStructuredMemory,
    getStructuredContext,
    updateStructuredContext,
    createKnowledgeLink,
    getKnowledgeLinks,
    getNeighbors,
    deleteKnowledgeLinks,
    getContextHistory,
    batchLogMemory,
    getSystemPatterns,
    initializeWorkspace,
    exportMemoryToMarkdown,
    importMemoryFromMarkdown
};
