import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pam-setup-home-'));
const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const settingsFile = path.join(home, '.claude', 'settings.json');
const hookDest = path.join(home, '.claude', 'hooks', 'pam-inject.cjs').replace(/\\/g, '/');
const hooksJson = JSON.parse(fs.readFileSync(path.resolve('hooks', 'hooks.json'), 'utf8')).hooks as Record<string, any[]>;

let setup: typeof import('../src/setup.js');
let init: typeof import('../src/init.js');

const readSettings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));

beforeAll(async () => {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    jest.spyOn(os, 'homedir').mockReturnValue(home);
    setup = await import('../src/setup.js');
    init = await import('../src/init.js');
});

afterAll(() => {
    jest.restoreAllMocks();
    for (const [key, value] of Object.entries(realHome)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
});

describe('parseArgs', () => {
    it('accepts --no-index as a boolean flag', () => {
        expect(setup.parseArgs(['--no-index'])).toEqual({ 'no-index': true });
    });

    it('accepts --index-root with a value', () => {
        expect(setup.parseArgs(['--index-root', './src', '--yes'])).toEqual({ 'index-root': './src', yes: true });
    });

    it('rejects --index-root without a value', () => {
        expect(() => setup.parseArgs(['--index-root'])).toThrow('Unknown or incomplete option');
    });

    it('rejects an unknown option', () => {
        expect(() => setup.parseArgs(['--nope'])).toThrow('Unknown or incomplete option');
    });
});

describe('mergeSettings hook groups', () => {
    const postToolGroups = () => readSettings().hooks.PostToolUse as any[];

    it('adds every hook group from hooks.json on a fresh install', () => {
        setup.mergeSettings('mcp');
        expect(postToolGroups().length).toBe(hooksJson.PostToolUse.length);
        expect(Object.keys(readSettings().hooks).sort()).toEqual(Object.keys(hooksJson).sort());
    });

    it('is idempotent on a second run', () => {
        const before = readSettings();
        setup.mergeSettings('mcp');
        expect(readSettings()).toEqual(before);
    });

    it('replaces a stale pam group instead of duplicating it, and keeps foreign hooks', () => {
        const settings = readSettings();
        const staleMatcher = 'Bash|PowerShell|mcp__(plugin_project-agent-memory_)?pam__(memory_(create|update)|code_graph)';
        const current = hooksJson.PostToolUse.find((g: any) => g.matcher?.includes('memory_')).matcher;
        settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter((g: any) => g.matcher !== current);
        settings.hooks.PostToolUse.push({ matcher: staleMatcher, hooks: [{ type: 'command', command: `node "${hookDest}"` }] });
        settings.hooks.PostToolUse.push({ matcher: 'Foo', hooks: [{ type: 'command', command: 'node other.js' }] });
        fs.writeFileSync(settingsFile, JSON.stringify(settings));

        setup.mergeSettings('mcp');

        const matchers = postToolGroups().map((g: any) => g.matcher);
        expect(matchers).not.toContain(staleMatcher);
        expect(matchers.filter((m: string) => m === current).length).toBe(1);
        expect(matchers).toContain('Foo');
        expect(postToolGroups().length).toBe(hooksJson.PostToolUse.length + 1);
    });
});

describe('qdrantPort', () => {
    it.each([
        ['http://qdrant.lan', 80],
        ['https://abc.cloud.qdrant.io', 443],
        ['http://localhost:6333', 6333],
        ['https://host.example:6333', 6333]
    ])('%s -> %i', (url, port) => {
        expect(init.qdrantPort(url as string)).toBe(port);
    });
});
