// Qdrant client initialization and helper functions
import { QdrantClient } from "@qdrant/js-client-rest";
import { v4 as uuidv4 } from "uuid";
import config from "./config.js";
import { PrestVectorClient } from "./backends/prest.js";
import type { MemoryType, VectorClient } from "./types.js";

const MEMORY_TYPES: MemoryType[] = [
    "productContext", 
    "activeContext", 
    "systemPatterns", 
    "decisionLog", 
    "progress", 
    "contextHistory", 
    "customData"
];

// Map string to Qdrant distance
const DISTANCE_MAP: Record<string, string> = {
    Cosine: "Cosine",
    Euclid: "Euclid",
    Dot: "Dot",
};

const client: VectorClient = config.MEMORY_BACKEND === "postgres"
    ? new PrestVectorClient()
    : new QdrantClient({
        url: config.QDRANT_URL,
        port: 443,
        apiKey: config.QDRANT_API_KEY || undefined,
        // @ts-ignore - checkCompatibility may not be in the types but is valid
        checkCompatibility: false
    }) as unknown as VectorClient;

function readVectorSize(params: unknown): number | undefined {
    const vectors = (params as { vectors?: unknown })?.vectors;
    if (!vectors || typeof vectors !== "object") return undefined;
    const size = (vectors as { size?: unknown }).size;
    return typeof size === "number" ? size : undefined;
}

async function createMemoryBank(projectName: string): Promise<string> {
    const collectionName = `memory_bank_${projectName}`;
    await client.createCollection(collectionName, {
        vectors: {
            size: config.VECTOR_DIM as number,
            distance: (DISTANCE_MAP[config.DISTANCE_METRIC] || "Cosine") as "Cosine"
        }
    });

    // Insert placeholder points for each memory type
    const points = MEMORY_TYPES.map(memType => ({
        id: uuidv4(),
        vector: Array(config.VECTOR_DIM).fill(0),
        payload: {
            type: memType,
            content: `Initial placeholder for ${memType}`,
            timestamp: new Date().toISOString(),
            project: projectName,
        }
    }));

    await client.upsert(collectionName, { wait: true, points });
    return collectionName;
}

async function initMemoryBank(projectName: string): Promise<string> {
    const collectionName = `memory_bank_${projectName}`;

    // Check if collection exists
    const existingCollections = await client.getCollections();
    const exists = existingCollections.collections.some((c: { name: string }) => c.name === collectionName);

    if (exists) {
        const info = await client.getCollection(collectionName);
        const currentSize = readVectorSize(info.config?.params);
        if (currentSize !== undefined && currentSize !== config.VECTOR_DIM) {
            throw new Error(
                `Collection ${collectionName} has vector size ${currentSize} but VECTOR_DIM=${config.VECTOR_DIM}. ` +
                `Nothing was changed. To keep using it, set VECTOR_DIM=${currentSize} with the same ` +
                `EMBEDDING_PROVIDER/EMBEDDING_MODEL that created it. To switch models, migrate the data first ` +
                `(see "Migrating from memory-qdrant-mcp v2.x" in the README), or delete the collection yourself ` +
                `with memory_admin op=delete_collection.`
            );
        }
    }

    if (!exists) {
        if (!config.AUTO_CREATE_COLLECTIONS) {
            throw new Error(
                `Memory bank ${collectionName} does not exist. Nothing was created. Ask the user whether ` +
                `project "${projectName}" is the right name (case-sensitive) and whether to create a new ` +
                `memory bank for it. Only after the user confirms, call memory_admin op=create_collection ` +
                `with project_name="${projectName}", then retry.`
            );
        }
        await createMemoryBank(projectName);
    }

    return collectionName;
}

export { initMemoryBank, createMemoryBank, client, readVectorSize };
