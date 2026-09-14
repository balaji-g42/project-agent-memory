import { initMemoryBank, client } from "../init.js";
import { v4 as uuidv4, v5 as uuidv5 } from "uuid";
import { embeddingCache, queryCache, contextCache, patternCache, cacheKeys, cacheUtils } from "../cache.js";
import type { 
    MemoryType, 
    BatchLogEntry, 
    BatchQuery, 
    BatchContextUpdate,
    WorkspaceInfo,
    SyncSource,
    ProgressStatus,
    Priority,
    LinkDirection
} from "../types.js";

import { getEmbeddingProvider } from "../embeddings.js";

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
const STRUCTURED_CONTEXT_TYPES: ("productContext" | "activeContext")[] = ["productContext", "activeContext"];
const DECISION_TYPE: MemoryType = "decisionLog";
const PROGRESS_TYPE: MemoryType = "progress";
const SYSTEM_PATTERN_TYPE: MemoryType = "systemPatterns";
const CUSTOM_DATA_TYPE: MemoryType = "customData";

// Interface definitions for return types
interface QueryResult {
    id: string | number;
    score: number;
    content: string;
    type: string;
    timestamp: string;
    metadata: Record<string, any>;
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

interface DecisionResult {
    id: string | number;
    summary: string;
    timestamp: string;
}

interface SemanticSearchResult {
    id: string | number;
    score: number;
    content: string;
    type: string;
    timestamp: string;
    structured: boolean;
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
    previousVersion: any;
    newVersion: any;
    changes: Record<string, any>;
    timestamp: string;
    pointId: string;
}

interface ProgressEntry {
    id: string | number;
    content: string;
    status: string;
    category: string;
    priority: string;
    timestamp: string;
}

interface ProgressSearchResult extends ProgressEntry {
    score: number;
}

interface SystemPattern {
    id: string | number;
    pattern: string;
    timestamp: string;
}

interface SystemPatternSearchResult extends SystemPattern {
    score: number;
}

interface CustomDataEntry {
    id: string | number;
    dataType: string;
    data: any;
    metadata: Record<string, any>;
    timestamp: string;
}

interface CustomDataSearchResult extends CustomDataEntry {
    score: number;
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

interface SyncSourceResult {
    source: string;
    entries: number;
    success: boolean;
}

interface SyncResultError {
    source: string;
    error: string;
}

interface SyncResult {
    timestamp: string;
    sources: SyncSourceResult[];
    totalEntries: number;
    errors: SyncResultError[];
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

interface CacheStats {
    embeddingCache: {
        size: number;
        maxSize: number;
    };
    queryCache: {
        size: number;
        maxSize: number;
    };
    contextCache: {
        size: number;
        maxSize: number;
    };
    patternCache: {
        size: number;
        maxSize: number;
    };
}

// ----- Log memory entry -----
async function logMemory(projectName: string, memoryType: MemoryType, content: string, topLevelId: string | null = null, metadata: Record<string, any> = {}): Promise<string> {
    if (!MEMORY_TYPES.includes(memoryType)) {
        throw new Error(`Invalid memory type: ${memoryType}`);
    }

    const collectionName = await initMemoryBank(projectName);

    // Embed content with caching
    const vectors = await getCachedEmbeddings([content]);
    const vector = vectors[0];

    const pointId = topLevelId ? toPointId(topLevelId) : uuidv4();

    const point = {
        id: pointId,
        vector,
        payload: {
            type: memoryType,
            content,
            metadata,
            timestamp: new Date().toISOString(),
            project: projectName
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

    const results = await client.search(collectionName, {
        vector,
        limit: topK,
        filter: { must: mustFilter }
    });

    const formattedResults: QueryResult[] = results.map((hit: any) => ({
        id: hit.id,
        score: hit.score,
        content: hit.payload?.content,
        type: hit.payload?.type,
        timestamp: hit.payload?.timestamp,
        metadata: hit.payload?.metadata ?? {}
    }));

    // Cache the results
    cacheUtils.setCached(queryCache, cacheKey, formattedResults);

    return formattedResults;
}

async function listMemory(projectName: string, memoryType: string | null = null, limit: number = 20, metadataFilter: Record<string, any> | null = null): Promise<QueryResult[]> {
    const collectionName = await initMemoryBank(projectName);

    const mustFilter: any[] = [{ key: "project", match: { value: projectName } }];
    if (memoryType) mustFilter.push({ key: "type", match: { value: memoryType } });
    mustFilter.push(...metadataFilterClauses(metadataFilter));

    const response = await client.scroll(collectionName, {
        filter: { must: mustFilter },
        limit,
        with_payload: true,
        with_vector: false
    });

    return response.points
        .map((point: any) => ({
            id: point.id,
            score: 0,
            content: point.payload?.content,
            type: point.payload?.type,
            timestamp: point.payload?.timestamp,
            metadata: point.payload?.metadata ?? {}
        }))
        .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

async function updateMemory(projectName: string, memoryId: string, content?: string, metadata?: Record<string, any>): Promise<boolean> {
    const collectionName = await initMemoryBank(projectName);

    const pointId = toPointId(memoryId);
    const existing = await client.retrieve(collectionName, { ids: [pointId], with_payload: true, with_vector: true });
    if (existing.length === 0) {
        throw new Error(`Memory ${memoryId} not found in project ${projectName}`);
    }

    const previous = existing[0];
    const nextContent = content ?? String(previous.payload?.content ?? "");
    const vector = content !== undefined
        ? (await getCachedEmbeddings([content]))[0]
        : previous.vector as number[];

    const nextMetadata = metadata
        ? { ...(previous.payload?.metadata as Record<string, any> ?? {}), ...metadata }
        : previous.payload?.metadata ?? {};

    await client.upsert(collectionName, {
        wait: true,
        points: [{
            id: pointId,
            vector,
            payload: {
                ...previous.payload,
                content: nextContent,
                metadata: nextMetadata,
                timestamp: new Date().toISOString()
            }
        }]
    });

    cacheUtils.invalidateProjectCache(projectName);
    return true;
}

async function deleteMemory(projectName: string, memoryIds: string[]): Promise<number> {
    const collectionName = await initMemoryBank(projectName);

    const existing = await client.retrieve(collectionName, { ids: memoryIds.map(toPointId), with_payload: false });
    if (existing.length === 0) {
        return 0;
    }

    await client.delete(collectionName, { wait: true, points: existing.map(point => point.id) });
    cacheUtils.invalidateProjectCache(projectName);
    return existing.length;
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
        results = await client.search(collectionName, {
            vector: (await getCachedEmbeddings([`context type: ${contextType}`]))[0],
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
        });
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
        previousVersion: currentContext,
        newVersion: updatedContext,
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

// ----- Get decisions with structured format -----
async function getDecisions(projectName: string, limit: number = 10, _tags_filter_include_all: string[] = [], _tags_filter_include_any: string[] = []): Promise<DecisionResult[]> {
    const collectionName = `memory_bank_${projectName}`;

    // Build filter
    const mustFilter: any[] = [
        { key: "project", match: { value: projectName } },
        { key: "type", match: { value: DECISION_TYPE } }
    ];

    // For now, we'll implement basic filtering - tags would need additional payload structure
    const results = await client.search(collectionName, {
        vector: (await getEmbeddingProvider().embedTexts(["decisions"]))[0],
        limit: limit,
        filter: { must: mustFilter }
    });

    return results.map((hit: any) => ({
        id: hit.id,
        summary: hit.payload?.content,
        timestamp: hit.payload?.timestamp
    }));
}

// ----- Search decisions with full-text search simulation -----
async function searchDecisionsFTS(projectName: string, queryTerm: string, limit: number = 10): Promise<DecisionResult[]> {
    const collectionName = `memory_bank_${projectName}`;

    // Use semantic search with the query term
    const vector = (await getEmbeddingProvider().embedTexts([queryTerm]))[0];

    const results = await client.search(collectionName, {
        vector,
        limit: limit,
        filter: {
            must: [
                { key: "project", match: { value: projectName } },
                { key: "type", match: { value: DECISION_TYPE } }
            ]
        }
    });

    return results.map((hit: any) => ({
        id: hit.id,
        summary: hit.payload?.content,
        score: hit.score,
        timestamp: hit.payload?.timestamp
    }));
}

// ----- Semantic search across all memory types -----
async function semanticSearch(projectName: string, queryText: string, limit: number = 10, memoryTypes: string[] | null = null): Promise<SemanticSearchResult[]> {
    const collectionName = `memory_bank_${projectName}`;

    const vector = (await getEmbeddingProvider().embedTexts([queryText]))[0];

    // Build filter
    const mustFilter: any[] = [{ key: "project", match: { value: projectName } }];
    if (memoryTypes && memoryTypes.length > 0) {
        mustFilter.push({
            key: "type",
            match: { any: memoryTypes }
        });
    }

    const results = await client.search(collectionName, {
        vector,
        limit: limit,
        filter: { must: mustFilter }
    });

    return results.map((hit: any) => ({
        id: hit.id,
        score: hit.score,
        content: hit.payload?.content,
        type: hit.payload?.type,
        timestamp: hit.payload?.timestamp,
        structured: hit.payload?.structured || false
    }));
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
    })).sort((a, b) => a.depth - b.depth);
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

    const results = await client.search(collectionName, {
        vector: (await getEmbeddingProvider().embedTexts(["context history"]))[0],
        limit: limit,
        filter: {
            must: [
                { key: "project", match: { value: projectName } },
                { key: "type", match: { value: "contextHistory" } },
                { key: "contextType", match: { value: contextType } }
            ]
        }
    });

    return results.map((hit: any) => {
        try {
            const historyData = JSON.parse(hit.payload?.content);
            return {
                id: hit.id,
                contextType: historyData.contextType,
                previousVersion: historyData.previousVersion,
                newVersion: historyData.newVersion,
                changes: historyData.changes,
                timestamp: historyData.timestamp,
                pointId: historyData.pointId
            };
        } catch (e) {
            return null;
        }
    }).filter((item: any): item is ContextHistoryEntry => item !== null);
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

/**
 * Batch query memory with multiple queries
 * @param projectName - Name of the project
 * @param queries - Array of {queryText, memoryType, topK} objects
 * @returns Array of query results
 */
async function batchQueryMemory(projectName: string, queries: BatchQuery[]): Promise<QueryResult[][]> {
    if (!Array.isArray(queries) || queries.length === 0) {
        throw new Error("Queries must be a non-empty array");
    }

    try {
        // Initialize memory bank - this can fail if Qdrant is unavailable
        const collectionName = await initMemoryBank(projectName);

        // Process all queries in parallel
        const queryPromises = queries.map(async (query) => {
            const vectors = await getCachedEmbeddings([query.queryText]);
            const vector = vectors[0];

            // Build filter
            const mustFilter: any[] = [{ key: "project", match: { value: projectName } }];
            if (query.memoryType) mustFilter.push({ key: "type", match: { value: query.memoryType } });

            const results = await client.search(collectionName, {
                vector,
                limit: query.topK || 5,
                filter: { must: mustFilter }
            });

            return results.map((hit: any) => ({
                id: hit.id,
                score: hit.score,
                content: hit.payload?.content,
                type: hit.payload?.type,
                timestamp: hit.payload?.timestamp,
                metadata: hit.payload?.metadata ?? {}
            }));
        });

        return await Promise.all(queryPromises);
    } catch (error) {
        // Fallback: return empty results when Qdrant is unavailable
        return queries.map(() => []);
    }
}

/**
 * Batch update multiple structured contexts
 * @param projectName - Name of the project
 * @param updates - Array of {contextType, patchContent} objects
 * @returns Array of update result IDs
 */
async function batchUpdateStructuredContext(projectName: string, updates: BatchContextUpdate[]): Promise<string[]> {
    if (!Array.isArray(updates) || updates.length === 0) {
        throw new Error("Updates must be a non-empty array");
    }

    const results: string[] = [];

    // Process updates sequentially to avoid conflicts
    for (const update of updates) {
        if (!STRUCTURED_CONTEXT_TYPES.includes(update.contextType)) {
            throw new Error(`Invalid structured context type: ${update.contextType}`);
        }

        const resultId = await updateStructuredContext(projectName, update.contextType, update.patchContent);
        results.push(resultId);
    }

    return results;
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
    const cacheKey = cacheKeys.systemPatterns(projectName);
    const cachedResult = cacheUtils.getCached(patternCache, cacheKey);
    if (cachedResult) {
        return cachedResult.slice(0, limit); // Return cached results up to limit
    }

    const collectionName = `memory_bank_${projectName}`;

    const results = await client.search(collectionName, {
        vector: (await getCachedEmbeddings(["system patterns and conventions"]))[0],
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

/**
 * Update or add system patterns
 * @param projectName - Name of the project
 * @param patterns - Array of pattern strings to add/update
 * @returns Array of logged pattern IDs
 */
async function updateSystemPatterns(projectName: string, patterns: string[]): Promise<string[]> {
    if (!Array.isArray(patterns) || patterns.length === 0) {
        throw new Error("Patterns must be a non-empty array");
    }

    const collectionName = await initMemoryBank(projectName);
    const ids: string[] = [];

    for (const pattern of patterns) {
        const vectors = await getCachedEmbeddings([pattern]);
        const vector = vectors[0];

        const pointId = uuidv4();
        const point = {
            id: pointId,
            vector,
            payload: {
                type: SYSTEM_PATTERN_TYPE,
                content: pattern,
                timestamp: new Date().toISOString(),
                project: projectName
            }
        };

        await client.upsert(collectionName, { wait: true, points: [point] });
        ids.push(pointId);
    }

    // Invalidate pattern cache
    const cacheKey = cacheKeys.systemPatterns(projectName);
    patternCache.getCache().delete(cacheKey);

    return ids;
}

/**
 * Search system patterns using semantic search
 * @param projectName - Name of the project
 * @param queryText - Query for finding relevant patterns
 * @param limit - Maximum number of results to return
 * @returns Array of matching patterns with scores
 */
async function searchSystemPatterns(projectName: string, queryText: string, limit: number = 10): Promise<SystemPatternSearchResult[]> {
    const collectionName = `memory_bank_${projectName}`;

    const vector = (await getEmbeddingProvider().embedTexts([queryText]))[0];

    const results = await client.search(collectionName, {
        vector,
        limit: limit,
        filter: {
            must: [
                { key: "project", match: { value: projectName } },
                { key: "type", match: { value: SYSTEM_PATTERN_TYPE } }
            ]
        }
    });

    return results.map((hit: any) => ({
        id: hit.id,
        pattern: hit.payload?.content,
        score: hit.score,
        timestamp: hit.payload?.timestamp
    }));
}

// ----- Progress tracking with status updates -----

/**
 * Get progress entries with status information
 * @param projectName - Name of the project
 * @param status - Optional status filter ('pending', 'in_progress', 'completed', 'blocked')
 * @param limit - Maximum number of entries to return
 * @returns Array of progress entries with status
 */
async function getProgressWithStatus(projectName: string, status: ProgressStatus | null = null, limit: number = 50): Promise<ProgressEntry[]> {
    const collectionName = `memory_bank_${projectName}`;

    const mustFilter: any[] = [
        { key: "project", match: { value: projectName } },
        { key: "type", match: { value: PROGRESS_TYPE } }
    ];

    if (status) {
        mustFilter.push({ key: "status", match: { value: status } });
    }

    const results = await client.search(collectionName, {
        vector: (await getEmbeddingProvider().embedTexts(["progress tracking"]))[0],
        limit: limit,
        filter: { must: mustFilter }
    });

    return results.map((hit: any) => ({
        id: hit.id,
        content: hit.payload?.content,
        status: hit.payload?.status || "unknown",
        category: hit.payload?.category || "general",
        priority: hit.payload?.priority || "medium",
        timestamp: hit.payload?.timestamp
    }));
}

/**
 * Update progress with status tracking
 * @param projectName - Name of the project
 * @param content - Progress content
 * @param status - Status ('pending', 'in_progress', 'completed', 'blocked')
 * @param category - Category of the progress item
 * @param priority - Priority level ('low', 'medium', 'high', 'critical')
 * @returns ID of the logged progress entry
 */
async function updateProgressWithStatus(projectName: string, content: string, status: ProgressStatus = "in_progress", category: string = "general", priority: Priority = "medium"): Promise<string> {
    const collectionName = await initMemoryBank(projectName);

    const vector = (await getEmbeddingProvider().embedTexts([content]))[0];

    const pointId = uuidv4();
    const point = {
        id: pointId,
        vector,
        payload: {
            type: PROGRESS_TYPE,
            content,
            status,
            category,
            priority,
            timestamp: new Date().toISOString(),
            project: projectName
        }
    };

    await client.upsert(collectionName, { wait: true, points: [point] });
    return pointId;
}

/**
 * Search progress entries using semantic search
 * @param projectName - Name of the project
 * @param queryText - Query for finding relevant progress entries
 * @param status - Optional status filter
 * @param limit - Maximum number of results to return
 * @returns Array of matching progress entries with scores
 */
async function searchProgressEntries(projectName: string, queryText: string, status: ProgressStatus | null = null, limit: number = 10): Promise<ProgressSearchResult[]> {
    const collectionName = `memory_bank_${projectName}`;

    const vector = (await getEmbeddingProvider().embedTexts([queryText]))[0];

    const mustFilter: any[] = [
        { key: "project", match: { value: projectName } },
        { key: "type", match: { value: PROGRESS_TYPE } }
    ];

    if (status) {
        mustFilter.push({ key: "status", match: { value: status } });
    }

    const results = await client.search(collectionName, {
        vector,
        limit: limit,
        filter: { must: mustFilter }
    });

    return results.map((hit: any) => ({
        id: hit.id,
        content: hit.payload?.content,
        status: hit.payload?.status || "unknown",
        category: hit.payload?.category || "general",
        priority: hit.payload?.priority || "medium",
        score: hit.score,
        timestamp: hit.payload?.timestamp
    }));
}

// ----- Custom data storage -----

/**
 * Store custom data with metadata
 * @param projectName - Name of the project
 * @param data - The custom data to store
 * @param dataType - Type/category of the custom data
 * @param metadata - Additional metadata (optional)
 * @returns ID of the stored data
 */
async function storeCustomData(projectName: string, data: any, dataType: string, metadata: Record<string, any> = {}): Promise<string> {
    const collectionName = await initMemoryBank(projectName);

    const dataString = typeof data === 'string' ? data : JSON.stringify(data);
    const vector = (await getEmbeddingProvider().embedTexts([dataString]))[0];

    const pointId = metadata.id || uuidv4();
    const point = {
        id: pointId,
        vector,
        payload: {
            type: CUSTOM_DATA_TYPE,
            dataType,
            data: dataString,
            metadata: JSON.stringify(metadata),
            timestamp: new Date().toISOString(),
            project: projectName,
            customDataId: pointId
        }
    };

    await client.upsert(collectionName, { wait: true, points: [point] });
    return pointId;
}

/**
 * Get custom data by ID
 * @param projectName - Name of the project
 * @param dataId - ID of the custom data
 * @returns The custom data object or null if not found
 */
async function getCustomData(projectName: string, dataId: string): Promise<CustomDataEntry | null> {
    try {
        // Use queryCustomData to get all custom data, then filter by ID
        const allCustomData = await queryCustomData(projectName, null, {}, 100); // Get up to 100 items

        // Find the specific item by ID
        const foundItem = allCustomData.find(item => item.id === dataId);

        return foundItem || null;
    } catch (error) {
        // Fallback: return null when Qdrant is unavailable
        return null;
    }
}

/**
 * Query custom data with filters
 * @param projectName - Name of the project
 * @param dataType - Optional data type filter
 * @param metadataFilter - Optional metadata filters
 * @param limit - Maximum number of results
 * @returns Array of custom data objects
 */
async function queryCustomData(projectName: string, dataType: string | null = null, _metadataFilter: Record<string, any> = {}, limit: number = 50): Promise<CustomDataEntry[]> {
    const collectionName = `memory_bank_${projectName}`;

    const mustFilter: any[] = [
        { key: "project", match: { value: projectName } },
        { key: "type", match: { value: CUSTOM_DATA_TYPE } }
    ];

    if (dataType) {
        mustFilter.push({ key: "dataType", match: { value: dataType } });
    }

    // Note: Complex metadata filtering would require more advanced payload structure
    // For now, we'll use basic filtering

    const results = await client.search(collectionName, {
        vector: (await getEmbeddingProvider().embedTexts(["custom data query"]))[0],
        limit: limit,
        filter: { must: mustFilter }
    });

    return results.map((hit: any) => {
        let parsedData: any;
        try {
            parsedData = JSON.parse(hit.payload?.data);
        } catch (e) {
            parsedData = hit.payload?.data;
        }

        let parsedMetadata: Record<string, any> = {};
        try {
            parsedMetadata = JSON.parse(hit.payload?.metadata);
        } catch (e) {
            // metadata might not be JSON
        }

        return {
            id: hit.id,
            dataType: hit.payload?.dataType,
            data: parsedData,
            metadata: parsedMetadata,
            timestamp: hit.payload?.timestamp
        };
    });
}

/**
 * Search custom data using semantic search
 * @param projectName - Name of the project
 * @param queryText - Query for finding relevant custom data
 * @param dataType - Optional data type filter
 * @param limit - Maximum number of results
 * @returns Array of matching custom data with scores
 */
async function searchCustomData(projectName: string, queryText: string, dataType: string | null = null, limit: number = 10): Promise<CustomDataSearchResult[]> {
    const collectionName = `memory_bank_${projectName}`;

    const vector = (await getEmbeddingProvider().embedTexts([queryText]))[0];

    const mustFilter: any[] = [
        { key: "project", match: { value: projectName } },
        { key: "type", match: { value: CUSTOM_DATA_TYPE } }
    ];

    if (dataType) {
        mustFilter.push({ key: "dataType", match: { value: dataType } });
    }

    const results = await client.search(collectionName, {
        vector,
        limit: limit,
        filter: { must: mustFilter }
    });

    return results.map((hit: any) => {
        let parsedData: any;
        try {
            parsedData = JSON.parse(hit.payload?.data);
        } catch (e) {
            parsedData = hit.payload?.data;
        }

        let parsedMetadata: Record<string, any> = {};
        try {
            parsedMetadata = JSON.parse(hit.payload?.metadata);
        } catch (e) {
            // metadata might not be JSON
        }

        return {
            id: hit.id,
            dataType: hit.payload?.dataType,
            data: parsedData,
            metadata: parsedMetadata,
            score: hit.score,
            timestamp: hit.payload?.timestamp
        };
    });
}

/**
 * Update custom data
 * @param projectName - Name of the project
 * @param dataId - ID of the data to update
 * @param newData - New data to store
 * @param newMetadata - Updated metadata (optional)
 * @returns Success status
 */
async function updateCustomData(projectName: string, dataId: string, newData: any, newMetadata: Record<string, any> = {}): Promise<boolean> {
    const collectionName = `memory_bank_${projectName}`;

    const dataString = typeof newData === 'string' ? newData : JSON.stringify(newData);
    const vector = (await getEmbeddingProvider().embedTexts([dataString]))[0];

    const point = {
        id: dataId,
        vector,
        payload: {
            type: CUSTOM_DATA_TYPE,
            data: dataString,
            metadata: JSON.stringify(newMetadata),
            timestamp: new Date().toISOString(),
            project: projectName,
            customDataId: dataId
        }
    };

    await client.upsert(collectionName, { wait: true, points: [point] });
    return true;
}

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
 * Sync memory with external sources (proactive logging)
 * @param projectName - Name of the project
 * @param syncSources - Array of sync source configurations
 * @returns Sync results
 */
async function syncMemory(projectName: string, syncSources: SyncSource[] = []): Promise<SyncResult> {
    const syncResults: SyncResult = {
        timestamp: new Date().toISOString(),
        sources: [],
        totalEntries: 0,
        errors: []
    };

    for (const source of syncSources) {
        try {
            const result = await syncFromSource(projectName, source);
            syncResults.sources.push({
                source: source.name,
                entries: result.entries,
                success: true
            });
            syncResults.totalEntries += result.entries;
        } catch (error) {
            syncResults.errors.push({
                source: source.name,
                error: (error as Error).message
            });
        }
    }

    // Log sync operation
    await logMemory(projectName, 'systemPatterns', `Memory sync completed: ${syncResults.totalEntries} entries from ${syncResults.sources.length} sources`);

    return syncResults;
}

/**
 * Sync from a specific source (placeholder for external integrations)
 * @param projectName - Name of the project
 * @param source - Source configuration
 * @returns Sync result for this source
 */
async function syncFromSource(projectName: string, source: SyncSource): Promise<{ entries: number }> {
    // This is a placeholder for actual sync implementations
    // Could be GitHub issues, Jira tickets, Slack messages, etc.

    const entries: Array<{ type: MemoryType; content: string; category?: string }> = [];

    // Example: sync from Git commits (placeholder)
    if (source.type === 'git') {
        // Placeholder - would actually fetch git history
        entries.push({
            type: 'progress',
            content: `Synced git history from ${source.config?.repository || 'repository'}`,
            category: 'development'
        });
    }

    // Log the entries
    if (entries.length > 0) {
        await batchLogMemory(projectName, entries.map(entry => ({
            memoryType: entry.type,
            content: entry.content
        })));
    }

    return { entries: entries.length };
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

/**
 * Get cache performance statistics
 * @returns Cache statistics
 */
function getCacheStats(): CacheStats {
    return cacheUtils.getStats();
}

export {
    logMemory,
    queryMemory,
    listMemory,
    updateMemory,
    deleteMemory,
    logStructuredMemory,
    getStructuredContext,
    updateStructuredContext,
    getDecisions,
    searchDecisionsFTS,
    semanticSearch,
    createKnowledgeLink,
    getKnowledgeLinks,
    getNeighbors,
    deleteKnowledgeLinks,
    getContextHistory,
    batchLogMemory,
    batchQueryMemory,
    batchUpdateStructuredContext,
    getSystemPatterns,
    updateSystemPatterns,
    searchSystemPatterns,
    getProgressWithStatus,
    updateProgressWithStatus,
    searchProgressEntries,
    storeCustomData,
    getCustomData,
    queryCustomData,
    searchCustomData,
    updateCustomData,
    initializeWorkspace,
    syncMemory,
    exportMemoryToMarkdown,
    importMemoryFromMarkdown,
    getCacheStats
};
