import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

type Env = Record<string, string>;
type Opts = Record<string, string | boolean>;

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
const VERSION: string = PKG.publishedVersion || PKG.version;
const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, ".claude");
const CLAUDE_JSON = path.join(HOME, ".claude.json");
const SETTINGS = path.join(CLAUDE_DIR, "settings.json");
const CONFIG_DIR = path.join(HOME, "mcp", "project-agent-memory");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const HOOK_DEST = path.join(CLAUDE_DIR, "hooks", "pam-inject.cjs");
const STAMP = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

const SERVER_KEY = "pam";
const LEGACY_KEYS = ["memory-qdrant-mcp", "memory", SERVER_KEY];
const PLUGIN_ID = "project-agent-memory@balaji-g42";
const MARKETPLACE = "balaji-g42/project-agent-memory";
const CHECK_PROJECT = "__pam_setup_check";
const MODES = ["plugin", "mcp", "skill", "vault"];
const BOOL_FLAGS = ["yes", "replace-memory"];
const VALUE_FLAGS = [
    "mode", "backend", "target", "qdrant-url", "qdrant-key",
    "prest-url", "prest-jwt-key", "prest-database", "prest-admin", "vault-path"
];
const PLUGIN_OPTIONS: Env = {
    memory_backend: "MEMORY_BACKEND",
    qdrant_url: "QDRANT_URL",
    qdrant_api_key: "QDRANT_API_KEY",
    postgres_url: "POSTGRES_URL",
    postgres_password: "POSTGRES_PASSWORD"
};

let opts: Opts = {};
let rl: Interface | null = null;

function log(msg: string) {
    console.log(`  ${msg}`);
}

function parseArgs(argv: string[]): Opts {
    const out: Opts = {};
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i].replace(/^--/, "");
        if (BOOL_FLAGS.includes(key)) out[key] = true;
        else if (VALUE_FLAGS.includes(key) && argv[i + 1] !== undefined) out[key] = argv[++i];
        else throw new Error(`Unknown or incomplete option: ${argv[i]}`);
    }
    return out;
}

async function ask(question: string, def?: string): Promise<string> {
    if (opts.yes) {
        if (def === undefined) throw new Error(`--yes given, but "${question}" has no default. Pass it as a flag.`);
        return def;
    }
    rl ??= createInterface({ input: process.stdin, output: process.stdout });
    for (;;) {
        const answer = (await rl.question(`${question}${def ? ` [${def}]` : ""}: `)).trim();
        if (answer || def !== undefined) return answer || def!;
    }
}

async function choose(question: string, options: string[], def: string, flag?: string): Promise<string> {
    const given = flag ? opts[flag] : undefined;
    if (typeof given === "string") {
        if (!options.includes(given)) throw new Error(`--${flag} must be one of: ${options.join(", ")}`);
        return given;
    }
    for (;;) {
        const answer = await ask(`${question} (${options.join("/")})`, def);
        if (options.includes(answer)) return answer;
    }
}

function flagOr(flag: string, question: string, def?: string): Promise<string> {
    const given = opts[flag];
    return typeof given === "string" ? Promise.resolve(given) : ask(question, def);
}

function readJson(file: string): any {
    if (!fs.existsSync(file)) return {};
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
        throw new Error(`${file} is not valid JSON (${(error as Error).message}). Fix it first; nothing was changed.`);
    }
}

function backup(file: string) {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${STAMP}`);
}

function writeJson(file: string, data: unknown, secret = false) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
    if (secret && process.platform !== "win32") fs.chmodSync(file, 0o600);
}

function posix(p: string): string {
    return p.replace(/\\/g, "/");
}

function mask(value: string | undefined): string {
    return value ? `****${value.slice(-4)}` : "none";
}

function describe(env: Env): string {
    if (env.MODE === "vault") return `vault at ${env.VAULT_PATH}`;
    if ((env.MEMORY_BACKEND || "qdrant").toLowerCase() === "postgres") {
        return `pgvector via pREST at ${env.PREST_URL} (JWT key ${mask(env.PREST_JWT_KEY)})`;
    }
    return `Qdrant at ${env.QDRANT_URL || "http://localhost:6333"} (API key ${mask(env.QDRANT_API_KEY)})`;
}

function run(cmd: string, args: string[], cwd?: string): number {
    const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    return r.status ?? 1;
}

function findExisting() {
    const servers = readJson(CLAUDE_JSON).mcpServers || {};
    const legacy = LEGACY_KEYS.filter((k) => k in servers);
    const env: Env = {};
    for (const key of legacy) Object.assign(env, servers[key].env || {});

    const options = (readJson(SETTINGS).pluginConfigs || {})[PLUGIN_ID]?.options || {};
    for (const [option, key] of Object.entries(PLUGIN_OPTIONS)) {
        if (options[option] && !env[key]) env[key] = String(options[option]);
    }

    const hasFile = fs.existsSync(CONFIG_FILE);
    if (hasFile) Object.assign(env, readJson(CONFIG_FILE));
    const sources = [...legacy.map((k) => `~/.claude.json "${k}"`), ...(hasFile ? [CONFIG_FILE] : [])];
    return { legacy, env, sources };
}

function secretFile(file: string): string {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
    const value = randomBytes(32).toString("base64url");
    fs.writeFileSync(file, value, { encoding: "utf8", mode: 0o600 });
    return value;
}

function startStack(backend: string): Env {
    if (spawnSync("docker", ["info"], { stdio: "ignore", shell: process.platform === "win32" }).status !== 0) {
        throw new Error("Docker is not running. Start it, or use --target cloud, or --mode vault.");
    }
    const dir = path.join(CONFIG_DIR, "stack", backend);
    fs.mkdirSync(dir, { recursive: true });
    const compose = path.join(dir, "compose.yml");
    if (!fs.existsSync(compose)) fs.copyFileSync(path.join(PKG_ROOT, "stack", backend, "compose.yml"), compose);

    let env: Env = { MEMORY_BACKEND: "qdrant", QDRANT_URL: "http://localhost:6333" };
    if (backend === "pgvector") {
        fs.mkdirSync(path.join(dir, "secrets"), { recursive: true });
        secretFile(path.join(dir, "secrets", "postgres_password.txt"));
        env = {
            MEMORY_BACKEND: "postgres",
            PREST_URL: "http://127.0.0.1:3000",
            PREST_JWT_KEY: secretFile(path.join(dir, "secrets", "prest_jwt_key.txt")),
            PREST_DATABASE: "memory",
            PREST_REGISTER_ADMIN: "admin"
        };
    }
    if (run("docker", ["compose", "up", "-d"], dir) !== 0) throw new Error(`docker compose up failed in ${dir}`);
    log(`${backend} stack started from ${dir}`);
    return env;
}

async function chooseStore(): Promise<Env> {
    const backend = await choose("Backend", ["qdrant", "pgvector"], "qdrant", "backend");
    const target = await choose("Target", ["local", "cloud"], "local", "target");
    if (target === "local") return startStack(backend);
    if (backend === "qdrant") {
        return {
            MEMORY_BACKEND: "qdrant",
            QDRANT_URL: await flagOr("qdrant-url", "Qdrant URL"),
            QDRANT_API_KEY: await flagOr("qdrant-key", "Qdrant API key (empty for none)", "")
        };
    }
    return {
        MEMORY_BACKEND: "postgres",
        PREST_URL: await flagOr("prest-url", "pREST URL"),
        PREST_JWT_KEY: await flagOr("prest-jwt-key", "pREST JWT key"),
        PREST_DATABASE: await flagOr("prest-database", "pREST database", "memory"),
        PREST_REGISTER_ADMIN: await flagOr("prest-admin", "pREST admin name", "admin")
    };
}

function writeConfig(env: Env): () => void {
    const existed = fs.existsSync(CONFIG_FILE);
    const original = existed ? fs.readFileSync(CONFIG_FILE) : null;
    backup(CONFIG_FILE);
    const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && String(v).trim() !== ""));
    writeJson(CONFIG_FILE, clean, true);
    log(`config written to ${CONFIG_FILE}`);
    return () => (original ? fs.writeFileSync(CONFIG_FILE, original) : fs.rmSync(CONFIG_FILE, { force: true }));
}

async function checkStore() {
    const { client, readVectorSize } = await import("./init.js");
    const config = (await import("./config.js")).default;

    let collections: Array<{ name: string }> = [];
    for (let attempt = 1; ; attempt++) {
        try {
            collections = (await client.getCollections()).collections;
            break;
        } catch (error) {
            if (attempt >= 30) throw new Error(`Store not reachable after 60 s: ${(error as Error).message}`);
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }
    log(`store reachable, ${collections.length} collections`);

    const mismatched: string[] = [];
    for (const { name } of collections.filter((c) => c.name.startsWith("memory_bank_"))) {
        const size = readVectorSize((await client.getCollection(name)).config?.params);
        if (size !== undefined && size !== config.VECTOR_DIM) mismatched.push(`${name} (${size})`);
    }
    if (mismatched.length === 0) return client;

    console.log(`\n  These collections do not match VECTOR_DIM=${config.VECTOR_DIM}: ${mismatched.join(", ")}`);
    const canMigrate = config.MEMORY_BACKEND === "qdrant";
    if (canMigrate && (await choose("Re-embed them now with the configured model (backups are kept)", ["no", "yes"], "no")) === "yes") {
        const { migrate } = await import("./migrate.js");
        await migrate("--all", { dryRun: false, resume: false });
        log("migration done");
        return client;
    }
    throw new Error(
        "Nothing was changed in the store. Set VECTOR_DIM and EMBEDDING_MODEL to the values that created " +
            "these collections" + (canMigrate ? ", or rerun setup and accept the migration." : ".")
    );
}

function mergeSettings(mode: string, vaultPath?: string) {
    const settings = readJson(SETTINGS);
    let changed = false;

    if (mode === "mcp" || mode === "vault") {
        fs.mkdirSync(path.dirname(HOOK_DEST), { recursive: true });
        fs.copyFileSync(path.join(PKG_ROOT, "hooks", "inject.cjs"), HOOK_DEST);
        const raw = fs.readFileSync(path.join(PKG_ROOT, "hooks", "hooks.json"), "utf8")
            .split("${CLAUDE_PLUGIN_ROOT}/hooks/inject.cjs").join(posix(HOOK_DEST));
        const hooks = settings.hooks ??= {};
        for (const [event, groups] of Object.entries(JSON.parse(raw).hooks as Record<string, any[]>)) {
            const have = hooks[event] ??= [];
            const keys = new Set(have.flatMap((g: any) => (g.hooks || []).map((h: any) => `${g.matcher ?? ""}|${h.command}`)));
            for (const group of groups) {
                if (group.hooks.some((h: any) => keys.has(`${group.matcher ?? ""}|${h.command}`))) continue;
                have.push(group);
                changed = true;
            }
        }
        log(`hook copied to ${HOOK_DEST}`);
    }

    const allow = mode === "plugin" ? "mcp__plugin_project-agent-memory_pam__*" : mode === "vault" ? null : "mcp__pam__*";
    if (allow) {
        const perms = settings.permissions ??= {};
        const list: string[] = perms.allow ??= [];
        if (!list.includes(allow)) {
            list.push(allow);
            changed = true;
        }
    }

    if (changed) {
        backup(SETTINGS);
        writeJson(SETTINGS, settings);
        log("settings.json merged (hooks and permissions added, nothing replaced)");
    }
    if (vaultPath) log(`vault mode adds no permissions; allow file tools for ${vaultPath} yourself if wanted`);
}

function copyDir(from: string, to: string, overwrite = true) {
    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(from, to, { recursive: true, force: overwrite, errorOnExist: false });
}

function register(mode: string, legacy: string[], replace: boolean, vaultPath?: string) {
    const data = readJson(CLAUDE_JSON);
    const servers = data.mcpServers ??= {};
    const drop = mode === "vault" ? (replace ? legacy : []) : legacy.filter((k) => mode === "plugin" || k !== SERVER_KEY);
    for (const key of drop) delete servers[key];
    const wantServer = mode === "mcp" || mode === "skill";
    const entry = process.platform === "win32"
        ? { command: "cmd", args: ["/c", "npx", "-y", `project-agent-memory@${VERSION}`] }
        : { command: "npx", args: ["-y", `project-agent-memory@${VERSION}`] };
    if (drop.length > 0 || wantServer) {
        if (wantServer) servers[SERVER_KEY] = entry;
        backup(CLAUDE_JSON);
        writeJson(CLAUDE_JSON, data);
        if (drop.length) log(`removed from ~/.claude.json: ${drop.join(", ")} (settings imported into config.json)`);
        if (wantServer) log(`registered "${SERVER_KEY}" -> project-agent-memory@${VERSION}`);
    }

    if (mode === "plugin") {
        if (run("claude", ["plugin", "marketplace", "add", MARKETPLACE]) !== 0) log("marketplace add failed - it may already be added");
        if (run("claude", ["plugin", "install", PLUGIN_ID]) !== 0) throw new Error(`claude plugin install ${PLUGIN_ID} failed`);
    }
    if (mode === "mcp" || mode === "skill") {
        copyDir(path.join(PKG_ROOT, "skill"), path.join(CLAUDE_DIR, "skills", "project-agent-memory"));
        log("skill copied to ~/.claude/skills/project-agent-memory");
    }
    if (mode === "mcp") {
        fs.mkdirSync(path.join(CLAUDE_DIR, "commands"), { recursive: true });
        fs.copyFileSync(path.join(PKG_ROOT, "commands", "memory-sync.md"), path.join(CLAUDE_DIR, "commands", "memory-sync.md"));
        log("command copied to ~/.claude/commands/memory-sync.md");
    }
    if (mode === "vault" && vaultPath) {
        copyDir(path.join(PKG_ROOT, "vault", "skill"), path.join(CLAUDE_DIR, "skills", "vault-memory"));
        copyDir(path.join(PKG_ROOT, "vault", "template"), vaultPath, false);
        fs.mkdirSync(path.join(vaultPath, "projects"), { recursive: true });
        log(`vault ready at ${vaultPath}, skill copied to ~/.claude/skills/vault-memory`);
    }
    mergeSettings(mode, vaultPath);
}

async function verify(client: { getCollections(): Promise<{ collections: Array<{ name: string }> }>; deleteCollection(name: string): Promise<unknown> }) {
    const r = spawnSync(process.execPath, [path.join(PKG_ROOT, "dist", "cli.js"), "context", CHECK_PROJECT], { encoding: "utf8" });
    for (const { name } of (await client.getCollections()).collections) {
        if (name.endsWith(`_${CHECK_PROJECT}`)) await client.deleteCollection(name);
    }
    if (r.status !== 0) throw new Error(`verify failed: ${(r.stderr || r.stdout).trim()}`);
    JSON.parse(r.stdout);
    log("verify passed: the CLI read config.json and reached the store");
}

function projectName(root: string): string {
    const match = (file: string, re: RegExp) => {
        try {
            return fs.readFileSync(path.join(root, file), "utf8").trim().match(re)?.[1].trim() || null;
        } catch {
            return null;
        }
    };
    const packageName = () => {
        try {
            const name = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name;
            return typeof name === "string" && name ? name : null;
        } catch {
            return null;
        }
    };
    return (
        match("pyproject.toml", /^\s*name\s*=\s*["']([^"']+)["']/m) ||
        match("setup.py", /name\s*=\s*["']([^"']+)["']/) ||
        match("setup.cfg", /^\s*name\s*=\s*(.+)$/m) ||
        packageName() ||
        match("pubspec.yaml", /^name:\s*(\S+)/m) ||
        path.basename(root) ||
        "default"
    );
}

function indexProject() {
    if (opts["no-index"]) {
        log("code index skipped (--no-index)");
        return;
    }
    try {
        const root = path.resolve(typeof opts["index-root"] === "string" ? opts["index-root"] : process.cwd());
        const name = projectName(path.normalize(root));
        log(`indexing ${root} as project ${name}`);
        const r = spawnSync(process.execPath, [path.join(PKG_ROOT, "dist", "cli.js"), "index", name, root], { encoding: "utf8" });
        if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-500));
        const { nodes } = JSON.parse(r.stdout);
        const stateDir = path.join(CLAUDE_DIR, "state");
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(path.join(stateDir, `pam-codegraph-${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`), JSON.stringify({ indexed: true, nodes }), "utf8");
        log(`code index: ${nodes} nodes`);
    } catch (error) {
        log(`warning: code index failed, run code_graph op=index later: ${(error as Error).message}`);
    }
}

export async function setup(argv: string[]) {
    opts = parseArgs(argv);
    console.log(`project-agent-memory ${VERSION} setup\n`);
    try {
        const mode = await choose("Install mode", MODES, "plugin", "mode");
        const existing = findExisting();
        let env: Env = {};
        let replace = false;

        if (existing.sources.length > 0) {
            log(`existing memory config: ${describe(existing.env)}`);
            log(`from: ${existing.sources.join(", ")}`);
            const answer = opts["replace-memory"] ? "replace" : await choose("Use it", ["reuse", "replace", "abort"], "reuse");
            if (answer === "abort") {
                log("aborted, nothing changed");
                return;
            }
            replace = answer === "replace";
            if (!replace) env = existing.env;
        }

        let vaultPath: string | undefined;
        if (mode === "vault") {
            vaultPath = path.resolve(await flagOr("vault-path", "Vault path", env.VAULT_PATH || path.join(CLAUDE_DIR, "vault")));
            env.VAULT_PATH = vaultPath;
        } else if (replace || !env.MEMORY_BACKEND && !env.QDRANT_URL && !env.PREST_URL) {
            env = await chooseStore();
        }
        env.MODE = mode;
        env.PAM_VERSION = VERSION;

        const restore = writeConfig(env);
        let client;
        if (mode !== "vault") {
            try {
                client = await checkStore();
            } catch (error) {
                restore();
                throw error;
            }
        }
        register(mode, existing.legacy, replace, vaultPath);
        if (client) {
            await verify(client);
            indexProject();
        }
        console.log(`\nDone (${describe(env)}). Restart Claude Code to load it.`);
    } finally {
        rl?.close();
    }
}
