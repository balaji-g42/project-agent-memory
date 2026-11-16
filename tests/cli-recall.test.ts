import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import type { AddressInfo } from 'net';

let server: http.Server;
let url = '';

beforeAll(async () => {
    server = http.createServer(() => {});
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
    server.closeAllConnections();
    server.close();
});

describe('cli recall deadline', () => {
    it('gives up after 6 s with a reason when the backend never answers', async () => {
        const env = {
            ...process.env,
            MEMORY_BACKEND: 'postgres',
            PREST_URL: url,
            PREST_JWT_KEY: 'x',
            EMBEDDING_PROVIDER: 'openai',
            OPENAI_BASE_URL: `${url}/v1`,
            OPENAI_API_KEY: 'x'
        };
        const started = Date.now();
        const child = spawn('node', [path.resolve('dist', 'cli.js'), 'recall', 'p1'], { env });
        let stderr = '';
        child.stderr.on('data', chunk => (stderr += chunk));
        child.stdin.end('a prompt long enough to recall');
        const code = await new Promise(resolve => child.on('close', resolve));
        expect(code).toBe(1);
        expect(stderr).toContain('timeout 6 s');
        expect(Date.now() - started).toBeLessThan(8000);
    }, 15000);
});
