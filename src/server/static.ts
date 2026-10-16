import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compileTs } from "../compile.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const pub = join(root, "public");
const clientSrc = join(root, "src", "client");

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

async function resolveBody(pathname: string): Promise<{ body: string | Buffer; type: string } | null> {
  const rel = pathname.endsWith("/") ? pathname + "index.html" : pathname;
  const abs = normalize(join(pub, rel));
  if (!abs.startsWith(pub + sep)) return null;

  try {
    return { body: await readFile(abs), type: mime[extname(abs)] ?? "application/octet-stream" };
  } catch {
    // /js/foo.js falls back to src/client/foo.ts, compiled on request.
    if (rel.startsWith("/js/") && rel.endsWith(".js")) {
      const ts = normalize(join(clientSrc, rel.slice("/js/".length, -".js".length) + ".ts"));
      if (!ts.startsWith(clientSrc + sep)) return null;
      try {
        return { body: await compileTs(ts), type: mime[".js"] };
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === "/app") {
    res.writeHead(301, { location: "/app/" });
    res.end();
    return;
  }
  let hit: Awaited<ReturnType<typeof resolveBody>> = null;
  try {
    hit = req.method === "GET" || req.method === "HEAD" ? await resolveBody(decodeURIComponent(pathname)) : null;
  } catch {
    hit = null;
  }
  if (!hit) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": hit.type, "cache-control": "no-cache" });
  res.end(req.method === "HEAD" ? undefined : hit.body);
}
