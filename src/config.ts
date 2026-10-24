import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./types.js";

const MAX_VECTOR_DIM = 4096;

const CONFIG_DIR = join(homedir(), "mcp", "project-agent-memory");
const DEFAULT_MODEL_CACHE_DIR = join(CONFIG_DIR, "models");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

function readConfigFile(): Record<string, unknown> {
    let raw: string;
    try {
        raw = readFileSync(CONFIG_FILE, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw error;
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
        return parsed;
    } catch (error) {
        throw new Error(`Invalid ${CONFIG_FILE}: ${(error as Error).message}`);
    }
}

const fileConfig = readConfigFile();

function setting(key: string): string | undefined {
    const fromEnv = process.env[key];
    if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
    const fromFile = fileConfig[key];
    if (fromFile === undefined || fromFile === null || String(fromFile).trim() === "") return undefined;
    return String(fromFile);
}

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
    PORT: parseInt(setting("PORT") || "8000"),
    VECTOR_DIM: resolveVectorDim(setting("VECTOR_DIM")),
    DISTANCE_METRIC: setting("DISTANCE_METRIC") || "Cosine",
    EMBEDDING_PROVIDER: setting("EMBEDDING_PROVIDER") || "onnx",
    EMBEDDING_MODEL: setting("EMBEDDING_MODEL") || "nomic-ai/nomic-embed-text-v1.5",
    SUMMARIZER_PROVIDER: setting("SUMMARIZER_PROVIDER") || "openrouter",
    SUMMARIZER_MODEL: setting("SUMMARIZER_MODEL") || "openai/gpt-oss-20b:free",
    GEMINI_API_KEY: setting("GEMINI_API_KEY") || "",
    OPENROUTER_API_KEY: setting("OPENROUTER_API_KEY") || "",
    OLLAMA_API_URL: setting("OLLAMA_API_URL") || "http://localhost:11434",
    OLLAMA_API_KEY: setting("OLLAMA_API_KEY") || "",
    ONNX_MODEL_CACHE_DIR: setting("ONNX_MODEL_CACHE_DIR") || DEFAULT_MODEL_CACHE_DIR,
    ONNX_DTYPE: setting("ONNX_DTYPE") || "q8",
    OPENAI_BASE_URL: setting("OPENAI_BASE_URL") || "https://api.openai.com/v1",
    OPENAI_API_KEY: setting("OPENAI_API_KEY") || "",
    QDRANT_URL: setting("QDRANT_URL") || "http://localhost:6333",
    QDRANT_API_KEY: setting("QDRANT_API_KEY") || null,
    MEMORY_BACKEND: (setting("MEMORY_BACKEND") || "qdrant").toLowerCase(),
    POSTGRES_URL: setting("POSTGRES_URL") || "postgresql://postgres@localhost:5432/memory",
    POSTGRES_PASSWORD: setting("POSTGRES_PASSWORD") || null,
    PREST_URL: setting("PREST_URL") || null,
    PREST_JWT_KEY: setting("PREST_JWT_KEY") || null,
    PREST_REGISTER_ADMIN: setting("PREST_REGISTER_ADMIN") || "admin",
    PREST_DATABASE: setting("PREST_DATABASE") || "memory",
    // Performance optimization settings
    POOL_SIZE: parseInt(setting("POOL_SIZE") || setting("QDRANT_POOL_SIZE") || "10"),
    CACHE_TTL_SECONDS: parseInt(setting("CACHE_TTL_SECONDS") || "300"), // 5 minutes default
    EMBEDDING_CACHE_SIZE: parseInt(setting("EMBEDDING_CACHE_SIZE") || "1000"),
    QUERY_CACHE_SIZE: parseInt(setting("QUERY_CACHE_SIZE") || "500"),
    AUTO_CREATE_COLLECTIONS: ["true", "1"].includes((setting("AUTO_CREATE_COLLECTIONS") || "false").toLowerCase())
};

export default config;
