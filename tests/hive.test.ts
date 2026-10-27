import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const A = 'hive-test-a';
const B = 'hive-test-b';

function parse(res: any) {
    const t = res.content?.[0]?.text ?? '';
    try { return JSON.parse(t); } catch { return t; }
}

describe('Hive memory: cross-project access', () => {
    let client: Client;
    const state: Record<string, any> = {};

    async function raw(name: string, args: Record<string, any>) {
        return client.callTool({ name, arguments: args });
    }
    async function call(name: string, args: Record<string, any>) {
        return parse(await raw(name, args));
    }
    async function fails(name: string, args: Record<string, any>): Promise<string> {
        const res: any = await raw(name, args);
        expect(res.isError).toBe(true);
        return String(res.content?.[0]?.text ?? '');
    }

    beforeAll(async () => {
        const transport = new StdioClientTransport({
            command: 'node',
            args: ['dist/index.js'],
            env: {
                ...(process.env as Record<string, string>),
                VECTOR_DIM: '768',
                EMBEDDING_PROVIDER: 'onnx',
                EMBEDDING_MODEL: 'nomic-ai/nomic-embed-text-v1.5'
            }
        });
        client = new Client({ name: 'hive-test', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        for (const project of [A, B]) {
            await call('memory_admin', { project_name: project, op: 'delete_collection' }).catch(() => {});
        }
        await call('memory_context', { project_name: A });
        await call('memory_context', { project_name: B });
    }, 120000);

    afterAll(async () => {
        for (const project of [A, B]) {
            await call('memory_admin', { project_name: project, op: 'delete_collection' }).catch(() => {});
        }
        await client.close();
    });

    it('stamps version on create and flags secrets as private', async () => {
        const created = await call('memory_create', {
            project_name: A,
            items: [
                { memory_type: 'systemPatterns', id: 'hive-e1', content: 'Use pnpm workspaces for the monorepo package manager' },
                { memory_type: 'decisionLog', id: 'hive-e2', content: 'Quarterly budget numbers for the finance team', private: true },
                { memory_type: 'customData', id: 'hive-e3', content: 'database password: Sup3rS3cretValue99' }
            ]
        });
        expect(created).toHaveLength(3);
        expect(created[2].private).toBe(true);
        const read = await call('memory_read', { project_name: A, queries: [{ memory_type: 'systemPatterns', limit: 20 }] });
        const e1 = read.find((r: any) => r.content.includes('pnpm'));
        expect(e1.version).toBe(1);
        state.e1 = e1.id;
    });

    it('list_projects shows other public projects only', async () => {
        const list = await call('memory_admin', { project_name: B, op: 'list_projects' });
        expect(list.map((p: any) => p.project)).toContain(A);
        expect(list.map((p: any) => p.project)).not.toContain(B);
    });

    it('cross-project search returns public entries tagged with the source project', async () => {
        const res = await call('memory_read', { project_name: B, target_project: [A], queries: [{ query_text: 'which package manager do we use for the monorepo', heat: 1 }] });
        expect(res.length).toBeGreaterThan(0);
        expect(res.length).toBeLessThanOrEqual(3);
        expect(res[0].project).toBe(A);
        expect(res.some((r: any) => r.content.includes('pnpm'))).toBe(true);
    });

    it('never returns private or secret entries to another project', async () => {
        const res = await call('memory_read', { project_name: B, target_project: [A], queries: [{ query_text: 'quarterly budget numbers finance password', heat: 1, limit: 10 }] });
        const contents = (Array.isArray(res) ? res : []).map((r: any) => r.content);
        expect(contents.some((c: string) => c.includes('budget') || c.includes('Sup3rS3cret'))).toBe(false);
        const listing = await call('memory_read', { project_name: B, target_project: [A], queries: [{ limit: 10 }] });
        expect(JSON.stringify(listing)).not.toContain('budget');
        expect(JSON.stringify(listing)).not.toContain('Sup3rS3cret');
    });

    it('rejects more than 5 projects and honours strict heat', async () => {
        const msg = await fails('memory_read', { project_name: B, target_project: ['a', 'b', 'c', 'd', 'e', 'f'], queries: [{ query_text: 'x' }] });
        expect(msg).toMatch(/At most 5/);
        const strict = await call('memory_read', { project_name: B, target_project: [A], queries: [{ query_text: 'volcano eruption lava flow geology', heat: 10 }] });
        expect(strict).toEqual([]);
    });

    it('foreign update needs expected_version, keeps the previous version, and reports conflicts', async () => {
        const msg = await fails('memory_update', { project_name: B, target_project: A, items: [{ id: state.e1, content: 'Use npm' }] });
        expect(msg).toMatch(/expected_version is required/);

        const updated = await call('memory_update', { project_name: B, target_project: A, items: [{ id: state.e1, content: 'Use pnpm workspaces; pin pnpm 9', expected_version: 1 }] });
        expect(updated[0].version).toBe(2);

        const stale = await fails('memory_update', { project_name: B, target_project: A, items: [{ id: state.e1, content: 'stale write', expected_version: 1 }] });
        expect(stale).toMatch(/now v2/);

        const read = await call('memory_read', { project_name: A, queries: [{ memory_type: 'systemPatterns', limit: 20 }] });
        const e1 = read.find((r: any) => r.id === state.e1);
        expect(e1.version).toBe(2);
        expect(e1.previous.content).toContain('Use pnpm workspaces for the monorepo');
        expect(e1.previous.written_by).toBe(A);

        const history = await call('memory_admin', { project_name: A, op: 'history', ids: [state.e1] });
        expect(history).toHaveLength(1);
        expect(history[0].version).toBe(1);
    });

    it('foreign callers cannot change visibility', async () => {
        const msg = await fails('memory_update', { project_name: B, target_project: A, items: [{ id: state.e1, private: true, expected_version: 2 }] });
        expect(msg).toMatch(/Only the owning project/);
    });

    it('own-project concurrent updates all land without expected_version', async () => {
        const results = await Promise.all([1, 2, 3].map(n =>
            call('memory_update', { project_name: A, items: [{ id: state.e1, metadata: { [`k${n}`]: n } }] })
        ));
        for (const r of results) expect(r[0].error).toBeUndefined();
        const read = await call('memory_read', { project_name: A, queries: [{ memory_type: 'systemPatterns', limit: 20 }] });
        const e1 = read.find((r: any) => r.id === state.e1);
        expect(Object.keys(e1.metadata).sort()).toEqual(['k1', 'k2', 'k3']);
        expect(e1.previous).toBeUndefined();
        state.version = e1.version;
    });

    it('with the same expected_version exactly one concurrent update wins', async () => {
        const settled = await Promise.all([1, 2, 3].map(n =>
            raw('memory_update', { project_name: A, items: [{ id: state.e1, content: `racer ${n}`, expected_version: state.version }] })
        ));
        const wins = settled.filter((r: any) => !r.isError);
        expect(wins).toHaveLength(1);
    });

    it('foreign delete archives; the owner lists, restores and purges', async () => {
        const del = await call('memory_delete', { project_name: B, target_project: A, ids: [state.e1] });
        expect(del).toEqual({ deleted: 1, archived: true });
        const again = await call('memory_delete', { project_name: B, target_project: A, ids: [state.e1] });
        expect(again.deleted).toBe(0);

        const gone = await call('memory_read', { project_name: A, queries: [{ memory_type: 'systemPatterns', limit: 20 }] });
        expect(gone.find((r: any) => r.id === state.e1)).toBeUndefined();

        const archive = await call('memory_admin', { project_name: A, op: 'list_archive' });
        expect(archive.find((r: any) => r.id === state.e1).deleted_by).toBe(B);

        const restored = await call('memory_admin', { project_name: A, op: 'restore', ids: [state.e1] });
        expect(restored[0].restored).toBe(true);
        const back = await call('memory_read', { project_name: A, queries: [{ memory_type: 'systemPatterns', limit: 20 }] });
        expect(back.find((r: any) => r.id === state.e1)).toBeDefined();

        await call('memory_delete', { project_name: B, target_project: A, ids: [state.e1] });
        const purged = await call('memory_admin', { project_name: A, op: 'purge', ids: [state.e1] });
        expect(purged.purged).toBe(1);
        expect(await call('memory_admin', { project_name: A, op: 'list_archive' })).toEqual([]);
    });

    it('own-project delete is permanent', async () => {
        const del = await call('memory_delete', { project_name: A, ids: ['hive-e3'] });
        expect(del).toEqual({ deleted: 1 });
        expect(await call('memory_admin', { project_name: A, op: 'list_archive' })).toEqual([]);
    });

    it('a foreign write lands in a public project and is refused in a private one', async () => {
        const created = await call('memory_create', { project_name: B, target_project: A, items: [{ memory_type: 'customData', id: 'hive-guest', content: 'Note from project B about the build cache' }] });
        expect(created[0].project).toBe(A);
        const dup = await fails('memory_create', { project_name: B, target_project: A, items: [{ memory_type: 'customData', id: 'hive-guest', content: 'again' }] });
        expect(dup).toMatch(/already exists/);

        await call('memory_admin', { project_name: A, op: 'set_visibility', visibility: 'private' });
        const refused = await fails('memory_create', { project_name: B, target_project: A, items: [{ memory_type: 'customData', content: 'should not land' }] });
        expect(refused).toMatch(/not found or not shared/);
        const hidden = await call('memory_read', { project_name: B, target_project: [A], queries: [{ query_text: 'build cache note', heat: 1 }] });
        expect(hidden).toEqual([]);
        const list = await call('memory_admin', { project_name: B, op: 'list_projects' });
        expect(list.map((p: any) => p.project)).not.toContain(A);

        await call('memory_update', { project_name: A, items: [{ id: 'hive-guest', private: false }] });
        const shared = await call('memory_read', { project_name: B, target_project: [A], queries: [{ query_text: 'build cache note', heat: 1 }] });
        expect(shared.some((r: any) => r.content.includes('build cache'))).toBe(true);
        await call('memory_admin', { project_name: A, op: 'set_visibility', visibility: 'public' });
    });
});
