import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { validation } from "./errors.ts";
import type { ApiKeyInfo } from "./keys.ts";

export interface Ctx {
  db: DB;
  cfg: Config;
  key: ApiKeyInfo;
  params: string[];
  query: URLSearchParams;
  body: unknown;
  kick: () => void;
}
export interface Result { status: number; body: unknown; headers?: Record<string, string>; /** Sent as-is instead of JSON (CSV downloads). */ raw?: string }
export type Handler = (c: Ctx) => Result | Promise<Result>;

export interface Route {
  method: string;
  pattern: RegExp;
  /** "full" keys can do anything; "sending" keys can only use routes marked sending. */
  sending: boolean;
  idempotent?: boolean;
  handler: Handler;
}

export const ok = (body: unknown, status = 200): Result => ({ status, body });

export const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw validation("Request body must be a JSON object");
  return v as Record<string, unknown>;
};

export const route = (method: string, path: string, handler: Handler, o: { sending?: boolean; idempotent?: boolean } = {}): Route => ({
  method,
  pattern: new RegExp("^" + path.replace(/:[a-z]+/g, "([^/]+)") + "/?$"),
  sending: o.sending ?? false,
  idempotent: o.idempotent,
  handler,
});
