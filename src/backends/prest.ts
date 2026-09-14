import axios from "axios";
import config from "../config.js";
import type { VectorClient } from "../types.js";
import {
    toVectorHeaderValue,
    parseVector,
    distance,
    signPrestAdminJwt,
    registerPrestQuery,
    type Point,
    type Filter
} from "./postgres.js";

function baseUrl(): string {
    if (!config.PREST_URL) throw new Error("PREST_URL is not configured");
    return config.PREST_URL;
}

function authHeader(): Record<string, string> {
    if (!config.PREST_JWT_KEY) throw new Error("PREST_JWT_KEY is not configured");
    const token = signPrestAdminJwt(config.PREST_JWT_KEY, config.PREST_REGISTER_ADMIN);
    return { Authorization: `Bearer ${token}` };
}

function buildParams(params: Record<string, string | number | string[] | undefined>): URLSearchParams {
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

async function execRead(
    location: string,
    name: string,
    params: Record<string, string | number | string[] | undefined>,
    extraHeaders?: Record<string, string>
): Promise<any[]> {
    const qs = buildParams(params);
    const { data } = await axios.get(
        `${baseUrl()}/_QUERIES/${config.PREST_DATABASE}/${location}/${name}?${qs.toString()}`,
        { headers: { ...authHeader(), ...extraHeaders } }
    );
    return data as any[];
}

async function execWrite(
    location: string,
    name: string,
    params: Record<string, string | number | string[] | undefined>,
    extraHeaders?: Record<string, string>
): Promise<any> {
    const qs = buildParams(params);
    const { data } = await axios.post(
        `${baseUrl()}/_QUERIES/${config.PREST_DATABASE}/${location}/${name}?${qs.toString()}`,
        {},
        { headers: { ...authHeader(), ...extraHeaders } }
    );
    return data;
}

class PrestVectorClient implements VectorClient {
    private ready: Promise<void> | null = null;

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

        await registerPrestQuery("memory", "setup_extension", "SELECT 1", "CREATE EXTENSION IF NOT EXISTS vector");
        await registerPrestQuery(
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
        await registerPrestQuery(
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
        await registerPrestQuery(
            "memory",
            "setup_payload_idx",
            "SELECT 1",
            "CREATE INDEX IF NOT EXISTS memory_points_payload_idx ON memory_points USING gin (payload)"
        );
        await registerPrestQuery(
            "memory",
            "setup_embedding_idx",
            "SELECT 1",
            "CREATE INDEX IF NOT EXISTS memory_points_embedding_idx ON memory_points USING hnsw (embedding vector_cosine_ops)"
        );
        await registerPrestQuery(
            "memory",
            "setup_updated_idx",
            "SELECT 1",
            "CREATE INDEX IF NOT EXISTS memory_points_updated_idx ON memory_points (collection, updated_at DESC)"
        );
        await registerPrestQuery(
            "memory",
            "setup_filter_match_fn",
            "SELECT 1",
            `CREATE OR REPLACE FUNCTION memory_filter_match(p_payload jsonb, p_filter jsonb) RETURNS boolean AS $fn$
            DECLARE
                clause jsonb;
                path_arr text[];
                values_arr jsonb;
                val jsonb;
                matched boolean;
            BEGIN
                IF p_filter IS NULL OR p_filter->'must' IS NULL THEN
                    RETURN true;
                END IF;
                FOR clause IN SELECT * FROM jsonb_array_elements(p_filter->'must') LOOP
                    path_arr := string_to_array(clause->>'key', '.');
                    values_arr := COALESCE(clause->'match'->'any', jsonb_build_array(clause->'match'->'value'));
                    matched := false;
                    FOR val IN SELECT * FROM jsonb_array_elements(values_arr) LOOP
                        IF (p_payload #> path_arr) @> val THEN
                            matched := true;
                            EXIT;
                        END IF;
                    END LOOP;
                    IF NOT matched THEN
                        RETURN false;
                    END IF;
                END LOOP;
                RETURN true;
            END;
            $fn$ LANGUAGE plpgsql`
        );

        for (const name of [
            "setup_extension",
            "setup_collections_table",
            "setup_points_table",
            "setup_payload_idx",
            "setup_embedding_idx",
            "setup_updated_idx",
            "setup_filter_match_fn"
        ]) {
            await execWrite("memory", name, {});
        }

        await registerPrestQuery(
            "memory",
            "get_collections",
            "SELECT name FROM memory_collections ORDER BY name"
        );
        await registerPrestQuery(
            "memory",
            "get_collection",
            `SELECT c.vector_size, c.distance,
                    (SELECT count(*) FROM memory_points p WHERE p.collection = c.name) AS points_count
             FROM memory_collections c WHERE c.name = {{sqlVal "name"}}`
        );
        await registerPrestQuery(
            "memory",
            "retrieve_points",
            `SELECT id, payload, embedding FROM memory_points
             WHERE collection = {{sqlVal "collection"}} AND id IN {{sqlList "ids"}}`
        );
        await registerPrestQuery(
            "memory",
            "search_points",
            `SELECT id, payload, embedding <=> ('[' || replace({{sqlVal "header.X-Vector"}}, ' ', ',') || ']')::vector AS distance
             FROM memory_points
             WHERE collection = {{sqlVal "collection"}}
             {{if isSet "filter_json"}} AND memory_filter_match(payload, {{sqlVal "filter_json"}}::jsonb) {{end}}
             ORDER BY embedding <=> ('[' || replace({{sqlVal "header.X-Vector"}}, ' ', ',') || ']')::vector
             LIMIT {{sqlVal "limit"}}`
        );
        await registerPrestQuery(
            "memory",
            "scroll_points",
            `SELECT id, payload FROM memory_points
             WHERE collection = {{sqlVal "collection"}}
             {{if isSet "filter_json"}} AND memory_filter_match(payload, {{sqlVal "filter_json"}}::jsonb) {{end}}
             ORDER BY updated_at DESC
             LIMIT {{sqlVal "limit"}}`
        );

        await registerPrestQuery(
            "memory",
            "create_collection",
            "SELECT 1",
            `INSERT INTO memory_collections (name, vector_size, distance)
             VALUES ({{sqlVal "name"}}, {{sqlVal "vector_size"}}, {{sqlVal "distance"}})
             ON CONFLICT (name) DO NOTHING`
        );
        await registerPrestQuery(
            "memory",
            "delete_collection_points",
            "SELECT 1",
            `DELETE FROM memory_points WHERE collection = {{sqlVal "collection"}}`
        );
        await registerPrestQuery(
            "memory",
            "delete_collection_row",
            "SELECT 1",
            `DELETE FROM memory_collections WHERE name = {{sqlVal "name"}}`
        );
        await registerPrestQuery(
            "memory",
            "upsert_point",
            "SELECT 1",
            `INSERT INTO memory_points (collection, id, payload, embedding)
             VALUES ({{sqlVal "collection"}}, {{sqlVal "id"}}, {{sqlVal "payload"}}::jsonb, ('[' || replace({{sqlVal "header.X-Vector"}}, ' ', ',') || ']')::vector)
             ON CONFLICT (collection, id) DO UPDATE
             SET payload = EXCLUDED.payload, embedding = EXCLUDED.embedding, updated_at = now()`
        );
        await registerPrestQuery(
            "memory",
            "delete_points",
            "SELECT 1",
            `DELETE FROM memory_points WHERE collection = {{sqlVal "collection"}} AND id IN {{sqlList "ids"}}`
        );
    }

    async getCollections(): Promise<{ collections: Array<{ name: string }> }> {
        await this.ensureSchema();
        const rows = await execRead("memory", "get_collections", {});
        return { collections: rows.map((r: any) => ({ name: r.name })) };
    }

    async getCollection(name: string): Promise<any> {
        await this.ensureSchema();
        const rows = await execRead("memory", "get_collection", { name });
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
        await execWrite("memory", "create_collection", {
            name,
            vector_size: options.vectors.size,
            distance: options.vectors.distance
        });
        return true;
    }

    async deleteCollection(name: string): Promise<boolean> {
        await this.ensureSchema();
        await execWrite("memory", "delete_collection_points", { collection: name });
        await execWrite("memory", "delete_collection_row", { name });
        return true;
    }

    async upsert(name: string, options: { wait?: boolean; points: Point[] }): Promise<any> {
        await this.ensureSchema();
        for (const point of options.points) {
            await execWrite("memory", "upsert_point", {
                collection: name,
                id: String(point.id),
                payload: JSON.stringify(point.payload ?? {})
            }, { "X-Vector": toVectorHeaderValue(point.vector) });
        }
        return { status: "completed" };
    }

    async retrieve(
        name: string,
        options: { ids: Array<string | number>; with_payload?: boolean; with_vector?: boolean }
    ): Promise<Array<{ id: string; payload?: Record<string, any>; vector?: number[] }>> {
        await this.ensureSchema();
        if (options.ids.length === 0) return [];
        const rows = await execRead("memory", "retrieve_points", {
            collection: name,
            ids: options.ids.map(String)
        });
        return rows.map((row: any) => ({
            id: row.id,
            ...(options.with_payload === false ? {} : { payload: row.payload }),
            ...(options.with_vector ? { vector: parseVector(row.embedding) } : {})
        }));
    }

    async query(
        name: string,
        options: { query: number[]; limit?: number; filter?: Filter; with_payload?: boolean; with_vector?: boolean }
    ): Promise<{ points: Array<{ id: string; score: number; payload?: Record<string, any>; version: number }> }> {
        await this.ensureSchema();
        const { score } = distance();
        const rows = await execRead("memory", "search_points", {
            collection: name,
            limit: options.limit ?? 10,
            filter_json: options.filter ? JSON.stringify(options.filter) : undefined
        }, { "X-Vector": toVectorHeaderValue(options.query) });
        return {
            points: rows.map((row: any) => ({
                id: row.id,
                version: 0,
                score: score(Number(row.distance)),
                ...(options.with_payload === false ? {} : { payload: row.payload })
            }))
        };
    }

    async scroll(
        name: string,
        options: { filter?: Filter; limit?: number; with_payload?: boolean; with_vector?: boolean }
    ): Promise<{ points: Array<{ id: string; payload?: Record<string, any> }>; next_page_offset: null }> {
        await this.ensureSchema();
        const rows = await execRead("memory", "scroll_points", {
            collection: name,
            limit: options.limit ?? 10,
            filter_json: options.filter ? JSON.stringify(options.filter) : undefined
        });
        return {
            points: rows.map((row: any) => ({
                id: row.id,
                ...(options.with_payload === false ? {} : { payload: row.payload })
            })),
            next_page_offset: null
        };
    }

    async delete(name: string, options: { wait?: boolean; points: Array<string | number> }): Promise<any> {
        await this.ensureSchema();
        if (options.points.length === 0) return { status: "completed" };
        await execWrite("memory", "delete_points", {
            collection: name,
            ids: options.points.map(String)
        });
        return { status: "completed" };
    }
}

export { PrestVectorClient };
