import { createApp } from "./src/server/app.ts";
import { loadConfig } from "./src/server/config.ts";

const cfg = loadConfig();
const app = createApp(cfg);

app.server.listen(cfg.port, cfg.host, () => {
  console.log(`newsnest → http://${cfg.host}:${cfg.port}  (mode: ${cfg.mode}, data: ${cfg.dataDir})`);
  if (app.setupCode) {
    console.log(`\nFirst run: open http://127.0.0.1:${cfg.port}/app/ on this machine and enter setup code ${app.setupCode}`);
    console.log("It works once, until you have created a password. On a server, set NEWSNEST_ADMIN_PASSWORD instead.\n");
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)));
}
