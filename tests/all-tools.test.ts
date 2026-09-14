import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PROJECT = 'project-agent-memory-test';

function parse(res: any) {
    const t = res.content?.[0]?.text ?? '';
    try { return JSON.parse(t); } catch { return t; }
}

describe('Memory MCP v3 tool surface', () => {
    let client: Client;
    let transport: StdioClientTransport;
    const state: Record<string, any> = {};

    async function call(name: string, args: Record<string, any>) {
        return parse(await client.callTool({ name, arguments: args }));
    }

    beforeAll(async () => {
        transport = new StdioClientTransport({
            command: 'node',
            args: ['dist/index.js'],
            env: {
                ...(process.env as Record<string, string>),
                VECTOR_DIM: '768',
                EMBEDDING_PROVIDER: 'onnx',
                EMBEDDING_MODEL: 'nomic-ai/nomic-embed-text-v1.5'
            }
        });

        client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
    });

    afterAll(async () => {
        await client.close();

        if ((process.env.MEMORY_BACKEND || 'qdrant').toLowerCase() === 'postgres') {
            const { PrestVectorClient } = await import('../src/backends/prest.js');
            const prest = new PrestVectorClient();
            await prest.deleteCollection(`memory_bank_${PROJECT}`).catch(() => {});
        } else {
            const { QdrantClient } = await import('@qdrant/js-client-rest');
            const qdrant = new QdrantClient({
                url: process.env.QDRANT_URL,
                port: 443,
                apiKey: process.env.QDRANT_API_KEY || undefined,
                // @ts-ignore - checkCompatibility may not be in the types but is valid
                checkCompatibility: false
            });
            await qdrant.deleteCollection(`memory_bank_${PROJECT}`).catch(() => {});
        }
    });

    it('tools/list returns exactly the 7 v3 tools', async () => {
        const { tools } = await client.listTools();
        const names = tools.map(t => t.name).sort();
        expect(names).toEqual([
            'memory_admin', 'memory_context', 'memory_create',
            'memory_delete', 'memory_graph', 'memory_read', 'memory_update'
        ]);
    });

    describe('memory_create', () => {
        it('single entry returns id and type', async () => {
            const r = await call('memory_create', {
                project_name: PROJECT,
                items: [{
                    memory_type: 'decisionLog',
                    content: 'Chose PostgreSQL with pgvector over Qdrant for the v3 storage backend',
                    metadata: { status: 'accepted', priority: 'high' }
                }]
            });
            expect(r).toHaveLength(1);
            expect(typeof r[0].id).toBe('string');
            expect(r[0].id.length).toBeGreaterThan(0);
            expect(r[0].type).toBe('decisionLog');
            state.decisionId = r[0].id;
        });

        it('batch of 3 returns 3 ids, order preserved', async () => {
            const r = await call('memory_create', {
                project_name: PROJECT,
                items: [
                    { memory_type: 'progress', content: 'Stood up the pgvector container and applied the memories schema', metadata: { status: 'done' } },
                    { memory_type: 'systemPatterns', content: 'Selenium table assertions must wait on a row signature change, never a fixed sleep', metadata: { status: 'active' } },
                    { memory_type: 'customData', content: 'Docker compose stacks live under the WSL home directory at ~/docker-compose', metadata: { status: 'active', dataType: 'infra' } }
                ]
            });
            expect(r).toHaveLength(3);
            expect(r.map((x: any) => x.type)).toEqual(['progress', 'systemPatterns', 'customData']);
            state.progressId = r[0].id;
            state.patternId = r[1].id;
            state.customId = r[2].id;
        });

        it('explicit id is honoured and idempotent, update-by-external-id works', async () => {
            const r = await call('memory_create', {
                project_name: PROJECT,
                items: [{ memory_type: 'progress', content: 'Explicit id entry, first write', id: 'fixed-id-001' }]
            });
            const first = r[0].id;
            expect(typeof first).toBe('string');
            expect(first.length).toBeGreaterThan(0);

            const again = await call('memory_create', {
                project_name: PROJECT,
                items: [{ memory_type: 'progress', content: 'Explicit id entry, second write', id: 'fixed-id-001' }]
            });
            expect(again[0].id).toBe(first);

            const upd = await call('memory_update', {
                project_name: PROJECT,
                items: [{ id: 'fixed-id-001', content: 'Explicit id entry, updated by external id' }]
            });
            expect(upd[0]?.updated).toBe(true);
            state.fixedId = first;
        });

        it('unknown memory_type is rejected', async () => {
            let threw = false;
            try {
                const r = await call('memory_create', {
                    project_name: PROJECT,
                    items: [{ memory_type: 'notAType', content: 'should not be stored' }]
                });
                if (typeof r === 'string' && /invalid|error|expected/i.test(r)) threw = true;
            } catch {
                threw = true;
            }
            expect(threw).toBe(true);
        });
    });

    describe('memory_read: search', () => {
        it('relevant entry ranks first with a sane score', async () => {
            const r = await call('memory_read', {
                project_name: PROJECT,
                queries: [{ query_text: 'which database did we pick for storage', limit: 3 }]
            });
            expect(r.length).toBeGreaterThan(0);
            expect(typeof r[0].score).toBe('number');
            expect(r[0].score).toBeGreaterThan(0);
            expect(r[0].score).toBeLessThanOrEqual(1);
            expect(r[0].content).toMatch(/PostgreSQL/i);
        });

        it('memory_type filter restricts results', async () => {
            const r = await call('memory_read', {
                project_name: PROJECT,
                queries: [{ query_text: 'anything at all', memory_type: 'systemPatterns', limit: 5 }]
            });
            expect(r.length).toBeGreaterThan(0);
            expect(r.every((x: any) => x.type === 'systemPatterns')).toBe(true);
        });

        it('limit is honoured', async () => {
            const r = await call('memory_read', {
                project_name: PROJECT,
                queries: [{ query_text: 'database', limit: 2 }]
            });
            expect(r.length).toBeLessThanOrEqual(2);
        });

        it('list mode (no query_text) returns rows in recency order', async () => {
            const r = await call('memory_read', {
                project_name: PROJECT,
                queries: [{ memory_type: 'progress', limit: 10 }]
            });
            expect(r.length).toBeGreaterThan(0);
            expect(r.every((x: any) => x.type === 'progress')).toBe(true);
            const ts = r.map((x: any) => new Date(x.timestamp).getTime());
            expect(ts.every((v: number, i: number) => i === 0 || ts[i - 1] >= v)).toBe(true);
        });

        it('batch of 2 queries returns 2 result sets', async () => {
            const r = await call('memory_read', {
                project_name: PROJECT,
                queries: [
                    { query_text: 'database choice', limit: 2 },
                    { memory_type: 'customData', limit: 2 }
                ]
            });
            expect(r).toHaveLength(2);
            expect(Array.isArray(r[0])).toBe(true);
            expect(Array.isArray(r[1])).toBe(true);
        });
    });

    describe('memory_read: metadata_filter', () => {
        it('filters on a single value', async () => {
            const r = await call('memory_read', {
                project_name: PROJECT,
                queries: [{ memory_type: 'decisionLog', metadata_filter: { status: 'accepted' }, limit: 10 }]
            });
            expect(r.length).toBeGreaterThan(0);
            expect(r.every((x: any) => x.metadata?.status === 'accepted')).toBe(true);
        });

        it('array value matches any element', async () => {
            const r = await call('memory_read', {
                project_name: PROJECT,
                queries: [{ metadata_filter: { status: ['accepted', 'done'] }, limit: 10 }]
            });
            expect(r.length).toBeGreaterThanOrEqual(2);
            expect(r.every((x: any) => ['accepted', 'done'].includes(x.metadata?.status))).toBe(true);
        });
    });

    describe('memory_update', () => {
        it('replaces content and re-embeds', async () => {
            await call('memory_update', {
                project_name: PROJECT,
                items: [{ id: state.progressId, content: 'Ported the data layer and ran the full seven-tool suite against Qdrant' }]
            });
            const r = await call('memory_read', {
                project_name: PROJECT,
                queries: [{ query_text: 'ran the seven tool suite', memory_type: 'progress', limit: 5 }]
            });
            const hit = r.find((x: any) => x.id === state.progressId);
            expect(hit).toBeDefined();
            expect(hit.content).toMatch(/seven-tool suite/);
        });

        it('shallow-merges metadata, preserves pre-existing keys', async () => {
            await call('memory_update', {
                project_name: PROJECT,
                items: [{ id: state.customId, metadata: { priority: 'low' } }]
            });
            const r = await call('memory_read', {
                project_name: PROJECT,
                queries: [{ memory_type: 'customData', limit: 10 }]
            });
            const hit = r.find((x: any) => x.id === state.customId);
            expect(hit).toBeDefined();
            expect(hit.metadata.priority).toBe('low');
            expect(hit.metadata.dataType).toBe('infra');
            expect(hit.metadata.status).toBe('active');
            expect(hit.content).toMatch(/docker-compose/);
        });

        it('batch of 2', async () => {
            const r = await call('memory_update', {
                project_name: PROJECT,
                items: [
                    { id: state.patternId, metadata: { reviewed: true } },
                    { id: 'fixed-id-001', metadata: { reviewed: true } }
                ]
            });
            expect(r).toHaveLength(2);
            expect(r.every((x: any) => x.updated === true)).toBe(true);
        });
    });

    describe('memory_context', () => {
        it('returns productContext/activeContext/systemPatterns keys', async () => {
            const r = await call('memory_context', { project_name: PROJECT });
            expect(r).toHaveProperty('productContext');
            expect(r).toHaveProperty('activeContext');
            expect(Array.isArray(r.systemPatterns)).toBe(true);
        });

        it('patch merges and is reflected in the same call', async () => {
            const r = await call('memory_context', {
                project_name: PROJECT,
                product_context: { name: 'project-agent-memory', goal: 'move off Qdrant' },
                active_context: { focus: 'testing the seven tools' }
            });
            expect(r.productContext.goal).toBe('move off Qdrant');
            expect(r.activeContext.focus).toBe('testing the seven tools');
        });

        it('second patch merges shallowly, keeps earlier keys', async () => {
            const r = await call('memory_context', {
                project_name: PROJECT,
                product_context: { stack: 'TypeScript' }
            });
            expect(r.productContext.stack).toBe('TypeScript');
            expect(r.productContext.goal).toBe('move off Qdrant');
        });

        it('writes the previous version to contextHistory', async () => {
            const r = await call('memory_read', {
                project_name: PROJECT,
                queries: [{ memory_type: 'contextHistory', limit: 10 }]
            });
            expect(r.length).toBeGreaterThan(0);
        });
    });

    describe('memory_graph', () => {
        it('link creates edges', async () => {
            const r = await call('memory_graph', {
                project_name: PROJECT,
                op: 'link',
                edges: [
                    { from_id: state.decisionId, to_id: state.progressId, relation: 'implemented_by' },
                    { from_id: state.progressId, to_id: state.patternId, relation: 'produced' }
                ]
            });
            const ids = Array.isArray(r) ? r : r?.ids ?? [];
            expect(ids).toHaveLength(2);
            state.linkIds = ids.map((x: any) => (typeof x === 'string' ? x : x.id));
        });

        it('neighbors depth 1 reaches only direct edges', async () => {
            const r = await call('memory_graph', { project_name: PROJECT, op: 'neighbors', id: state.decisionId, depth: 1 });
            const ids = (r.neighbors ?? []).map((n: any) => n.id);
            expect(ids).toContain(state.progressId);
            expect(ids).not.toContain(state.patternId);
        });

        it('neighbors depth 2 reaches both connected nodes, no unconnected leak', async () => {
            const r = await call('memory_graph', { project_name: PROJECT, op: 'neighbors', id: state.decisionId, depth: 2 });
            const ids = (r.neighbors ?? []).map((n: any) => n.id);
            expect(ids).toContain(state.progressId);
            expect(ids).toContain(state.patternId);
            expect(ids).not.toContain(state.customId);
        });

        it('direction=incoming restricts traversal', async () => {
            const r = await call('memory_graph', { project_name: PROJECT, op: 'neighbors', id: state.decisionId, depth: 2, direction: 'incoming' });
            const ids = (r.neighbors ?? []).map((n: any) => n.id);
            expect(ids).not.toContain(state.progressId);
        });

        it('unlink removes the edge but not the nodes', async () => {
            const r = await call('memory_graph', { project_name: PROJECT, op: 'unlink', link_ids: state.linkIds });
            expect(r.deleted).toBeGreaterThanOrEqual(1);

            const after = await call('memory_graph', { project_name: PROJECT, op: 'neighbors', id: state.decisionId, depth: 2 });
            expect(after.neighbors ?? []).toHaveLength(0);

            const node = await call('memory_read', { project_name: PROJECT, queries: [{ memory_type: 'decisionLog', limit: 10 }] });
            expect(node.some((x: any) => x.id === state.decisionId)).toBe(true);
        });
    });

    describe('memory_admin', () => {
        it('export returns markdown', async () => {
            const md = await call('memory_admin', { project_name: PROJECT, op: 'export' });
            expect(typeof md).toBe('string');
            expect(md.length).toBeGreaterThan(0);
            expect(md).toMatch(/#/);
            state.exported = md;
        });

        it('export -> import -> export round-trips stably', async () => {
            const imp = await call('memory_admin', { project_name: PROJECT, op: 'import', markdown: state.exported });
            expect(imp).toBeInstanceOf(Object);
            expect(imp.errors ?? []).toHaveLength(0);
            expect(imp.imported).toBeGreaterThan(0);

            const md2 = await call('memory_admin', { project_name: PROJECT, op: 'export' });
            expect(typeof md2).toBe('string');
            expect(md2.length).toBeGreaterThan(0);
            for (const type of ['productcontext', 'decisionlog', 'progress']) {
                expect(md2.toLowerCase()).toContain('## ' + type);
            }
        });

        it('import of foreign markdown reports errors, does not throw', async () => {
            const r = await call('memory_admin', {
                project_name: PROJECT, op: 'import',
                markdown: '# Some unrelated document\n\n## Recipes\n\n### Pancakes\nFlour and eggs.\n'
            });
            expect(r).toBeInstanceOf(Object);
            expect(r.imported).toBe(0);
            expect((r.errors ?? []).length).toBeGreaterThan(0);
        });
    });

    it('project isolation: a different project sees none of these rows', async () => {
        const other = PROJECT + '-isolation';
        await call('memory_create', {
            project_name: other,
            items: [{ memory_type: 'progress', content: 'Isolation probe row, belongs only to the isolation project' }]
        });
        const r = await call('memory_read', {
            project_name: other, queries: [{ query_text: 'database choice PostgreSQL pgvector', limit: 10 }]
        });
        expect(r.some((x: any) => x.id === state.decisionId)).toBe(false);
    });

    describe('memory_delete', () => {
        it('unknown ids are ignored, not raised', async () => {
            const r = await call('memory_delete', { project_name: PROJECT, ids: ['does-not-exist-xyz'] });
            expect(typeof r.deleted).toBe('number');
        });

        it('deleted entry is gone from subsequent reads', async () => {
            const del = await call('memory_delete', { project_name: PROJECT, ids: ['fixed-id-001'] });
            expect(del.deleted).toBe(1);
            const r = await call('memory_read', { project_name: PROJECT, queries: [{ memory_type: 'progress', limit: 20 }] });
            expect(r.some((x: any) => x.id === state.fixedId)).toBe(false);
        });
    });
});
