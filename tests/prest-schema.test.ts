import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pam-prest-home-'));
const marker = path.join(home, 'mcp', 'project-agent-memory', 'prest-schema.key');
let registryCalls = 0;
let failSearch = 0;
let server: http.Server;
let Client: any;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            if (req.url?.startsWith('/_QUERIES/registry')) registryCalls++;
            if (req.url?.includes('/search_points') && failSearch > 0) {
                failSearch--;
                res.writeHead(404).end('query not found');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' }).end('[]');
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    Object.assign(process.env, {
        PREST_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        PREST_JWT_KEY: 'test-key'
    });
    jest.unstable_mockModule('node:os', () => ({ ...os, default: { ...os, homedir: () => home }, homedir: () => home }));
    ({ PrestVectorClient: Client } = await import('../src/backends/prest.js'));
});

afterAll(() => {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
});

const search = () => new Client().query('c', { query: [0.1, 0.2] });

describe('pREST schema marker', () => {
    it('runs the setup once, then skips it in a new client', async () => {
        await search();
        expect(registryCalls).toBeGreaterThan(0);
        expect(fs.existsSync(marker)).toBe(true);

        registryCalls = 0;
        await search();
        expect(registryCalls).toBe(0);
    });

    it('reruns the setup and retries when pREST rejects a call after a skip', async () => {
        registryCalls = 0;
        failSearch = 1;
        await expect(search()).resolves.toEqual({ points: [] });
        expect(registryCalls).toBeGreaterThan(0);
        expect(fs.existsSync(marker)).toBe(true);
    });

    it('reruns the setup when the marker does not match', async () => {
        fs.writeFileSync(marker, 'stale', 'utf8');
        registryCalls = 0;
        await search();
        expect(registryCalls).toBeGreaterThan(0);
    });
});
