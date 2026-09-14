import config from "./config.js";
import OnnxProvider from "./embeddings/onnx.js";
import OpenAICompatibleProvider from "./embeddings/openaiCompatible.js";
import GeminiVertexProvider from "./embeddings/geminiVertex.js";
import OpenRouterProvider from "./embeddings/openrouter.js";
import type EmbeddingProviderBase from "./embeddings/providerBase.js";

const SUPPORTED_PROVIDERS = ["onnx", "openai", "gemini", "openrouter"] as const;

let embeddingProvider: EmbeddingProviderBase | undefined;

function getEmbeddingProvider(): EmbeddingProviderBase {
    if (!embeddingProvider) {
        const provider = config.EMBEDDING_PROVIDER.toLowerCase();

        switch (provider) {
            case "onnx":
                embeddingProvider = new OnnxProvider();
                break;
            case "openai":
                embeddingProvider = new OpenAICompatibleProvider();
                break;
            case "gemini":
                embeddingProvider = new GeminiVertexProvider();
                break;
            case "openrouter":
                embeddingProvider = new OpenRouterProvider();
                break;
            default:
                throw new Error(
                    `Unknown EMBEDDING_PROVIDER=${JSON.stringify(config.EMBEDDING_PROVIDER)}. ` +
                    `Supported: ${SUPPORTED_PROVIDERS.join(", ")}. ` +
                    `To use Ollama, set EMBEDDING_PROVIDER=openai and OPENAI_BASE_URL=http://localhost:11434/v1`
                );
        }

        console.error(
            `Embedding provider: ${provider} (model=${config.EMBEDDING_MODEL}, dim=${config.VECTOR_DIM})`
        );
    }
    return embeddingProvider;
}

async function embedTexts(texts: string[]): Promise<number[][]> {
    return getEmbeddingProvider().embedTexts(texts);
}

async function embedText(text: string): Promise<number[]> {
    const vectors = await embedTexts([text]);
    return vectors[0];
}

export { embedText, embedTexts, getEmbeddingProvider, SUPPORTED_PROVIDERS };
