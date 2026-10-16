import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileTs } from "./src/compile.ts";

// node build.ts            everything: landing page and dashboard files, for serving next to the API
// node build.ts --landing  only the landing page, for static hosting (GitHub Pages, Cloudflare Pages, Netlify...)
//   NEWSNEST_WAITLIST_URL     where the "tell me when hosted is ready" form posts, e.g. https://news.example.com/subscribe
//   NEWSNEST_LANDING_DOMAIN   writes a CNAME file for GitHub Pages
const landing = process.argv.includes("--landing");
const root = fileURLToPath(new URL(".", import.meta.url));
const dist = join(root, "dist");
const clientSrc = join(root, "src", "client");

await rm(dist, { recursive: true, force: true });
await cp(join(root, "public"), dist, { recursive: true, filter: (src) => !landing || !/[\\/]public[\\/](app|embed\.js)([\\/]|$)/.test(src) });
await mkdir(join(dist, "js"), { recursive: true });

for (const file of await readdir(clientSrc, { recursive: true })) {
  if (!file.endsWith(".ts") || (landing && file.startsWith("app"))) continue;
  const out = join(dist, "js", file.slice(0, -3) + ".js");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, await compileTs(join(clientSrc, file)));
}

if (landing) {
  const file = join(dist, "index.html");
  let html = await readFile(file, "utf8");
  const waitlist = process.env.NEWSNEST_WAITLIST_URL;
  // The sign-up form needs a running Newsnest behind it. Without one, point people at the repo instead.
  html = waitlist
    ? html.replace('action="/subscribe"', `action="${waitlist.replace(/"/g, "&quot;")}"`)
    : html.replace(/<form method="post" action="\/subscribe"[\s\S]*?<\/form>/, '<a class="btn btn-solid" href="https://github.com/fetchloom/newsnest">Watch the repo</a>');
  html = html.replace(/<a href="\/app\/">Sign in<\/a>/, "").replace('<a class="mini" href="/app/"><span>→</span> Open the dashboard</a>', '<a class="mini" href="https://github.com/fetchloom/newsnest#try-it-in-a-minute"><span>↗</span> See the one-minute start</a>');
  await writeFile(file, html);
  await writeFile(join(dist, ".nojekyll"), "");
  if (process.env.NEWSNEST_LANDING_DOMAIN) await writeFile(join(dist, "CNAME"), `${process.env.NEWSNEST_LANDING_DOMAIN}\n`);
}
console.log(`built${landing ? " (landing only)" : ""} → dist/`);
