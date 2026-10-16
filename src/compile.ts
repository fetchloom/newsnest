import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

// Node strips erasable TypeScript syntax only: no enums, no namespaces,
// no parameter properties. Types are erased here, not checked.
export async function compileTs(file: string): Promise<string> {
  const source = await readFile(file, "utf8");
  return stripTypeScriptTypes(source, { mode: "strip" });
}
