import EmbeddingProviderBase from "./providerBase.js";
import config from "../config.js";
import OpenAI from "openai";

class OpenRouterProvider extends EmbeddingProviderBase {
    private client: OpenAI;
    private model: string;

    constructor() {
        super();
        this.model = config.EMBEDDING_MODEL || "qwen/qwen3-embedding-8b";

        if (!config.OPENROUTER_API_KEY) {
            throw new Error("OPENROUTER_API_KEY is required for OpenRouter provider");
        }

        this.client = new OpenAI({
            baseURL: "https://openrouter.ai/api/v1",
            apiKey: config.OPENROUTER_API_KEY,
            defaultHeaders: {
                "HTTP-Referer": "https://github.com/balaji-g42/project-agent-memory",
                "X-Title": "Project-Agent-Memory",
            },
        });
    }

    async embedTexts(texts: string[]): Promise<number[][]> {
        const embeddings: number[][] = [];

        for (const text of texts) {
            const processedText = await this.preprocessText(text);

            // Handle chunked text (array of strings)
            if (Array.isArray(processedText)) {
                const chunkEmbeddings: number[][] = [];
                for (const chunk of processedText) {
                    const embedding = await this.callOpenRouterEmbedding(chunk);
                    chunkEmbeddings.push(embedding);
                }
                // Average the chunk embeddings
                const avgEmbedding = this.averageEmbeddings(chunkEmbeddings);
                embeddings.push(avgEmbedding);
            } else {
                // Handle single text (string)
                const embedding = await this.callOpenRouterEmbedding(processedText);
                embeddings.push(embedding);
            }
        }

        return embeddings;
    }

    private async callOpenRouterEmbedding(text: string): Promise<number[]> {
        const response = await this.client.embeddings.create({
            model: this.model,
            input: text,
            encoding_format: "float"
        });

        if (response.data && response.data[0] && response.data[0].embedding) {
            return response.data[0].embedding;
        } else {
            throw new Error("Invalid response format from OpenRouter API");
        }
    }

    // Helper method to average multiple embeddings
    private averageEmbeddings(embeddings: number[][]): number[] {
        if (embeddings.length === 0) return [];
        if (embeddings.length === 1) return embeddings[0];

        const dimension = embeddings[0].length;
        const averaged = new Array(dimension).fill(0);

        for (const embedding of embeddings) {
            for (let i = 0; i < dimension; i++) {
                averaged[i] += embedding[i];
            }
        }

        return averaged.map(val => val / embeddings.length);
    }

    providerName(): string {
        return "OpenRouter";
    }
}

export default OpenRouterProvider;
