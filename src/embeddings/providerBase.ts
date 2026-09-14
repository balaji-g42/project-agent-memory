// Base class for embedding providers
import {
    SUMMARIZATION_PROMPT,
    MAX_TEXT_LENGTH_FOR_EMBEDDING,
    MAX_CHUNK_SIZE,
    CHUNK_OVERLAP,
    MAX_CHUNKS_PER_TEXT
} from "../constants.js";
import axios from "axios";
import config from "../config.js";
import type { RetryConfig, ErrorCategory } from "../types.js";

// Retry configuration for Gemini API
const RETRY_CONFIG: RetryConfig = {
    maxRetries: 3,
    baseDelay: 1000, // 1 second
    maxDelay: 5000,  // 5 seconds
    backoffFactor: 2
};

// Error categorization for appropriate handling
function categorizeGeminiError(error: Error): ErrorCategory {
    const errorMessage = error.message.toLowerCase();

    if (errorMessage.includes('api key') || errorMessage.includes('authentication') || errorMessage.includes('unauthorized')) {
        return 'AUTHENTICATION_ERROR'; // No retry
    }
    if (errorMessage.includes('quota') || errorMessage.includes('limit') || errorMessage.includes('exceeded')) {
        return 'QUOTA_ERROR'; // No retry
    }
    if (errorMessage.includes('timeout') || errorMessage.includes('network') || errorMessage.includes('fetch')) {
        return 'NETWORK_ERROR'; // Retry with backoff
    }
    if (errorMessage.includes('rate limit') || errorMessage.includes('too many requests')) {
        return 'RATE_LIMIT'; // Retry with longer delay
    }

    return 'UNKNOWN_ERROR'; // Retry once
}

// Retry utility with exponential backoff
async function withRetry<T>(operation: () => Promise<T>, retryConfig: RetryConfig = RETRY_CONFIG): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error as Error;

            // Check if error is retryable
            const errorCategory = categorizeGeminiError(lastError);
            if ((errorCategory === 'AUTHENTICATION_ERROR' || errorCategory === 'QUOTA_ERROR') || attempt === retryConfig.maxRetries) {
                throw lastError;
            }

            // Calculate delay with exponential backoff
            const delay = Math.min(
                retryConfig.baseDelay * Math.pow(retryConfig.backoffFactor, attempt),
                retryConfig.maxDelay
            );

            console.error(`Gemini API attempt ${attempt + 1} failed (${errorCategory}), retrying in ${delay}ms:`, lastError.message);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw lastError;
}

// Enhanced Gemini API call with retry logic
async function callGeminiAPI(text: string, prompt: string): Promise<string> {
    return await withRetry(async () => {
        const { GoogleGenerativeAI } = await import("@google/generative-ai");
        if (!config.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");

        const genai = new GoogleGenerativeAI(config.GEMINI_API_KEY);
        const model = genai.getGenerativeModel({ model: "gemini-pro" });

        const result = await model.generateContent(`${prompt}\n\nText to summarize:\n${text}`);
        const response = await result.response;
        const summary = response.text();

        if (summary) return summary;
        throw new Error("Empty response from Gemini API");
    });
}

abstract class EmbeddingProviderBase {
    abstract embedTexts(texts: string[]): Promise<number[][]>;
    abstract providerName(): string;

    // Helper method to preprocess text before embedding
    async preprocessText(text: string): Promise<string | string[]> {
        if (text.length > MAX_TEXT_LENGTH_FOR_EMBEDDING) {
            // Try chunking first
            const chunks = this.chunkText(text);
            if (chunks.length > 0 && chunks.length <= MAX_CHUNKS_PER_TEXT) {
                return chunks;
            }
            // Fallback to summarization if chunking produces too many chunks
            return await this.summarizeForEmbedding(text);
        }
        return text;
    }

    // Intelligent text chunking with sentence boundary detection
    chunkText(text: string): string[] {
        const chunks: string[] = [];
        let start = 0;

        while (start < text.length && chunks.length < MAX_CHUNKS_PER_TEXT) {
            let end = start + MAX_CHUNK_SIZE;

            // If we're not at the end, try to find a good breaking point
            if (end < text.length) {
                // Look for sentence endings within the last 200 characters
                const searchStart = Math.max(start, end - 200);
                let breakPoint = end;

                // Look for period, exclamation, or question mark followed by space or newline
                for (let i = end - 1; i >= searchStart; i--) {
                    if ((text[i] === '.' || text[i] === '!' || text[i] === '?') &&
                        (i + 1 >= text.length || /\s/.test(text[i + 1]))) {
                        breakPoint = i + 1;
                        break;
                    }
                }

                // If no sentence ending found, look for other good break points
                if (breakPoint === end) {
                    // Look for spaces, newlines, or other natural breaks
                    for (let i = end - 1; i >= searchStart; i--) {
                        if (/\s/.test(text[i])) {
                            breakPoint = i;
                            break;
                        }
                    }
                }

                end = breakPoint;
            }

            const chunk = text.slice(start, end).trim();
            if (chunk.length > 0) {
                chunks.push(chunk);
            }

            // Move start position with overlap
            start = Math.max(start + 1, end - CHUNK_OVERLAP);
        }

        return chunks;
    }

    // Embedding-specific summarization with custom prompt
    async summarizeForEmbedding(text: string): Promise<string> {
        const SUMMARIZER_MODEL = process.env.SUMMARIZER_MODEL || "openai/gpt-oss-20b:free";
        const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";

        // Use OpenRouter if key exists
        if (OPENROUTER_KEY) {
            try {
                const response = await axios.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    {
                        model: SUMMARIZER_MODEL,
                        messages: [
                            { role: "system", content: SUMMARIZATION_PROMPT },
                            { role: "user", content: text }
                        ],
                        temperature: 0.2,
                        max_tokens: 500
                    },
                    {
                        headers: {
                            "Authorization": `Bearer ${OPENROUTER_KEY}`,
                            "Content-Type": "application/json"
                        }
                    }
                );

                const summary = response.data?.choices?.[0]?.message?.content;
                if (summary) return summary;
            } catch (err) {
                const error = err as Error;
                console.error("OpenRouter summarization failed, falling back to Gemini:", error.message);
            }
        }

        // Fallback to Gemini with enhanced error handling and retry logic
        try {
            const summary = await callGeminiAPI(text, SUMMARIZATION_PROMPT);

            // Log successful summarization
            console.error(`Gemini summarization successful in embedding preprocessing: ${text.length} chars -> ${summary.length} chars`);
            return summary;
        } catch (err) {
            const error = err as Error;
            const errorCategory = categorizeGeminiError(error);

            // Structured error logging
            const errorInfo = {
                timestamp: new Date().toISOString(),
                operation: 'embedding_preprocessing',
                errorType: errorCategory,
                errorMessage: error.message,
                textLength: text.length,
                hasApiKey: !!config.GEMINI_API_KEY
            };

            console.error('Gemini summarization failed in embedding preprocessing:', errorInfo);

            // For certain error types, we could implement circuit breaker pattern here
            if (errorCategory === 'AUTHENTICATION_ERROR' || errorCategory === 'QUOTA_ERROR') {
                console.error(`Gemini API permanently unavailable due to ${errorCategory}.`);
            }
        }

        // If all fails, return original text
        return text;
    }
}

export default EmbeddingProviderBase;
