import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

function claudeLoginEmail(): string | undefined {
    try {
        const config = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
        const email = config?.oauthAccount?.emailAddress;
        return typeof email === "string" && email ? email : undefined;
    } catch {
        return undefined;
    }
}

function gitEmail(): string | undefined {
    try {
        const email = execFileSync("git", ["config", "user.email"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
        return email || undefined;
    } catch {
        return undefined;
    }
}

export const USER_ID: string = process.env.PAM_USER || claudeLoginEmail() || gitEmail() || userInfo().username;

export function chainHash(payload: Record<string, any>): string {
    return createHash("sha256")
        .update(JSON.stringify([payload.content, payload.version, payload.written_by_user ?? null, payload.timestamp, payload.prev_hash ?? null]))
        .digest("hex");
}

export function withChain<T extends Record<string, any>>(payload: T, previous?: Record<string, any>): T & { prev_hash: string | null; hash: string } {
    const prev_hash = previous ? (previous.hash ?? null) : null;
    const next = { ...payload, prev_hash };
    return { ...next, hash: chainHash(next) };
}
