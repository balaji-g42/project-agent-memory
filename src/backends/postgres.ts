import pg from "pg";
import config from "../config.js";

const DISTANCE_OPERATORS: Record<string, { op: string; score: (d: number) => number }> = {
    Cosine: { op: "<=>", score: d => 1 - d },
    Euclid: { op: "<->", score: d => d },
    Dot: { op: "<#>", score: d => -d }
};

type Point = { id: string | number; vector: number[]; payload?: Record<string, any> | null };
type MatchClause = { key: string; match: { value?: any; any?: any[] } };
type Filter = { must?: MatchClause[] } | null | undefined;

function toVectorLiteral(vector: number[]): string {
    return `[${vector.join(",")}]`;
}

function parseVector(raw: unknown): number[] {
    if (Array.isArray(raw)) return raw as number[];
    if (typeof raw === "string") return JSON.parse(raw);
    return [];
}

function connectionString(): string {
    const url = new URL(config.POSTGRES_URL);
    if (!url.password && config.POSTGRES_PASSWORD) {
        url.password = config.POSTGRES_PASSWORD;
    }
    return url.toString();
}

function distance(): { op: string; score: (d: number) => number } {
    return DISTANCE_OPERATORS[config.DISTANCE_METRIC] || DISTANCE_OPERATORS.Cosine;
}

class PostgresVectorClient {
    private pool: pg.Pool;
    private ready: Promise<void> | null = null;

    constructor() {
        this.pool = new pg.Pool({
            connectionString: connectionString(),
            max: config.POOL_SIZE
        });
    }

    private async ensureSchema(): Promise<void> {
        if (!this.ready) {
            this.ready = this.createSchema().catch(err => {
                this.ready = null;
                throw err;
            });
        }
        return this.ready;
    }

    private async createSchema(): Promise<void> {
        const dim = config.VECTOR_DIM;
        await this.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS memory_collections (
                name TEXT PRIMARY KEY,
                vector_size INTEGER NOT NULL,
                distance TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS memory_points (
                collection TEXT NOT NULL,
                id TEXT NOT NULL,
                payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                embedding vector(${dim}) NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (collection, id)
            )
        `);
        await this.pool.query(
            "CREATE INDEX IF NOT EXISTS memory_points_payload_idx ON memory_points USING gin (payload)"
        );
        await this.pool.query(
            `CREATE INDEX IF NOT EXISTS memory_points_embedding_idx ON memory_points USING hnsw (embedding vector_cosine_ops)`
        );
        await this.pool.query(
            "CREATE INDEX IF NOT EXISTS memory_points_updated_idx ON memory_points (collection, updated_at DESC)"
        );

        const { rows } = await this.pool.query<{ dims: number | null }>(
            "SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid = 'memory_points'::regclass AND attname = 'embedding'"
        );
        const actual = rows[0]?.dims;
        if (actual != null && actual > 0 && actual !== dim) {
            throw new Error(
                `memory_points.embedding is vector(${actual}) but VECTOR_DIM=${dim}. ` +
                `Set VECTOR_DIM=${actual}, or migrate the table with ` +
                `ALTER TABLE memory_points ALTER COLUMN embedding TYPE vector(${dim}) ` +
                `after re-embedding every row. No data was changed.`
            );
        }
    }

    private filterSql(filter: Filter, params: any[]): string {
        const must = filter?.must ?? [];
        const clauses = must.map(clause => {
            const path = clause.key.split(".");
            params.push(path);
            const pathParam = `$${params.length}::text[]`;
            const values = clause.match.any ?? [clause.match.value];
            const tests = values.map(value => {
                params.push(JSON.stringify(value ?? null));
                return `(payload #> ${pathParam}) @> $${params.length}::jsonb`;
            });
            return `(${tests.join(" OR ")})`;
        });
        return clauses.length ? ` AND ${clauses.join(" AND ")}` : "";
    }

    async getCollections(): Promise<{ collections: Array<{ name: string }> }> {
        await this.ensureSchema();
        const { rows } = await this.pool.query<{ name: string }>(
            "SELECT name FROM memory_collections ORDER BY name"
        );
        return { collections: rows.map(r => ({ name: r.name })) };
    }

    async getCollection(name: string): Promise<any> {
        await this.ensureSchema();
        const { rows } = await this.pool.query(
            `SELECT c.vector_size, c.distance,
                    (SELECT count(*) FROM memory_points p WHERE p.collection = c.name) AS points_count
             FROM memory_collections c WHERE c.name = $1`,
            [name]
        );
        if (rows.length === 0) throw new Error(`Collection ${name} not found`);
        return {
            config: { params: { vectors: { size: rows[0].vector_size, distance: rows[0].distance } } },
            points_count: Number(rows[0].points_count)
        };
    }

    async createCollection(name: string, options: { vectors: { size: number; distance: string } }): Promise<boolean> {
        await this.ensureSchema();
        if (options.vectors.size !== config.VECTOR_DIM) {
            throw new Error(
                `Cannot create ${name} with vector size ${options.vectors.size}: ` +
                `memory_points stores vector(${config.VECTOR_DIM}).`
            );
        }
        await this.pool.query(
            `INSERT INTO memory_collections (name, vector_size, distance) VALUES ($1, $2, $3)
             ON CONFLICT (name) DO NOTHING`,
            [name, options.vectors.size, options.vectors.distance]
        );
        return true;
    }

    async deleteCollection(name: string): Promise<boolean> {
        await this.ensureSchema();
        await this.pool.query("DELETE FROM memory_points WHERE collection = $1", [name]);
        await this.pool.query("DELETE FROM memory_collections WHERE name = $1", [name]);
        return true;
    }

    async upsert(name: string, options: { wait?: boolean; points: Point[] }): Promise<any> {
        await this.ensureSchema();
        if (options.points.length === 0) return { status: "completed" };

        const params: any[] = [name];
        const tuples = options.points.map(point => {
            params.push(String(point.id), JSON.stringify(point.payload ?? {}), toVectorLiteral(point.vector));
            const i = params.length;
            return `($1, $${i - 2}, $${i - 1}::jsonb, $${i}::vector)`;
        });

        await this.pool.query(
            `INSERT INTO memory_points (collection, id, payload, embedding) VALUES ${tuples.join(", ")}
             ON CONFLICT (collection, id) DO UPDATE
             SET payload = EXCLUDED.payload, embedding = EXCLUDED.embedding, updated_at = now()`,
            params
        );
        return { status: "completed" };
    }

    async retrieve(
        name: string,
        options: { ids: Array<string | number>; with_payload?: boolean; with_vector?: boolean }
    ): Promise<Array<{ id: string; payload?: Record<string, any>; vector?: number[] }>> {
        await this.ensureSchema();
        if (options.ids.length === 0) return [];
        const { rows } = await this.pool.query(
            `SELECT id, payload, embedding FROM memory_points
             WHERE collection = $1 AND id = ANY($2::text[])`,
            [name, options.ids.map(String)]
        );
        return rows.map(row => ({
            id: row.id,
            ...(options.with_payload === false ? {} : { payload: row.payload }),
            ...(options.with_vector ? { vector: parseVector(row.embedding) } : {})
        }));
    }

    async search(
        name: string,
        options: { vector: number[]; limit?: number; filter?: Filter; with_payload?: boolean; with_vector?: boolean }
    ): Promise<Array<{ id: string; score: number; payload?: Record<string, any>; version: number }>> {
        await this.ensureSchema();
        const { op, score } = distance();
        const params: any[] = [name, toVectorLiteral(options.vector)];
        const where = this.filterSql(options.filter, params);
        params.push(options.limit ?? 10);

        const { rows } = await this.pool.query(
            `SELECT id, payload, embedding ${op} $2::vector AS distance
             FROM memory_points
             WHERE collection = $1${where}
             ORDER BY embedding ${op} $2::vector
             LIMIT $${params.length}`,
            params
        );
        return rows.map(row => ({
            id: row.id,
            version: 0,
            score: score(Number(row.distance)),
            ...(options.with_payload === false ? {} : { payload: row.payload })
        }));
    }

    async scroll(
        name: string,
        options: { filter?: Filter; limit?: number; with_payload?: boolean; with_vector?: boolean }
    ): Promise<{ points: Array<{ id: string; payload?: Record<string, any> }>; next_page_offset: null }> {
        await this.ensureSchema();
        const params: any[] = [name];
        const where = this.filterSql(options.filter, params);
        params.push(options.limit ?? 10);

        const { rows } = await this.pool.query(
            `SELECT id, payload FROM memory_points
             WHERE collection = $1${where}
             ORDER BY updated_at DESC
             LIMIT $${params.length}`,
            params
        );
        return {
            points: rows.map(row => ({
                id: row.id,
                ...(options.with_payload === false ? {} : { payload: row.payload })
            })),
            next_page_offset: null
        };
    }

    async delete(name: string, options: { wait?: boolean; points: Array<string | number> }): Promise<any> {
        await this.ensureSchema();
        await this.pool.query(
            "DELETE FROM memory_points WHERE collection = $1 AND id = ANY($2::text[])",
            [name, options.points.map(String)]
        );
        return { status: "completed" };
    }
}

export { PostgresVectorClient };
