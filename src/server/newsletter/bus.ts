import type { Config } from "../config.ts";
import type { DB } from "../db.ts";

export interface BusCtx { db: DB; cfg: Config }
type Handler = (ctx: BusCtx, payload: any) => void;

const handlers = new Map<string, Handler[]>();

/**
 * Tiny in-process event bus. Subscriber changes, clicks and votes announce themselves here, and automations,
 * referral rewards and welcome emails listen, so those modules don't need to import each other.
 */
export const bus = {
  on(name: string, fn: Handler): void {
    handlers.set(name, [...(handlers.get(name) ?? []), fn]);
  },
  emit(name: string, ctx: BusCtx, payload: unknown): void {
    for (const fn of handlers.get(name) ?? []) {
      try { fn(ctx, payload); } catch (e) { console.error(`bus ${name}:`, e); }
    }
  },
};

/** Late-bound hooks the app wires up at start, so feature modules can poke the queue without importing it. */
export const runtime: { kick: () => void } = { kick: () => {} };
