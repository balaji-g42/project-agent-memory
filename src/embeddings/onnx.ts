import EmbeddingProviderBase from "./providerBase.js";
import config from "../config.js";

type FeatureExtractor = (
    texts: string[],
    options: { pooling: "mean"; normalize: boolean }
) => Promise<{ tolist(): number[][] }>;

let extractorPromise: Promise<FeatureExtractor> | undefined;

async function getExtractor(): Promise<FeatureExtractor> {
    if (!extractorPromise) {
        extractorPromise = (async () => {
            const { pipeline, env } = await import("@huggingface/transformers");
            if (config.ONNX_MODEL_CACHE_DIR) {
                env.cacheDir = config.ONNX_MODEL_CACHE_DIR;
            }
            console.error(
                `Loading ONNX embedding model ${config.EMBEDDING_MODEL} (dtype=${config.ONNX_DTYPE}); first run downloads the model.`
            );
            const extractor = await pipeline("feature-extraction", config.EMBEDDING_MODEL, {
                dtype: config.ONNX_DTYPE as "q8"
            });
            console.error(`ONNX embedding model ready: ${config.EMBEDDING_MODEL}`);
            return extractor as unknown as FeatureExtractor;
        })().catch(err => {
            extractorPromise = undefined;
            throw err;
        });
    }
    return extractorPromise;
}

function truncateToConfiguredDim(vector: number[]): number[] {
    const target = config.VECTOR_DIM;
    if (vector.length === target) return vector;
    if (vector.length < target) {
        throw new Error(
            `VECTOR_DIM=${target} exceeds the ${vector.length} dimensions produced by ${config.EMBEDDING_MODEL}. ` +
            `Lower VECTOR_DIM or choose a larger model.`
        );
    }
    const sliced = vector.slice(0, target);
    const magnitude = Math.sqrt(sliced.reduce((sum, val) => sum + val * val, 0));
    return magnitude === 0 ? sliced : sliced.map(val => val / magnitude);
}

class OnnxProvider extends EmbeddingProviderBase {
    async embedTexts(texts: string[]): Promise<number[][]> {
        const extractor = await getExtractor();
        const results: number[][] = [];

        for (const text of texts) {
            const processedText = await this.preprocessText(text);
            const inputs = Array.isArray(processedText) ? processedText : [processedText];
            const output = await extractor(inputs, { pooling: "mean", normalize: true });
            const vectors = output.tolist().map(truncateToConfiguredDim);
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
        return "OnnxProvider";
    }
}

export default OnnxProvider;
