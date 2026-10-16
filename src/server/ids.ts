import { createHash, randomBytes } from "node:crypto";

export const newId = (prefix: string): string => `${prefix}_${randomBytes(12).toString("base64url")}`;

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export const now = (): number => Date.now();

export const iso = (ms: number | null): string | null => (ms == null ? null : new Date(ms).toISOString());
