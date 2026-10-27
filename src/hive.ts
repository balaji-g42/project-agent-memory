import { client } from "./init.js";
import config from "./config.js";
import {
    BANK_PREFIX,
    SCHEMA_VERSION,
    SESSION_ID,
    SETTINGS_TYPE,
    archiveName,
    bankName,
    settingsPointId,
    supersededPointId
} from "./hiveConstants.js";

export type Visibility = "public" | "private";
type Clause = { key: string; match: { value?: any; any?: any[] } };
type HiveFilter = { must: Clause[]; must_not: Clause[] };

const PLACEHOLDER_PREFIX = "Initial placeholder for ";
const CATALOGUE_SCAN = 200;
const ARCHIVE_SCAN = 500;

const SECRET_PATTERNS: RegExp[] = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /\bAIza[0-9A-Za-z_-]{35}\b/,
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@/i,
    /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\b["']?\s*[:=]\s*["']?(?=\S*\d)\S{8,}/i
];

export function looksSecret(text: string): boolean {
    return SECRET_PATTERNS.some(pattern => pattern.test(text));
}

export function visibilityFromFlag(isPrivate?: boolean): Visibility | undefined {
    if (isPrivate === undefined) return undefined;
    return isPrivate ? "private" : "public";
}

export function versionOf(payload: Record<string, any> | null | undefined): number {
    return typeof payload?.version === "number" ? payload.version : 1;
}

export function casFilter(payload: Record<string, any>): { must: Clause[] } {
    return typeof payload.version === "number"
        ? { must: [{ key: "version", match: { value: payload.version } }] }
        : { must: [{ key: "timestamp", match: { value: payload.timestamp } }] };
}

export function foreignFilter(project: string, defaultVisibility: Visibility, extraMust: Clause[] = []): HiveFilter {
    const must: Clause[] = [{ key: "project", match: { value: project } }, ...extraMust];
    const must_not: Clause[] = [
        { key: "type", match: { value: SETTINGS_TYPE } },
        { key: "type", match: { value: "knowledgeLink" } }
    ];
    if (defaultVisibility === "public") {
        must_not.push({ key: "visibility", match: { value: "private" } });
    } else {
        must.push({ key: "visibility", match: { value: "public" } });
    }
    return { must, must_not };
}

export function isVisibleToForeign(payload: Record<string, any> | null | undefined, defaultVisibility: Visibility): boolean {
    if (!payload) return false;
    if (payload.type === SETTINGS_TYPE || payload.type === "knowledgeLink") return false;
    if (String(payload.content ?? "").startsWith(PLACEHOLDER_PREFIX)) return false;
    return (payload.visibility ?? defaultVisibility) === "public";
}

export async function bankExists(project: string): Promise<boolean> {
    const { collections } = await client.getCollections();
    return collections.some((c: { name: string }) => c.name === bankName(project));
}

export async function projectVisibility(project: string): Promise<Visibility> {
    const [settings] = await client.retrieve(bankName(project), { ids: [settingsPointId(project)], with_payload: true });
    return settings?.payload?.visibility === "private" ? "private" : "public";
}

function settingsPoint(project: string, visibility: Visibility) {
    return {
        id: settingsPointId(project),
        vector: Array(config.VECTOR_DIM).fill(0),
        payload: {
            type: SETTINGS_TYPE,
            content: "Project settings",
            visibility,
            schema_version: SCHEMA_VERSION,
            timestamp: new Date().toISOString(),
            project
        }
    };
}

export async function ensureProjectSettings(project: string): Promise<boolean> {
    const existing = await client.retrieve(bankName(project), { ids: [settingsPointId(project)], with_payload: false });
    if (existing.length > 0) return false;
    await client.upsert(bankName(project), { wait: true, update_mode: "insert_only", points: [settingsPoint(project, "public")] });
    return true;
}

export async function setProjectVisibility(project: string, visibility: Visibility): Promise<Visibility> {
    if (!(await bankExists(project))) throw new Error(`Project ${project} has no memory bank`);
    await client.upsert(bankName(project), { wait: true, points: [settingsPoint(project, visibility)] });
    return visibility;
}

export async function ensureArchive(project: string): Promise<string> {
    const name = archiveName(project);
    const { collections } = await client.getCollections();
    if (!collections.some((c: { name: string }) => c.name === name)) {
        await client.createCollection(name, { vectors: { size: config.VECTOR_DIM as number, distance: "Cosine" } });
    }
    return name;
}

async function archiveExists(project: string): Promise<boolean> {
    const { collections } = await client.getCollections();
    return collections.some((c: { name: string }) => c.name === archiveName(project));
}

export function snapshotOf(payload: Record<string, any>) {
    return {
        content: payload.content,
        version: versionOf(payload),
        written_by: payload.written_by ?? null,
        written_by_session: payload.written_by_session ?? null,
        timestamp: payload.timestamp
    };
}

export async function archiveSuperseded(project: string, memoryId: string | number, vector: number[], payload: Record<string, any>): Promise<void> {
    const name = await ensureArchive(project);
    const { previous: _drop, ...rest } = payload;
    await client.upsert(name, {
        wait: true,
        points: [{
            id: supersededPointId(String(memoryId), versionOf(payload)),
            vector,
            payload: { ...rest, kind: "superseded", of: String(memoryId), archived_at: new Date().toISOString() }
        }]
    });
}

export async function archiveDeleted(project: string, deletedBy: string, memoryId: string | number, vector: number[], payload: Record<string, any>): Promise<void> {
    const name = await ensureArchive(project);
    await client.upsert(name, {
        wait: true,
        points: [{
            id: memoryId,
            vector,
            payload: { ...payload, kind: "deleted", of: String(memoryId), deleted_by: deletedBy, deleted_by_session: SESSION_ID, archived_at: new Date().toISOString() }
        }]
    });
}

export function conflictMessage(memoryId: string, payload: Record<string, any>): string {
    const version = versionOf(payload);
    return `Conflict: ${memoryId} changed since you read it (now v${version}). Re-read, merge, and retry with expected_version=${version}. Current content: ${payload.content}`;
}

export async function listProjects(exclude: string): Promise<Array<Record<string, any>>> {
    const { collections } = await client.getCollections();
    const projects = collections
        .map((c: { name: string }) => c.name)
        .filter((name: string) => name.startsWith(BANK_PREFIX))
        .map((name: string) => name.slice(BANK_PREFIX.length))
        .filter((project: string) => project !== exclude);

    const rows = await Promise.all(projects.map(async (project: string): Promise<Record<string, any> | null> => {
        const visibility = await projectVisibility(project).catch(() => "public" as Visibility);
        const page = await client.scroll(bankName(project), {
            filter: foreignFilter(project, visibility),
            limit: CATALOGUE_SCAN,
            with_payload: true,
            with_vector: false
        });
        const visible = page.points.filter(p => isVisibleToForeign(p.payload, visibility));
        if (visible.length === 0) return null;
        const overview = visible.find(p => p.payload?.type === "productContext");
        let description = "";
        try {
            description = String(JSON.parse(String(overview?.payload?.content ?? "{}")).description ?? "");
        } catch {
            description = "";
        }
        const lastUpdated = visible.map(p => String(p.payload?.timestamp ?? "")).sort().pop();
        return {
            project,
            description: description.slice(0, 160),
            entries: visible.length,
            ...(page.next_page_offset != null || page.points.length >= CATALOGUE_SCAN ? { more: true } : {}),
            last_updated: lastUpdated
        };
    }));
    return rows.filter((row): row is Record<string, any> => row !== null).sort((a, b) => a.project.localeCompare(b.project));
}

export async function listArchive(project: string, limit = 50): Promise<Array<Record<string, any>>> {
    if (!(await archiveExists(project))) return [];
    const page = await client.scroll(archiveName(project), {
        filter: { must: [{ key: "kind", match: { value: "deleted" } }] },
        limit: ARCHIVE_SCAN,
        with_payload: true,
        with_vector: false
    });
    return page.points
        .map(p => ({
            id: p.id,
            type: p.payload?.type,
            content: p.payload?.content,
            deleted_by: p.payload?.deleted_by,
            deleted_at: p.payload?.archived_at
        }))
        .sort((a, b) => String(b.deleted_at).localeCompare(String(a.deleted_at)))
        .slice(0, limit);
}

export async function historyOf(project: string, memoryId: string, limit = 10): Promise<Array<Record<string, any>>> {
    if (!(await archiveExists(project))) return [];
    const page = await client.scroll(archiveName(project), {
        filter: { must: [{ key: "of", match: { value: memoryId } }, { key: "kind", match: { value: "superseded" } }] },
        limit: ARCHIVE_SCAN,
        with_payload: true,
        with_vector: false
    });
    return page.points
        .map(p => ({ version: versionOf(p.payload), content: p.payload?.content, written_by: p.payload?.written_by, written_by_session: p.payload?.written_by_session, timestamp: p.payload?.timestamp }))
        .sort((a, b) => b.version - a.version)
        .slice(0, limit);
}

export async function restoreFromArchive(project: string, ids: string[]): Promise<Array<Record<string, any>>> {
    if (!(await archiveExists(project))) return ids.map(id => ({ id, restored: false, error: "not in archive" }));
    const archive = archiveName(project);
    const bank = bankName(project);
    return Promise.all(ids.map(async id => {
        const [record] = await client.retrieve(archive, { ids: [id], with_payload: true, with_vector: true });
        if (!record || record.payload?.kind !== "deleted") return { id, restored: false, error: "not in archive" };
        const [current] = await client.retrieve(bank, { ids: [id], with_payload: false });
        if (current) return { id, restored: false, error: "an entry with this id already exists" };
        const { kind: _k, of: _o, archived_at: _a, deleted_by: _d, deleted_by_session: _s, ...payload } = record.payload;
        await client.upsert(bank, { wait: true, update_mode: "insert_only", points: [{ id, vector: record.vector as number[], payload }] });
        await client.delete(archive, { wait: true, points: [id] });
        return { id, restored: true };
    }));
}

export async function purgeArchive(project: string, ids: string[]): Promise<number> {
    if (!(await archiveExists(project))) return 0;
    const archive = archiveName(project);
    let purged = 0;
    for (const id of ids) {
        const history = await client.scroll(archive, {
            filter: { must: [{ key: "of", match: { value: id } }] },
            limit: ARCHIVE_SCAN,
            with_payload: false,
            with_vector: false
        });
        const found = history.points.map(p => p.id);
        if (found.length === 0) continue;
        await client.delete(archive, { wait: true, points: found });
        purged++;
    }
    return purged;
}

export async function upgradeProjects(options: { dryRun?: boolean; privateProjects?: string[] } = {}): Promise<Array<Record<string, any>>> {
    const { collections } = await client.getCollections();
    const projects = collections
        .map((c: { name: string }) => c.name)
        .filter((name: string) => name.startsWith(BANK_PREFIX))
        .map((name: string) => name.slice(BANK_PREFIX.length));
    const markPrivate = new Set(options.privateProjects ?? []);
    const report: Array<Record<string, any>> = [];
    for (const project of projects) {
        const existing = await client.retrieve(bankName(project), { ids: [settingsPointId(project)], with_payload: true });
        const current: Visibility | null = existing[0] ? (existing[0].payload?.visibility === "private" ? "private" : "public") : null;
        const target: Visibility = markPrivate.has(project) ? "private" : (current ?? "public");
        const change = current === null ? "create settings" : current !== target ? `visibility ${current} -> ${target}` : "none";
        if (!options.dryRun && change !== "none") {
            if (current === null) {
                await ensureProjectSettings(project);
                if (target === "private") await setProjectVisibility(project, "private");
            } else {
                await setProjectVisibility(project, target);
            }
        }
        report.push({ project, visibility: target, change });
    }
    return report;
}
