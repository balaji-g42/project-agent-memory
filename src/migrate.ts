import config from "./config.js";
import { client, readVectorSize } from "./init.js";
import { getEmbeddingProvider } from "./embeddings.js";

const PAGE_SIZE = 64;
const PREFIX = "memory_bank_";
const BACKUP_SUFFIX = "_backup";

type RawPoint = { id: string | number; vector?: unknown; payload?: Record<string, any> | null };

interface MigrateOptions {
    dryRun: boolean;
    resume: boolean;
}

async function exists(name: string): Promise<boolean> {
    return (await client.getCollections()).collections.some((c) => c.name === name);
}

async function pointCount(name: string): Promise<number> {
    return Number((await client.getCollection(name)).points_count ?? 0);
}

async function* pages(name: string): AsyncGenerator<RawPoint[]> {
    let offset: unknown = undefined;
    do {
        const res = await (client as any).scroll(name, { limit: PAGE_SIZE, offset, with_payload: true, with_vector: true });
        yield res.points as RawPoint[];
        offset = res.next_page_offset;
    } while (offset !== null && offset !== undefined);
}

function textOf(payload: Record<string, any> | null | undefined): string {
    const content = payload?.content;
    return typeof content === "string" ? content : JSON.stringify(content ?? payload ?? {});
}

function isZero(vector: unknown): boolean {
    return Array.isArray(vector) && vector.every((x) => x === 0);
}

async function migrateProject(project: string, opts: MigrateOptions) {
    const target = `${PREFIX}${project}`;
    const backup = `${target}${BACKUP_SUFFIX}`;
    const hasTarget = await exists(target);
    const hasBackup = await exists(backup);

    if (!hasTarget && !hasBackup) throw new Error(`${target} not found`);
    if (hasBackup && !opts.resume) {
        throw new Error(
            `${backup} already exists from an earlier migrate. Re-run with --resume to finish that run, ` +
            `or delete it with memory_admin op=delete_collection project_name=${project}${BACKUP_SUFFIX}.`
        );
    }

    const source = hasBackup ? backup : target;
    const sourceInfo = await client.getCollection(source);
    const sourceSize = readVectorSize(sourceInfo.config?.params);
    const distance = sourceInfo.config?.params?.vectors?.distance || config.DISTANCE_METRIC;
    const plan = {
        project,
        source,
        source_vector_size: sourceSize,
        points: Number(sourceInfo.points_count ?? 0),
        target,
        target_vector_size: config.VECTOR_DIM,
        embedding: `${config.EMBEDDING_PROVIDER}/${config.EMBEDDING_MODEL}`,
        backup
    };
    if (opts.dryRun) return { ...plan, dry_run: true };
    if (sourceSize === undefined) throw new Error(`${source} uses named vectors, which migrate does not support`);

    if (!hasBackup) {
        await client.createCollection(backup, { vectors: { size: sourceSize, distance } });
        for await (const points of pages(target)) {
            await client.upsert(backup, {
                wait: true,
                points: points.map((p) => ({ id: p.id, vector: p.vector as number[], payload: p.payload ?? {} }))
            });
        }
    }

    if (await exists(target)) {
        const targetSize = readVectorSize((await client.getCollection(target)).config?.params);
        if (targetSize !== config.VECTOR_DIM) {
            const [backed, live] = [await pointCount(backup), await pointCount(target)];
            if (backed < live) {
                throw new Error(
                    `${backup} holds ${backed} points but ${target} holds ${live}. ${target} was left untouched. ` +
                    `Delete the backup and run migrate again.`
                );
            }
            await client.deleteCollection(target);
        }
    }
    if (!(await exists(target))) {
        await client.createCollection(target, { vectors: { size: config.VECTOR_DIM, distance } });
    }

    const provider = getEmbeddingProvider();
    for await (const points of pages(backup)) {
        const live = points.filter((p) => !isZero(p.vector));
        const vectors = live.length > 0 ? await provider.embedTexts(live.map((p) => textOf(p.payload))) : [];
        const byId = new Map(live.map((p, i) => [p.id, vectors[i]]));
        await client.upsert(target, {
            wait: true,
            points: points.map((p) => ({
                id: p.id,
                vector: byId.get(p.id) ?? Array(config.VECTOR_DIM).fill(0),
                payload: p.payload ?? {}
            }))
        });
    }

    const migrated = await pointCount(target);
    const backedUp = await pointCount(backup);
    if (migrated < backedUp) throw new Error(`${target} holds ${migrated} of ${backedUp} points. Run migrate --resume.`);
    return { ...plan, migrated };
}

async function migrate(projectOrAll: string, opts: MigrateOptions) {
    if (config.MEMORY_BACKEND !== "qdrant") {
        throw new Error(
            "migrate re-embeds Qdrant collections only. To move Qdrant data into Postgres, use skill/migrate-qdrant-to-pgvector.mjs."
        );
    }
    if (projectOrAll !== "--all") return [await migrateProject(projectOrAll, opts)];

    const projects = (await client.getCollections()).collections
        .map((c) => c.name)
        .filter((name) => name.startsWith(PREFIX) && !name.endsWith(BACKUP_SUFFIX))
        .map((name) => name.slice(PREFIX.length));
    const results = [];
    for (const project of projects) results.push(await migrateProject(project, opts));
    return results;
}

export { migrate };
