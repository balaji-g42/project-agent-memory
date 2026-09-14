import "dotenv/config";
import { createHmac } from "node:crypto";
import { QdrantClient } from "@qdrant/js-client-rest";
import axios from "axios";

function parseArgs(argv) {
    const args = {
        project: undefined,
        all: false,
        qdrantUrl: process.env.QDRANT_URL,
        qdrantApiKey: process.env.QDRANT_API_KEY,
        prestUrl: process.env.PREST_URL,
        prestJwtKey: process.env.PREST_JWT_KEY,
        prestAdmin: process.env.PREST_REGISTER_ADMIN || "admin",
        prestDatabase: process.env.PREST_DATABASE || "memory",
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
            case "--prest-url": args.prestUrl = next(); break;
            case "--prest-jwt-key": args.prestJwtKey = next(); break;
            case "--prest-admin": args.prestAdmin = next(); break;
            case "--prest-database": args.prestDatabase = next(); break;
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

One-time copy of Qdrant collection(s) into the pREST/pgvector backend's
schema. Both backends stay independent afterwards - this does not enable
any ongoing sync. Writes go through pREST's registered-query mechanism,
the same one the MCP server's PrestVectorClient uses - no direct
Postgres TCP connection is made.

Required (one of):
  --project <name>          Source collection is memory_bank_<name>
  --all                     Migrate every collection on the Qdrant server, using
                             each collection's own name in Postgres

Options (fall back to the matching env var, then a default):
  --qdrant-url <url>        default: $QDRANT_URL or http://localhost:6333
  --qdrant-api-key <key>    default: $QDRANT_API_KEY
  --prest-url <url>         default: $PREST_URL
  --prest-jwt-key <key>     default: $PREST_JWT_KEY
  --prest-admin <username>  default: $PREST_REGISTER_ADMIN or admin
  --prest-database <name>   default: $PREST_DATABASE or memory
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

function toVectorHeaderValue(vector) {
    return vector.map(v => v.toFixed(5)).join(" ");
}

function base64url(input) {
    return Buffer.from(input)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function signPrestAdminJwt(key, username) {
    const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = base64url(JSON.stringify({
        UserInfo: { id: 0, name: "", username, metadata: null },
        exp: Math.floor(Date.now() / 1000) + 300
    }));
    const signature = base64url(createHmac("sha256", key).update(`${header}.${payload}`).digest());
    return `${header}.${payload}.${signature}`;
}

class Prest {
    constructor(args) {
        if (!args.prestUrl) throw new Error("PREST_URL is not configured (pass --prest-url or set $PREST_URL)");
        if (!args.prestJwtKey) throw new Error("PREST_JWT_KEY is not configured (pass --prest-jwt-key or set $PREST_JWT_KEY)");
        this.url = args.prestUrl;
        this.database = args.prestDatabase;
        this.jwtKey = args.prestJwtKey;
        this.admin = args.prestAdmin;
    }

    authHeader() {
        return { Authorization: `Bearer ${signPrestAdminJwt(this.jwtKey, this.admin)}` };
    }

    async register(location, name, readSql, writeSql) {
        const body = { database: this.database, location, name, read_sql: readSql };
        if (writeSql) body.write_sql = writeSql;
        await axios.post(`${this.url}/_QUERIES/registry`, body, { headers: this.authHeader() })
            .catch(async err => {
                if (err.response?.status === 409 || err.response?.status === 400) {
                    await axios.put(`${this.url}/_QUERIES/registry/${location}/${name}`, body, { headers: this.authHeader() });
                    return;
                }
                throw err;
            });
    }

    buildParams(params) {
        const qs = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
                for (const v of value) qs.append(key, v);
            } else {
                qs.append(key, String(value));
            }
        }
        return qs;
    }

    async write(location, name, params = {}, extraHeaders) {
        const qs = this.buildParams(params);
        const { data } = await axios.post(
            `${this.url}/_QUERIES/${this.database}/${location}/${name}?${qs.toString()}`,
            {},
            { headers: { ...this.authHeader(), ...extraHeaders } }
        );
        return data;
    }
}

async function ensureSchema(prest, dim) {
    await prest.register("memory", "setup_extension", "SELECT 1", "CREATE EXTENSION IF NOT EXISTS vector");
    await prest.register(
        "memory",
        "setup_collections_table",
        "SELECT 1",
        `CREATE TABLE IF NOT EXISTS memory_collections (
            name TEXT PRIMARY KEY,
            vector_size INTEGER NOT NULL,
            distance TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`
    );
    await prest.register(
        "memory",
        "setup_points_table",
        "SELECT 1",
        `CREATE TABLE IF NOT EXISTS memory_points (
            collection TEXT NOT NULL,
            id TEXT NOT NULL,
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            embedding vector(${dim}) NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (collection, id)
        )`
    );
    await prest.register(
        "memory",
        "setup_payload_idx",
        "SELECT 1",
        "CREATE INDEX IF NOT EXISTS memory_points_payload_idx ON memory_points USING gin (payload)"
    );
    await prest.register(
        "memory",
        "setup_embedding_idx",
        "SELECT 1",
        "CREATE INDEX IF NOT EXISTS memory_points_embedding_idx ON memory_points USING hnsw (embedding vector_cosine_ops)"
    );
    await prest.register(
        "memory",
        "setup_updated_idx",
        "SELECT 1",
        "CREATE INDEX IF NOT EXISTS memory_points_updated_idx ON memory_points (collection, updated_at DESC)"
    );

    for (const name of [
        "setup_extension",
        "setup_collections_table",
        "setup_points_table",
        "setup_payload_idx",
        "setup_embedding_idx",
        "setup_updated_idx"
    ]) {
        await prest.write("memory", name, {});
    }

    await prest.register(
        "memory",
        "migrate_create_collection",
        "SELECT 1",
        `INSERT INTO memory_collections (name, vector_size, distance)
         VALUES ({{sqlVal "name"}}, {{sqlVal "vector_size"}}, {{sqlVal "distance"}})
         ON CONFLICT (name) DO NOTHING`
    );
    await prest.register(
        "memory",
        "migrate_upsert_point",
        "SELECT 1",
        `INSERT INTO memory_points (collection, id, payload, embedding)
         VALUES ({{sqlVal "collection"}}, {{sqlVal "id"}}, {{sqlVal "payload"}}::jsonb, ('[' || replace({{sqlVal "header.X-Vector"}}, ' ', ',') || ']')::vector)
         ON CONFLICT (collection, id) DO UPDATE
         SET payload = EXCLUDED.payload, embedding = EXCLUDED.embedding, updated_at = now()`
    );
}

async function migrateCollection(qdrant, prest, collection, args) {
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
        await prest.write("memory", "migrate_create_collection", {
            name: collection,
            vector_size: args.vectorDim,
            distance: args.distance
        });
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
            for (const point of page.points) {
                const vector = truncateAndNormalize(Array.isArray(point.vector) ? point.vector : [], args.vectorDim);
                await prest.write("memory", "migrate_upsert_point", {
                    collection,
                    id: String(point.id),
                    payload: JSON.stringify(point.payload ?? {})
                }, { "X-Vector": toVectorHeaderValue(vector) });
            }
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

    let prest;
    if (!args.dryRun) {
        prest = new Prest(args);
        await ensureSchema(prest, args.vectorDim);
    } else {
        console.log("--dry-run: no pREST writes will be made.");
    }

    const results = [];
    for (const collection of collections) {
        results.push(await migrateCollection(qdrant, prest, collection, args));
    }

    const migratedTotal = results.reduce((sum, r) => sum + r.migrated, 0);
    const skipped = results.filter(r => r.skipped);
    console.log(`\nDone. ${migratedTotal} points ${args.dryRun ? "read" : "migrated"} across ${results.length - skipped.length}/${results.length} collections.`);
    if (skipped.length > 0) {
        console.log(`Skipped (narrower than --vector-dim=${args.vectorDim}): ${skipped.map(r => r.collection).join(", ")}`);
    }
}

main().catch(err => {
    console.error("\nMigration failed:", err.message);
    process.exit(1);
});
