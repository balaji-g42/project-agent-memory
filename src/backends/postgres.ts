import { createHmac } from "node:crypto";
import axios from "axios";
import config from "../config.js";
import type { VectorFilter } from "../types.js";

const DISTANCE_OPERATORS: Record<string, { op: string; score: (d: number) => number }> = {
    Cosine: { op: "<=>", score: d => 1 - d },
    Euclid: { op: "<->", score: d => d },
    Dot: { op: "<#>", score: d => -d }
};

type Point = { id: string | number; vector: number[]; payload?: Record<string, any> | null };
type Filter = VectorFilter;

function toVectorLiteral(vector: number[]): string {
    return `[${vector.map(v => v.toFixed(5)).join(",")}]`;
}

function toVectorHeaderValue(vector: number[]): string {
    return vector.map(v => v.toFixed(5)).join(" ");
}

function parseVector(raw: unknown): number[] {
    if (Array.isArray(raw)) return raw as number[];
    if (typeof raw === "string") return JSON.parse(raw);
    return [];
}

function distance(): { op: string; score: (d: number) => number } {
    return DISTANCE_OPERATORS[config.DISTANCE_METRIC] || DISTANCE_OPERATORS.Cosine;
}

function base64url(input: Buffer | string): string {
    return Buffer.from(input)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function signPrestAdminJwt(key: string, username: string): string {
    const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = base64url(JSON.stringify({
        UserInfo: { id: 0, name: "", username, metadata: null },
        exp: Math.floor(Date.now() / 1000) + 300
    }));
    const signature = base64url(createHmac("sha256", key).update(`${header}.${payload}`).digest());
    return `${header}.${payload}.${signature}`;
}

async function registerPrestQuery(location: string, name: string, readSql: string, writeSql?: string): Promise<void> {
    if (!config.PREST_URL || !config.PREST_JWT_KEY) return;
    const token = signPrestAdminJwt(config.PREST_JWT_KEY, config.PREST_REGISTER_ADMIN);
    const body: Record<string, string> = { database: config.PREST_DATABASE, location, name, read_sql: readSql };
    if (writeSql) body.write_sql = writeSql;
    await axios.post(
        `${config.PREST_URL}/_QUERIES/registry`,
        body,
        { headers: { Authorization: `Bearer ${token}` } }
    ).catch(async err => {
        if (err.response?.status === 409 || err.response?.status === 400) {
            await axios.put(
                `${config.PREST_URL}/_QUERIES/registry/${location}/${name}`,
                body,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            return;
        }
        throw err;
    });
}

export {
    DISTANCE_OPERATORS,
    toVectorLiteral,
    toVectorHeaderValue,
    parseVector,
    distance,
    signPrestAdminJwt,
    registerPrestQuery
};
export type { Point, Filter };
