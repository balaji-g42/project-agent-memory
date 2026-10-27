import { v4 as uuidv4, v5 as uuidv5 } from "uuid";

export const BANK_PREFIX = "memory_bank_";
export const ARCHIVE_PREFIX = "memory_archive_";
export const SETTINGS_TYPE = "projectSettings";
export const SCHEMA_VERSION = 2;

export const MAX_HIVE_PROJECTS = 5;
export const HIVE_DEFAULT_LIMIT = 3;
export const HIVE_MAX_LIMIT = 10;
export const DEFAULT_HEAT = 5;
const SCORE_AT_HEAT_1 = 0.3;
const SCORE_AT_HEAT_10 = 0.75;

export const SESSION_ID = uuidv4();

const SETTINGS_NAMESPACE = "6c1d8f52-7a64-4b19-9e0a-4d2b6c8e1f37";
const SUPERSEDED_NAMESPACE = "9a3e5d71-2b48-4c6f-8d10-5e7a9b3c1d24";

export function settingsPointId(project: string): string {
    return uuidv5(`${project}:settings`, SETTINGS_NAMESPACE);
}

export function supersededPointId(memoryId: string, version: number): string {
    return uuidv5(`${memoryId}:${version}`, SUPERSEDED_NAMESPACE);
}

export function minScoreForHeat(heat: number): number {
    const clamped = Math.min(10, Math.max(1, Math.round(heat)));
    return SCORE_AT_HEAT_1 + ((clamped - 1) / 9) * (SCORE_AT_HEAT_10 - SCORE_AT_HEAT_1);
}

export function bankName(project: string): string {
    return `${BANK_PREFIX}${project}`;
}

export function archiveName(project: string): string {
    return `${ARCHIVE_PREFIX}${project}`;
}
