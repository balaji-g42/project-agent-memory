// Type definitions for the memory-qdrant-mcp project

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
    QDRANT_POOL_SIZE: number;
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
