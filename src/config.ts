import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./types.js";

const MAX_VECTOR_DIM = 4096;

const DEFAULT_MODEL_CACHE_DIR = join(homedir(), "mcp", "memory-qdrant-mcp", "models");

function resolveVectorDim(raw: string | undefined): number {
    if (raw === undefined || raw.trim() === "") return 768;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_VECTOR_DIM) {
        throw new Error(
            `Invalid VECTOR_DIM=${JSON.stringify(raw)}. Expected an integer between 1 and ${MAX_VECTOR_DIM}.`
        );
    }
    return parsed;
}

const config: Config = {
    PORT: parseInt(process.env.PORT || "8000"),
    VECTOR_DIM: resolveVectorDim(process.env.VECTOR_DIM),
    DISTANCE_METRIC: process.env.DISTANCE_METRIC || "Cosine",
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER || "onnx",
    EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || "nomic-ai/nomic-embed-text-v1.5",
    SUMMARIZER_PROVIDER: process.env.SUMMARIZER_PROVIDER || "openrouter",
    SUMMARIZER_MODEL: process.env.SUMMARIZER_MODEL || "openai/gpt-oss-20b:free",
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
    OLLAMA_API_URL: process.env.OLLAMA_API_URL || "http://localhost:11434",
    OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || "",
    ONNX_MODEL_CACHE_DIR: process.env.ONNX_MODEL_CACHE_DIR || DEFAULT_MODEL_CACHE_DIR,
    ONNX_DTYPE: process.env.ONNX_DTYPE || "q8",
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
    QDRANT_URL: process.env.QDRANT_URL || "http://localhost:6333",
    QDRANT_API_KEY: process.env.QDRANT_API_KEY || null,
    MEMORY_BACKEND: (process.env.MEMORY_BACKEND || "qdrant").toLowerCase(),
    POSTGRES_URL: process.env.POSTGRES_URL || "postgresql://postgres@localhost:5432/memory",
    POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD || null,
    // Performance optimization settings
    POOL_SIZE: parseInt(process.env.POOL_SIZE || process.env.QDRANT_POOL_SIZE || "10"),
    CACHE_TTL_SECONDS: parseInt(process.env.CACHE_TTL_SECONDS || "300"), // 5 minutes default
    EMBEDDING_CACHE_SIZE: parseInt(process.env.EMBEDDING_CACHE_SIZE || "1000"),
    QUERY_CACHE_SIZE: parseInt(process.env.QUERY_CACHE_SIZE || "500")
};

export default config;
