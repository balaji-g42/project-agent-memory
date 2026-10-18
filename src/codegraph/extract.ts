import { execFile } from "child_process";
import { readdir, readFile, stat } from "fs/promises";
import { extname, join, posix } from "path";
import { promisify } from "util";
import { Language, Parser, Query, type Node } from "web-tree-sitter";
import { GRAMMAR_DIR, LANGUAGES, type LanguageSpec } from "./languages.js";

const execFileAsync = promisify(execFile);

const MAX_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".venv", "__pycache__"]);
const CLASS_KINDS = new Set(["class", "interface", "enum", "container"]);
const JS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const JVM_EXTS = [".java", ".kt", ".kts"];

export interface GraphNode {
    id: string;
    label: string;
    source_file: string;
    source_location: string;
}

export interface GraphEdge {
    source: string;
    target: string;
    relation: string;
    confidence?: string;
}

interface Scope {
    kind: string;
    name: string;
    scope?: string;
    node: Node;
    start: number;
    end: number;
    qualified: string;
    id: string;
}

interface PendingCall {
    file: string;
    from: string;
    name: string;
    member: boolean;
    type?: string;
    path: string[];
    exact: boolean;
}

let parserReady: Promise<void> | undefined;
const loaded = new Map<string, { language: Language; query: Query }>();

async function load(spec: LanguageSpec) {
    let entry = loaded.get(spec.grammar);
    if (!entry) {
        const language = await Language.load(join(GRAMMAR_DIR, `tree-sitter-${spec.grammar}.wasm`));
        entry = { language, query: new Query(language, spec.query) };
        loaded.set(spec.grammar, entry);
    }
    return entry;
}

async function walk(root: string, rel: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
        const path = rel ? posix.join(rel, entry.name) : entry.name;
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) out.push(...(await walk(root, path)));
        } else if (entry.isFile()) {
            out.push(path);
        }
    }
    return out;
}

async function listFiles(root: string): Promise<string[]> {
    try {
        const { stdout } = await execFileAsync(
            "git",
            ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            { cwd: root, maxBuffer: 256 * 1024 * 1024, windowsHide: true }
        );
        return stdout.split("\0").filter(Boolean);
    } catch {
        return walk(root, "");
    }
}

function resolveImport(grammar: string, rel: string, raw: string, files: Set<string>, byStem: Map<string, string[]>): string | undefined {
    const dir = posix.dirname(rel);
    const pick = (candidates: string[]) => candidates.map((c) => posix.normalize(c)).find((c) => files.has(c));

    if (grammar === "javascript" || grammar === "typescript" || grammar === "tsx") {
        if (!raw.startsWith(".") && !raw.startsWith("@/")) return undefined;
        const base = raw.startsWith("@/") ? `src/${raw.slice(2)}` : posix.join(dir, raw);
        const stripped = base.match(/^(.*)\.[mc]?jsx?$/)?.[1];
        return pick([
            base,
            ...JS_EXTS.map((e) => base + e),
            ...JS_EXTS.map((e) => `${base}/index${e}`),
            ...(stripped ? JS_EXTS.map((e) => stripped + e) : [])
        ]);
    }
    if (grammar === "dart") {
        const spec = raw.slice(1, -1);
        if (spec.startsWith("dart:")) return undefined;
        if (spec.startsWith("package:")) return pick([`lib/${spec.slice(spec.indexOf("/") + 1)}`]);
        return pick([posix.join(dir, spec)]);
    }
    if (grammar === "python") {
        const dots = raw.match(/^\.+/)?.[0].length ?? 0;
        const mod = raw.slice(dots).replace(/\./g, "/");
        const bases = dots
            ? [posix.join(dir, ...Array(dots - 1).fill(".."), mod)]
            : [mod, `src/${mod}`, posix.join(dir, mod)];
        return pick(bases.flatMap((b) => [`${b}.py`, `${b}/__init__.py`]));
    }
    if (grammar === "java" || grammar === "kotlin") {
        const path = raw.replace(/\./g, "/");
        return byStem.get(raw.split(".").pop() ?? "")?.find((f) => {
            const noExt = f.slice(0, -extname(f).length);
            return noExt === path || noExt.endsWith(`/${path}`);
        });
    }
    return undefined;
}

export async function extractCodeGraph(root: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const files: string[] = [];
    for (const rel of await listFiles(root)) {
        if (!LANGUAGES[extname(rel).toLowerCase()]) continue;
        try {
            if ((await stat(join(root, rel))).size <= MAX_FILE_BYTES) files.push(rel);
        } catch {
            continue;
        }
    }

    const fileSet = new Set(files);
    const byStem = new Map<string, string[]>();
    for (const f of files) {
        if (!JVM_EXTS.includes(extname(f))) continue;
        const stem = posix.basename(f, extname(f));
        byStem.set(stem, [...(byStem.get(stem) ?? []), f]);
    }

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const calls: PendingCall[] = [];
    const imports = new Map<string, Set<string>>();
    const defsByFile = new Map<string, Map<string, string[]>>();
    const defsGlobal = new Map<string, Set<string>>();
    const methods = new Set<string>();
    const fieldTypes = new Map<string, string | null>();
    parserReady ??= Parser.init();
    await parserReady;
    const parser = new Parser();

    for (const rel of files) {
        const spec = LANGUAGES[extname(rel).toLowerCase()];
        const { language, query } = await load(spec);
        let source: string;
        try {
            source = await readFile(join(root, rel), "utf-8");
        } catch {
            continue;
        }
        parser.setLanguage(language);
        const tree = parser.parse(source);
        if (!tree) continue;

        nodes.push({ id: rel, label: posix.basename(rel), source_file: rel, source_location: "L1" });

        const scopes: Scope[] = [];
        const seen = new Set<number>();
        const fileImports = new Set<string>();
        const fileCalls = new Map<number, { node: Node; name: string; member: boolean; receiver?: string }>();
        const declTypes = new Map<string, string | null>();
        const decls: { name: string; type: string; pos: number }[] = [];

        for (const match of query.matches(tree.rootNode)) {
            const cap = new Map(match.captures.map((c) => [c.name, c.node]));
            const declNode = cap.get("decl.name");
            const declType = cap.get("decl.type")?.text;
            if (declNode && declType) {
                const known = declTypes.get(declNode.text);
                declTypes.set(declNode.text, known === undefined || known === declType ? declType : null);
                decls.push({ name: declNode.text, type: declType, pos: declNode.startIndex });
                continue;
            }
            const name = cap.get("name")?.text;
            const sourceNode = cap.get("source");
            if (sourceNode) {
                const target = resolveImport(spec.grammar, rel, sourceNode.text, fileSet, byStem);
                if (target && target !== rel) fileImports.add(target);
                continue;
            }
            if (!name) continue;
            const callNode = cap.get("call") ?? cap.get("call.member");
            if (callNode) {
                const receiver = cap.get("receiver")?.text;
                if (!fileCalls.has(callNode.id) || receiver) fileCalls.set(callNode.id, { node: callNode, name, member: cap.has("call.member"), receiver });
                continue;
            }
            const defCapture = match.captures.find((c) => c.name.startsWith("definition.") || c.name === "container");
            if (!defCapture || seen.has(defCapture.node.id)) continue;
            seen.add(defCapture.node.id);
            const node = defCapture.node;
            scopes.push({
                kind: defCapture.name === "container" ? "container" : defCapture.name.slice("definition.".length),
                name,
                scope: cap.get("scope")?.text,
                node,
                start: node.startIndex,
                end: node.endIndex,
                qualified: "",
                id: ""
            });
        }

        scopes.sort((a, b) => a.start - b.start || b.end - a.end);
        const parents = new Map<Scope, Scope | undefined>();
        const stack: Scope[] = [];
        for (const s of scopes) {
            while (stack.length && stack[stack.length - 1].end < s.end) stack.pop();
            const parent = stack[stack.length - 1];
            parents.set(s, parent);
            s.qualified = s.scope ? `${s.scope}.${s.name}` : parent ? `${parent.qualified}.${s.name}` : s.name;
            s.id = `${rel}::${s.qualified}`;
            if ((s.kind === "function" || s.kind === "method") && (s.scope || (parent && CLASS_KINDS.has(parent.kind)))) {
                s.kind = "method";
            }
            stack.push(s);
        }

        const innermost = (pos: number) => {
            let found: Scope | undefined;
            for (const s of scopes) if (s.start <= pos && pos < s.end && (!found || s.start >= found.start)) found = s;
            return found;
        };
        for (const d of decls) {
            const owner = innermost(d.pos);
            if (!owner || !CLASS_KINDS.has(owner.kind)) continue;
            const key = `${owner.name}.${d.name}`;
            const known = fieldTypes.get(key);
            fieldTypes.set(key, known === undefined || known === d.type ? d.type : null);
        }

        const defs = scopes.filter((s) => s.kind !== "container");
        const ids = new Set<string>();
        const local = new Map<string, string[]>();
        for (const s of defs) {
            if (ids.has(s.id)) continue;
            ids.add(s.id);
            const callable = s.kind === "function" || s.kind === "method";
            nodes.push({
                id: s.id,
                label: callable ? `${s.kind === "method" ? "." : ""}${s.name}()` : s.name,
                source_file: rel,
                source_location: `L${s.node.startPosition.row + 1}`
            });
            local.set(s.name, [...(local.get(s.name) ?? []), s.id]);
            if (s.kind === "method") methods.add(s.id);
            defsGlobal.set(s.name, (defsGlobal.get(s.name) ?? new Set()).add(s.id));
        }
        for (const s of defs) {
            const parent = parents.get(s);
            const owner = s.scope ? `${rel}::${s.scope}` : parent?.id;
            edges.push({ source: owner && ids.has(owner) ? owner : rel, target: s.id, relation: "contains" });
        }

        for (const call of fileCalls.values()) {
            const pos = call.node.startIndex;
            let caller: Scope | undefined;
            for (const s of defs) {
                if (s.start <= pos && pos < s.end && (!caller || s.start >= caller.start)) caller = s;
            }
            const declared = call.receiver ? declTypes.get(call.receiver) ?? undefined : undefined;
            const asType = !declared && call.receiver && /^[A-Z]\w*$/.test(call.receiver) ? call.receiver : undefined;
            const parts = call.receiver?.replace(/[!?]/g, "").split(".") ?? [];
            let cls = caller;
            while (cls && !CLASS_KINDS.has(cls.kind)) cls = parents.get(cls);
            const head = parts.length > 1 && parts.every((p) => /^\w+$/.test(p))
                ? parts[0] === "this" || parts[0] === "self" ? cls?.name : declTypes.get(parts[0]) ?? undefined
                : undefined;
            calls.push({
                file: rel,
                from: caller?.id ?? rel,
                name: call.name,
                member: call.member,
                type: head ?? declared ?? asType,
                path: head ? parts.slice(1) : [],
                exact: !head && !!asType
            });
        }

        for (const target of fileImports) edges.push({ source: rel, target, relation: "imports" });
        imports.set(rel, fileImports);
        defsByFile.set(rel, local);
        tree.delete();
    }
    parser.delete();

    for (const call of calls) {
        const pick = (ids: string[]) => {
            if (ids.length === 1) return ids[0];
            const plain = call.member ? [] : ids.filter((id) => !methods.has(id));
            return plain.length === 1 ? plain[0] : undefined;
        };
        const notSelf = (ids: Iterable<string>) => [...ids].filter((id) => id !== call.from);
        const same = notSelf(defsByFile.get(call.file)?.get(call.name) ?? []);
        const imported = notSelf([...(imports.get(call.file) ?? [])].flatMap((f) => defsByFile.get(f)?.get(call.name) ?? []));
        const owner = (id: string) => id.split("::")[1].split(".").slice(-2, -1)[0];
        let type = call.type;
        for (const field of call.path) type = type ? fieldTypes.get(`${type}.${field}`) ?? undefined : undefined;
        if (type) {
            const typed = notSelf(defsGlobal.get(call.name) ?? []).filter((id) => owner(id) === type);
            const near = typed.filter((id) => [call.file, ...(imports.get(call.file) ?? [])].includes(id.split("::")[0]));
            const target = typed.length === 1 ? typed[0] : near.length === 1 ? near[0] : undefined;
            if (target) edges.push({ source: call.from, target, relation: "calls", confidence: call.exact ? "EXTRACTED" : "INFERRED" });
            continue;
        }
        const global = notSelf(defsGlobal.get(call.name) ?? []).filter((id) => (call.member ? !owner(id) : !methods.has(id)));
        const target = same.length ? pick(same) : imported.length ? pick(imported) : pick(global);
        const confidence = same.length || imported.length ? "EXTRACTED" : "INFERRED";
        if (target) edges.push({ source: call.from, target, relation: "calls", confidence });
    }

    return { nodes, edges };
}
