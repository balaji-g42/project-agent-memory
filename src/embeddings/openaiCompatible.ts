import EmbeddingProviderBase from "./providerBase.js";
import config from "../config.js";
import OpenAI from "openai";

function fitToConfiguredDim(vector: number[], model: string): number[] {
    const target = config.VECTOR_DIM;
    if (vector.length === target) return vector;
    if (vector.length < target) {
        throw new Error(
            `VECTOR_DIM=${target} exceeds the ${vector.length} dimensions returned by ${model}. ` +
            `Set VECTOR_DIM=${vector.length} or choose a larger model.`
        );
    }
    const sliced = vector.slice(0, target);
    const magnitude = Math.sqrt(sliced.reduce((sum, val) => sum + val * val, 0));
    return magnitude === 0 ? sliced : sliced.map(val => val / magnitude);
}

class OpenAICompatibleProvider extends EmbeddingProviderBase {
    private client: OpenAI;
    private model: string;

    constructor() {
        super();
        if (!config.OPENAI_BASE_URL) {
            throw new Error("OPENAI_BASE_URL is required when EMBEDDING_PROVIDER=openai");
        }
        this.client = new OpenAI({
            baseURL: config.OPENAI_BASE_URL,
            apiKey: config.OPENAI_API_KEY || "not-required"
        });
        this.model = config.EMBEDDING_MODEL;
    }

    async embedTexts(texts: string[]): Promise<number[][]> {
        const results: number[][] = [];

        for (const text of texts) {
            const processedText = await this.preprocessText(text);
            const inputs = Array.isArray(processedText) ? processedText : [processedText];

            const response = await this.client.embeddings.create({
                model: this.model,
                input: inputs
            });

            if (!response.data?.length) {
                throw new Error(`Empty embedding response from ${config.OPENAI_BASE_URL}`);
            }

            const vectors = response.data
                .sort((a, b) => a.index - b.index)
                .map(item => fitToConfiguredDim(item.embedding, this.model));

            results.push(this.averageEmbeddings(vectors));
        }

        return results;
    }

    averageEmbeddings(embeddings: number[][]): number[] {
        if (embeddings.length === 0) return [];
        if (embeddings.length === 1) return embeddings[0];

        const embeddingLength = embeddings[0].length;
        const averaged = new Array(embeddingLength).fill(0);

        for (const embedding of embeddings) {
            for (let i = 0; i < embeddingLength; i++) {
                averaged[i] += embedding[i];
            }
        }

        const magnitude = Math.sqrt(
            averaged.reduce((sum, val) => sum + (val / embeddings.length) ** 2, 0)
        );
        return averaged.map(val =>
            magnitude === 0 ? 0 : val / embeddings.length / magnitude
        );
    }

    providerName(): string {
        return "OpenAICompatibleProvider";
    }
}

export default OpenAICompatibleProvider;
