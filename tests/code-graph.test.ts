import { describe, it, expect } from '@jest/globals';
import { parseGraph, renderCodeGraph } from '../src/mcp_tools/codeGraph.js';
import type { CodeNode } from '../src/mcp_tools/codeGraph.js';

const ROOT = process.platform === 'win32' ? 'C:\\repo' : '/repo';
const abs = (p: string) => (process.platform === 'win32' ? `${ROOT}\\${p.replace(/\//g, '\\')}` : `${ROOT}/${p}`);

const graph = {
    nodes: [
        { id: 'a', label: 'main()', source_file: abs('src/index.ts'), source_location: 'L10' },
        { id: 'b', label: 'loadConfig()', source_file: 'src/config.ts', source_location: 'L3' },
        { id: 'c', label: 'config.ts', source_file: 'src/config.ts' }
    ],
    links: [
        { source: 'a', target: 'b', relation: 'calls', confidence: 'EXTRACTED' },
        { source: 'a', target: 'b', relation: 'calls', confidence: 'EXTRACTED' },
        { source: 'c', target: 'b', relation: 'contains' },
        { source: 'a', target: 'missing', relation: 'calls' },
        { source: 'a', target: 'a', relation: 'calls' }
    ]
};

describe('parseGraph', () => {
    const nodes = parseGraph(graph, ROOT);
    const byId = new Map(nodes.map(n => [n.node_id, n]));

    it('keeps every node and makes paths repo-relative with forward slashes', () => {
        expect(nodes).toHaveLength(3);
        expect(byId.get('a')!.source_file).toBe('src/index.ts');
        expect(byId.get('b')!.source_file).toBe('src/config.ts');
    });

    it('stores both edge directions on each node, deduped, dropping dangling and self edges', () => {
        expect(byId.get('a')!.out).toEqual([{ id: 'b', relation: 'calls', confidence: 'EXTRACTED' }]);
        expect(byId.get('b')!.in).toEqual([
            { id: 'a', relation: 'calls', confidence: 'EXTRACTED' },
            { id: 'c', relation: 'contains' }
        ]);
        expect(byId.get('a')!.in).toEqual([]);
    });

    it('accepts the "edges" key and gives stable hashes that change with the edges', () => {
        const again = parseGraph({ nodes: graph.nodes, edges: graph.links }, ROOT);
        expect(again.map(n => n.hash)).toEqual(nodes.map(n => n.hash));
        const fewer = parseGraph({ nodes: graph.nodes, edges: graph.links.slice(2) }, ROOT);
        expect(fewer.find(n => n.node_id === 'a')!.hash).not.toBe(byId.get('a')!.hash);
        expect(fewer.find(n => n.node_id === 'c')!.hash).toBe(byId.get('c')!.hash);
    });
});

describe('renderCodeGraph', () => {
    it('lists seeds first with edges resolved to labels and locations', () => {
        const nodes = parseGraph(graph, ROOT);
        const map = new Map<string, CodeNode>(nodes.map(n => [n.node_id, n]));
        const out = renderCodeGraph(['b'], map);
        const lines = out.trim().split('\n');
        expect(lines[0]).toBe('* loadConfig()  src/config.ts:L3');
        expect(out).toContain('  <-calls- main() (src/index.ts:L10)');
        expect(out).toContain('- main()  src/index.ts:L10');
        expect(out).toContain('  -calls-> loadConfig() (src/config.ts:L3)');
    });

    it('reports no matches for an empty result', () => {
        expect(renderCodeGraph([], new Map())).toBe('No matching code nodes.');
    });
});
