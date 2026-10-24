import { describe, it, expect } from '@jest/globals';
import EmbeddingProviderBase from '../src/embeddings/providerBase.js';
import { MAX_CHUNKS_PER_TEXT, MAX_CHUNK_SIZE } from '../src/constants.js';

class TestProvider extends EmbeddingProviderBase {
    async embedTexts(texts: string[]): Promise<number[][]> {
        return texts.map(() => [0]);
    }
    providerName(): string {
        return 'test';
    }
}

const provider = new TestProvider();
const longText = Array.from({ length: 600 }, (_, i) => `Sentence number ${i} about chunked storage.`).join(' ');

describe('chunkText', () => {
    it('caps the chunk count at MAX_CHUNKS_PER_TEXT by default', () => {
        expect(longText.length).toBeGreaterThan(MAX_CHUNKS_PER_TEXT * MAX_CHUNK_SIZE);
        expect(provider.chunkText(longText).length).toBe(MAX_CHUNKS_PER_TEXT);
    });

    it('covers the whole text when the cap is lifted', () => {
        const chunks = provider.chunkText(longText, Infinity);
        expect(chunks.length).toBeGreaterThan(MAX_CHUNKS_PER_TEXT);
        expect(chunks.every(c => c.length <= MAX_CHUNK_SIZE)).toBe(true);
        expect(longText.endsWith(chunks[chunks.length - 1])).toBe(true);
    });
});
