import "dotenv/config";
import { QdrantClient } from "@qdrant/js-client-rest";
import pg from "pg";

function parseArgs(argv) {
    const args = {
        project: undefined,
        all: false,
        qdrantUrl: process.env.QDRANT_URL,
        qdrantApiKey: process.env.QDRANT_API_KEY,
        postgresUrl: process.env.POSTGRES_URL,
        postgresPassword: process.env.POSTGRES_PASSWORD,
        vectorDim: process.env.VECTOR_DIM ? parseInt(process.env.VECTOR_DIM, 10) : 768,
        distance: process.env.DISTANCE_METRIC || "Cosine",
        batchSize: 100,
        dryRun: false
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        switch (a) {
            case "--project": args.project = next(); break;
            case "--all": args.all = true; break;
            case "--qdrant-url": args.qdrantUrl = next(); break;
            case "--qdrant-api-key": args.qdrantApiKey = next(); break;
            case "--postgres-url": args.postgresUrl = next(); break;
            case "--postgres-password": args.postgresPassword = next(); break;
            case "--vector-dim": args.vectorDim = parseInt(next(), 10); break;
            case "--distance": args.distance = next(); break;
            case "--batch-size": args.batchSize = parseInt(next(), 10); break;
            case "--dry-run": args.dryRun = true; break;
            case "--help":
            case "-h":
                printHelp();
                process.exit(0);
        }
    }
    return args;
}

function printHelp() {
    console.log(`Usage: node skill/migrate-qdrant-to-pgvector.mjs (--project <name> | --all) [options]

One-time copy of Qdrant collection(s) into the Postgres/pgvector backend's
schema. Both backends stay independent afterwards - this does not enable
any ongoing sync.

Required (one of):
  --project <name>          Source collection is memory_bank_<name>
  --all                     Migrate every collection on the Qdrant server, using
                             each collection's own name in Postgres

Options (fall back to the matching env var, then a default):
  --qdrant-url <url>        default: $QDRANT_URL or http://localhost:6333
  --qdrant-api-key <key>    default: $QDRANT_API_KEY
  --postgres-url <url>      default: $POSTGRES_URL or postgresql://postgres@localhost:5432/memory
  --postgres-password <pw>  default: $POSTGRES_PASSWORD
  --vector-dim <n>          Target Postgres vector(n) width, shared by every migrated
                             collection. default: $VECTOR_DIM or 768
  --distance <name>         Cosine | Euclid | Dot. default: $DISTANCE_METRIC or Cosine
  --batch-size <n>          Points per upsert batch. default: 100
  --dry-run                 Read from Qdrant and report only; writes nothing to Postgres
  --help                    Show this help

Source vectors of any dimension are supported: vectors longer than
--vector-dim are truncated and re-normalized (Matryoshka-style, same
convention the onnx provider uses); vectors shorter than --vector-dim
cannot be extended. With --project this aborts the run; with --all that
one collection is skipped and the rest still migrate.
`);
}

function truncateAndNormalize(vector, target) {
    if (vector.length === target) return vector;
    if (vector.length < target) {
        throw new Error(
            `source vector has ${vector.length} dims, target vector(${target}) is wider. ` +
            `Re-run with --vector-dim=${vector.length} (or lower) - dimensions cannot be padded.`
        );
    }
    const sliced = vector.slice(0, target);
    const magnitude = Math.sqrt(sliced.reduce((sum, v) => sum + v * v, 0));
    return magnitude === 0 ? sliced : sliced.map(v => v / magnitude);
}

function connectionString(url, password) {
    const parsed = new URL(url);
    if (!parsed.password && password) parsed.password = password;
    return parsed.toString();
}

async function ensureSchema(pool, dim) {
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await pool.query(`
        CREATE TABLE IF NOT EXISTS memory_collections (
            name TEXT PRIMARY KEY,
            vector_size INTEGER NOT NULL,
            distance TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS memory_points (
            collection TEXT NOT NULL,
            id TEXT NOT NULL,
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            embedding vector(${dim}) NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (collection, id)
        )
    `);
    await pool.query("CREATE INDEX IF NOT EXISTS memory_points_payload_idx ON memory_points USING gin (payload)");
    await pool.query("CREATE INDEX IF NOT EXISTS memory_points_embedding_idx ON memory_points USING hnsw (embedding vector_cosine_ops)");
    await pool.query("CREATE INDEX IF NOT EXISTS memory_points_updated_idx ON memory_points (collection, updated_at DESC)");

    const { rows } = await pool.query(
        "SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid = 'memory_points'::regclass AND attname = 'embedding'"
    );
    const actual = rows[0]?.dims;
    if (actual != null && actual > 0 && actual !== dim) {
        throw new Error(`memory_points.embedding is already vector(${actual}); pass --vector-dim=${actual} or migrate that table first.`);
    }
}

async function migrateCollection(qdrant, pool, collection, args) {
    const info = await qdrant.getCollection(collection);
    const sourceDim = info.config?.params?.vectors?.size;
    console.log(`\n${collection}: ${info.points_count} points, ${sourceDim}-dim vectors, distance=${info.config?.params?.vectors?.distance}`);

    if (sourceDim && sourceDim > args.vectorDim) {
        console.log(`  truncating ${sourceDim} -> ${args.vectorDim} and re-normalizing`);
    } else if (sourceDim && sourceDim < args.vectorDim) {
        const message = `source is ${sourceDim}-dim, narrower than --vector-dim=${args.vectorDim}`;
        if (args.all) {
            console.error(`  skipped: ${message}`);
            return { collection, skipped: true, reason: message, migrated: 0 };
        }
        throw new Error(`${message}. Re-run with --vector-dim=${sourceDim}.`);
    }

    if (!args.dryRun) {
        await pool.query(
            `INSERT INTO memory_collections (name, vector_size, distance) VALUES ($1, $2, $3)
             ON CONFLICT (name) DO NOTHING`,
            [collection, args.vectorDim, args.distance]
        );
    }

    let migrated = 0;
    let offset;
    do {
        const page = await qdrant.scroll(collection, {
            limit: args.batchSize,
            offset,
            with_payload: true,
            with_vector: true
        });

        if (page.points.length === 0) break;

        if (!args.dryRun) {
            const params = [collection];
            const tuples = page.points.map(point => {
                const vector = truncateAndNormalize(Array.isArray(point.vector) ? point.vector : [], args.vectorDim);
                params.push(String(point.id), JSON.stringify(point.payload ?? {}), `[${vector.join(",")}]`);
                const i = params.length;
                return `($1, $${i - 2}, $${i - 1}::jsonb, $${i}::vector)`;
            });
            await pool.query(
                `INSERT INTO memory_points (collection, id, payload, embedding) VALUES ${tuples.join(", ")}
                 ON CONFLICT (collection, id) DO UPDATE
                 SET payload = EXCLUDED.payload, embedding = EXCLUDED.embedding, updated_at = now()`,
                params
            );
        }

        migrated += page.points.length;
        process.stdout.write(`\r  ${migrated} points ${args.dryRun ? "read" : "migrated"}...`);
        offset = page.next_page_offset ?? undefined;
    } while (offset !== undefined && offset !== null);

    console.log("");
    return { collection, skipped: false, migrated };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.project && !args.all) {
        printHelp();
        console.error("\nError: pass --project <name> or --all");
        process.exit(1);
    }
    if (args.project && args.all) {
        console.error("Error: pass only one of --project or --all");
        process.exit(1);
    }
    if (!Number.isInteger(args.vectorDim) || args.vectorDim < 1) {
        console.error(`Error: --vector-dim must be a positive integer, got ${args.vectorDim}`);
        process.exit(1);
    }

    const qdrantUrl = args.qdrantUrl || "http://localhost:6333";
    const qdrant = new QdrantClient({
        url: qdrantUrl,
        apiKey: args.qdrantApiKey,
        port: new URL(qdrantUrl).port ? Number(new URL(qdrantUrl).port) : (new URL(qdrantUrl).protocol === "https:" ? 443 : 6333),
        checkCompatibility: false
    });

    let collections;
    if (args.all) {
        console.log(`Listing collections on ${qdrantUrl} ...`);
        const { collections: found } = await qdrant.getCollections();
        const names = found.map(c => c.name);
        collections = names.filter(name => name.startsWith("memory_bank_"));
        const excluded = names.filter(name => !name.startsWith("memory_bank_"));
        console.log(`Found ${names.length}, ${collections.length} memory_bank_* collections: ${collections.join(", ")}`);
        if (excluded.length > 0) {
            console.log(`Excluded (not memory_bank_*, belongs to another app): ${excluded.join(", ")}`);
        }
    } else {
        collections = [`memory_bank_${args.project}`];
    }

    let pool;
    if (!args.dryRun) {
        pool = new pg.Pool({ connectionString: connectionString(args.postgresUrl || "postgresql://postgres@localhost:5432/memory", args.postgresPassword) });
        await ensureSchema(pool, args.vectorDim);
    } else {
        console.log("--dry-run: no Postgres writes will be made.");
    }

    const results = [];
    for (const collection of collections) {
        results.push(await migrateCollection(qdrant, pool, collection, args));
    }

    const migratedTotal = results.reduce((sum, r) => sum + r.migrated, 0);
    const skipped = results.filter(r => r.skipped);
    console.log(`\nDone. ${migratedTotal} points ${args.dryRun ? "read" : "migrated"} across ${results.length - skipped.length}/${results.length} collections.`);
    if (skipped.length > 0) {
        console.log(`Skipped (narrower than --vector-dim=${args.vectorDim}): ${skipped.map(r => r.collection).join(", ")}`);
    }

    if (pool) await pool.end();
}

main().catch(err => {
    console.error("\nMigration failed:", err.message);
    process.exit(1);
});
