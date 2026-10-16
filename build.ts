import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileTs } from "./src/compile.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
const dist = join(root, "dist");
const clientSrc = join(root, "src", "client");

await rm(dist, { recursive: true, force: true });
await cp(join(root, "public"), dist, { recursive: true });
await mkdir(join(dist, "js"), { recursive: true });

for (const file of await readdir(clientSrc, { recursive: true })) {
  if (!file.endsWith(".ts")) continue;
  const out = join(dist, "js", file.slice(0, -3) + ".js");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, await compileTs(join(clientSrc, file)));
}
console.log("built → dist/");
