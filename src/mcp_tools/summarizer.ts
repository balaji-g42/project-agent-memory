// MCP tools summarizer with retry logic
import axios from "axios";
import OpenAI from "openai";
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

// Enhanced OpenRouter API call
async function callOpenRouterAPI(text: string): Promise<string> {
    if (!config.OPENROUTER_API_KEY) {
        throw new Error("OPENROUTER_API_KEY not set");
    }

    const client = new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: config.OPENROUTER_API_KEY,
        defaultHeaders: {
            "HTTP-Referer": "https://github.com/balaji-g42/project-agent-memory",
            "X-Title": "Project-Agent-Memory",
        },
    });

    const response = await client.chat.completions.create({
        model: config.SUMMARIZER_MODEL,
        messages: [
            { role: "system", content: "Summarize the following content concisely:" },
            { role: "user", content: text }
        ],
        temperature: 0.2,
        max_tokens: 500
    });

    const summary = response.choices?.[0]?.message?.content;
    if (summary) return summary;
    throw new Error("Empty response from OpenRouter API");
}

// Enhanced Ollama API call
async function callOllamaAPI(text: string): Promise<string> {
    const headers = config.OLLAMA_API_KEY ? { "Authorization": `Bearer ${config.OLLAMA_API_KEY}` } : {};
    
    const response = await axios.post(
        `${config.OLLAMA_API_URL}/api/generate`,
        {
            model: config.SUMMARIZER_MODEL || "llama2",
            prompt: `Summarize the following content concisely:\n\n${text}`,
            stream: false
        },
        {
            headers,
            timeout: 60000 // 60 second timeout for local models
        }
    );

    const summary = response.data?.response;
    if (summary) return summary;
    throw new Error("Empty response from Ollama API");
}

/**
 * Summarize a given text using the configured provider (OpenRouter, Gemini, or Ollama).
 * Fallback: Always falls back to OpenRouter if the selected provider fails.
 * @param text - Text to summarize
 * @returns Summarized text
 */
async function summarizeText(text: string): Promise<string> {
    if (!text) return "";

    const provider = config.SUMMARIZER_PROVIDER.toLowerCase();

    try {
        switch (provider) {
            case "openrouter":
                return await callOpenRouterAPI(text);
            case "gemini":
                return await callGeminiAPI(text, "Summarize the following content concisely:");
            case "ollama":
                return await callOllamaAPI(text);
            default:
                console.error(`Unknown summarizer provider: ${provider}, falling back to OpenRouter`);
                return await callOpenRouterAPI(text);
        }
    } catch (err) {
        const error = err as Error;
        console.error(`${provider} summarization failed:`, error.message);

        // Fallback to OpenRouter (default)
        if (provider !== "openrouter") {
            try {
                console.error("Falling back to OpenRouter...");
                return await callOpenRouterAPI(text);
            } catch (openrouterErr) {
                console.error("OpenRouter fallback also failed:", (openrouterErr as Error).message);
            }
        }

        // If all fails, return original text
        console.error("All summarization attempts failed, returning original text");
        return text;
    }
}

export { summarizeText };
