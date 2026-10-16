import { createApp } from "./src/server/app.ts";
import { loadConfig } from "./src/server/config.ts";

const cfg = loadConfig();
const app = createApp(cfg);

app.server.listen(cfg.port, cfg.host, () => {
  console.log(`freepost → http://${cfg.host}:${cfg.port}  (mode: ${cfg.mode}, data: ${cfg.dataDir})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)));
}
