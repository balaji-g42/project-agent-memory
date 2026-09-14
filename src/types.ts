// Type definitions for the project-agent-memory project

export interface Config {
    PORT: number;
    VECTOR_DIM: number;
    DISTANCE_METRIC: string;
    EMBEDDING_PROVIDER: string;
    EMBEDDING_MODEL: string;
    SUMMARIZER_PROVIDER: string;
    SUMMARIZER_MODEL: string;
    GEMINI_API_KEY: string;
    OPENROUTER_API_KEY: string;
    OLLAMA_API_URL: string;
    OLLAMA_API_KEY: string;
    ONNX_MODEL_CACHE_DIR: string;
    ONNX_DTYPE: string;
    OPENAI_BASE_URL: string;
    OPENAI_API_KEY: string;
    QDRANT_URL: string;
    QDRANT_API_KEY: string | null;
    POOL_SIZE: number;
    MEMORY_BACKEND: string;
    POSTGRES_URL: string;
    POSTGRES_PASSWORD: string | null;
    PREST_URL: string | null;
    PREST_JWT_KEY: string | null;
    PREST_REGISTER_ADMIN: string;
    PREST_DATABASE: string;
    CACHE_TTL_SECONDS: number;
    EMBEDDING_CACHE_SIZE: number;
    QUERY_CACHE_SIZE: number;
}

export interface CacheItem<T> {
    value: T;
    expiry: number;
}

export interface QdrantPoint {
    id: string;
    vector: number[];
    payload: Record<string, any>;
}

export type VectorFilter = { must?: Array<{ key: string; match: { value?: any; any?: any[] } }> } | null | undefined;

export interface VectorPoint {
    id: string | number;
    vector: number[];
    payload?: Record<string, any> | null;
}

export interface VectorClient {
    getCollections(): Promise<{ collections: Array<{ name: string }> }>;
    getCollection(name: string): Promise<any>;
    createCollection(name: string, options: { vectors: { size: number; distance: string } }): Promise<any>;
    deleteCollection(name: string): Promise<any>;
    upsert(name: string, options: { wait?: boolean; points: VectorPoint[] }): Promise<any>;
    retrieve(
        name: string,
        options: { ids: Array<string | number>; with_payload?: boolean; with_vector?: boolean }
    ): Promise<Array<{ id: string | number; payload?: Record<string, any>; vector?: number[] }>>;
    search(
        name: string,
        options: { vector: number[]; limit?: number; filter?: VectorFilter; with_payload?: boolean; with_vector?: boolean }
    ): Promise<Array<{ id: string | number; score: number; payload?: Record<string, any> }>>;
    scroll(
        name: string,
        options: { filter?: VectorFilter; limit?: number; with_payload?: boolean; with_vector?: boolean }
    ): Promise<{ points: Array<{ id: string | number; payload?: Record<string, any> }>; next_page_offset: unknown }>;
    delete(name: string, options: { wait?: boolean; points: Array<string | number> }): Promise<any>;
}

export interface SearchResult {
    id: string | number;
    score: number;
    payload?: Record<string, any>;
}

export interface MemoryEntry {
    id: string;
    type: string;
    content: string;
    timestamp: string;
    project: string;
    topLevelId?: string;
}

export type MemoryType = 
    | "productContext" 
    | "activeContext" 
    | "systemPatterns" 
    | "decisionLog" 
    | "progress" 
    | "contextHistory"
    | "customData"
    | "knowledgeLink";

export interface BatchLogEntry {
    memoryType: MemoryType;
    content: string;
    topLevelId?: string;
}

export interface BatchQuery {
    queryText: string;
    memoryType?: string;
    topK?: number;
}

export interface BatchContextUpdate {
    contextType: "productContext" | "activeContext";
    patchContent: Record<string, any>;
}

export interface SyncSource {
    name: string;
    type: string;
    config?: Record<string, any>;
}

export interface ConversationMetadata {
    conversationId?: string;
    participants?: string[];
    source?: string;
}

export interface WorkspaceInfo {
    files?: string[];
    directories?: string[];
}

export type ProgressStatus = "pending" | "in_progress" | "completed" | "blocked";
export type Priority = "low" | "medium" | "high" | "critical";
export type LinkDirection = "incoming" | "outgoing" | "both";

export interface RetryConfig {
    maxRetries: number;
    baseDelay: number;
    maxDelay: number;
    backoffFactor: number;
}

export type ErrorCategory = 
    | "AUTHENTICATION_ERROR" 
    | "QUOTA_ERROR" 
    | "NETWORK_ERROR" 
    | "RATE_LIMIT" 
    | "UNKNOWN_ERROR";
