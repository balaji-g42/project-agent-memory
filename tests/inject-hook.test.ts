import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOOK = path.resolve('hooks', 'inject.cjs');
const HOOKS_JSON = path.resolve('hooks', 'hooks.json');
const PLUGIN_NAMES = ['mcp__plugin_pam_mem__', 'mcp__mem__'];
const LEGACY_PREFIX = 'mcp__plugin_project-agent-memory_pam__';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pam-hook-home-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'pam-hook-proj-'));
const projectName = path.basename(project);
const stateDir = path.join(home, '.claude', 'state');

function run(payload: Record<string, any>, extra: Record<string, string> = {}): string {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, USERPROFILE: home };
    for (const key of Object.keys(env)) {
        if (key === 'CLAUDE_PLUGIN_ROOT' || key.startsWith('PAM_') || key === 'MODE') delete env[key];
    }
    const res = spawnSync('node', [HOOK], { input: JSON.stringify(payload), env: { ...env, ...extra }, encoding: 'utf8' });
    return res.stdout;
}

const state = (name: string) => path.join(stateDir, `pam-${name}`);
const exists = (name: string) => fs.existsSync(state(name));

beforeEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.mkdirSync(stateDir, { recursive: true });
});

afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
});

describe('PostToolUse tool-name matching', () => {
    it.each(PLUGIN_NAMES)('%scode_graph op=query marks the session as having queried the graph', (prefix) => {
        run({ hook_event_name: 'PostToolUse', session_id: 's1', cwd: project, tool_name: `${prefix}code_graph`, tool_input: { op: 'query', project_name: projectName } });
        expect(exists('codegraph-used-s1')).toBe(true);
    });

    it('the legacy pam__ tool name no longer matches', () => {
        run({ hook_event_name: 'PostToolUse', session_id: 's1', cwd: project, tool_name: `${LEGACY_PREFIX}code_graph`, tool_input: { op: 'query', project_name: projectName } });
        expect(exists('codegraph-used-s1')).toBe(false);
    });

    it.each(PLUGIN_NAMES.flatMap(prefix => ['create', 'update'].map(op => `${prefix}memory_${op}`)))('%s clears the pending-commit sentinel', (tool) => {
        fs.writeFileSync(state('pending-commit-s2.json'), JSON.stringify({ sha: 'abc1234', subject: 'x', project: projectName, blocks: 0 }));
        run({ hook_event_name: 'PostToolUse', session_id: 's2', cwd: project, tool_name: tool, tool_input: {} });
        expect(exists('pending-commit-s2.json')).toBe(false);
        expect(fs.readFileSync(state('logged-commit-s2.json'), 'utf8')).toBe('abc1234');
    });

    it('a legacy-named memory_create leaves the sentinel in place', () => {
        fs.writeFileSync(state('pending-commit-s3.json'), JSON.stringify({ sha: 'abc1234' }));
        run({ hook_event_name: 'PostToolUse', session_id: 's3', cwd: project, tool_name: `${LEGACY_PREFIX}memory_create`, tool_input: {} });
        expect(exists('pending-commit-s3.json')).toBe(true);
    });
});

describe('PreToolUse Grep/Glob gate', () => {
    const indexed = () => fs.writeFileSync(state(`codegraph-${projectName}.json`), JSON.stringify({ indexed: true, nodes: 1 }));
    const grep = () => run({ hook_event_name: 'PreToolUse', session_id: 's4', cwd: project, tool_name: 'Grep', tool_input: { pattern: 'x' } });

    it('denies Grep on an indexed project until the graph has been queried', () => {
        indexed();
        const out = JSON.parse(grep());
        expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    it('allows Grep once a code_graph query has been recorded', () => {
        indexed();
        run({ hook_event_name: 'PostToolUse', session_id: 's4', cwd: project, tool_name: 'mcp__plugin_pam_mem__code_graph', tool_input: { op: 'query', project_name: projectName } });
        expect(grep()).toBe('');
    });

    it('nudges once with the workspace root when the project is not indexed', () => {
        const first = JSON.parse(grep());
        expect(first.hookSpecificOutput.additionalContext).toContain(`op=index root=${project}`);
        expect(grep()).toBe('');
    });
});

describe('hooks.json matcher', () => {
    const matcher = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8')).hooks.PostToolUse
        .map((g: any) => g.matcher as string)
        .find((m: string) => m?.includes('memory_'));
    const matches = (tool: string) => new RegExp(`^(?:${matcher})$`).test(tool);

    it.each(['Bash', 'PowerShell', 'mcp__plugin_pam_mem__memory_create', 'mcp__mem__memory_update', 'mcp__plugin_pam_mem__code_graph', 'mcp__mem__code_graph'])('matches %s', (tool) => {
        expect(matches(tool)).toBe(true);
    });

    it.each([`${LEGACY_PREFIX}memory_create`, 'mcp__plugin_pam_mem__memory_read', 'Read'])('does not match %s', (tool) => {
        expect(matches(tool)).toBe(false);
    });
});

describe('SessionStart update notice', () => {
    const cacheFile = () => state('update-check.json');
    const cache = (latest: string, extra: Record<string, any> = {}) =>
        fs.writeFileSync(cacheFile(), JSON.stringify({ latest, checkedAt: Date.now(), ...extra }));
    const start = (extra: Record<string, string> = { CLAUDE_PLUGIN_ROOT: path.resolve('.') }) =>
        run({ hook_event_name: 'SessionStart', session_id: 's5', cwd: project }, extra);

    it('announces a newer npm version once and records it', () => {
        cache('99.0.0');
        const first = start();
        expect(first).toContain('PLUGIN UPDATE');
        expect(first).toContain('99.0.0');
        expect(first).toContain('claude plugin update pam@balaji-g42');
        expect(JSON.parse(fs.readFileSync(cacheFile(), 'utf8')).notified).toBe('99.0.0');
        expect(start()).not.toContain('PLUGIN UPDATE');
    });

    it('announces again when a still newer version appears', () => {
        cache('99.0.1', { notified: '99.0.0' });
        expect(start()).toContain('99.0.1');
    });

    it('stays silent when the installed version is current', () => {
        cache('0.0.1');
        expect(start()).not.toContain('PLUGIN UPDATE');
    });

    it('stays silent outside plugin mode', () => {
        cache('99.0.0');
        expect(start({})).not.toContain('PLUGIN UPDATE');
    });

    it.each(['false', '0', 'off'])('UPDATE_CHECK=%s turns it off', (value) => {
        cache('99.0.0');
        expect(start({ CLAUDE_PLUGIN_ROOT: path.resolve('.'), UPDATE_CHECK: value })).not.toContain('PLUGIN UPDATE');
    });
});

describe('recall CLI resolution', () => {
    const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'pam-plugin-'));
    const fakeCli = path.join(plugin, 'fake-cli.js');

    beforeEach(() => {
        fs.mkdirSync(path.join(plugin, 'hooks'), { recursive: true });
        fs.copyFileSync(HOOK, path.join(plugin, 'hooks', 'inject.cjs'));
        fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'project-agent-memory', publishedVersion: '9.9.9' }));
        fs.writeFileSync(fakeCli, 'process.stdout.write("FAKE " + process.argv.slice(2).join(" "))');
        fs.mkdirSync(stateDir, { recursive: true });
    });

    afterAll(() => fs.rmSync(plugin, { recursive: true, force: true }));

    const recall = () => {
        const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, USERPROFILE: home };
        const payload = { hook_event_name: 'UserPromptSubmit', session_id: 'r1', cwd: project, prompt: 'how does recall reach the cli here' };
        return spawnSync('node', [path.join(plugin, 'hooks', 'inject.cjs')], { input: JSON.stringify(payload), env, encoding: 'utf8' }).stdout;
    };

    it('runs the cli path the server recorded, without npx', () => {
        fs.writeFileSync(state('cli.json'), JSON.stringify({ version: '9.9.9', path: fakeCli }));
        expect(recall()).toContain(`FAKE recall ${projectName}`);
    });

    it('shows the cli error instead of failing silently', () => {
        const failing = path.join(plugin, 'failing-cli.js');
        fs.writeFileSync(failing, 'process.stderr.write("noise\\nconnect ECONNREFUSED 127.0.0.1:1\\n"); process.exit(1)');
        fs.writeFileSync(state('cli.json'), JSON.stringify({ version: '9.9.9', path: failing }));
        expect(recall()).toContain('PAM recall failed: connect ECONNREFUSED 127.0.0.1:1');
    });

    it('ignores a recorded cli from another version', () => {
        fs.writeFileSync(state('cli.json'), JSON.stringify({ version: '1.0.0', path: fakeCli }));
        expect(recall()).not.toContain('FAKE');
    });
});
