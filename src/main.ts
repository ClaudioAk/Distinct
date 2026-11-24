import path from "node:path";
import { DATA, loadConfig } from "./config.ts";
import { applyCompanyCA } from "./netcheck.ts";

// Company networks: trust the firewall certificate the owner added in Settings (if any).
try {
  const name = applyCompanyCA(path.join(DATA, "company-ca.pem"));
  if (name) console.log(`Trusting company network certificate: ${name}`);
} catch (e: any) {
  console.error(`Ignoring data/company-ca.pem: ${e.message}`);
}
import { App } from "./app.ts";
import { startWeb } from "./web.ts";

const cfg = loadConfig();
const app = new App(cfg);
const server = startWeb(app);

server.on("listening", () => {
  console.log(`DInstinct is running. Open http://127.0.0.1:${cfg.port} on this PC to ${app.vault.exists() ? "unlock it" : "set it up"}.`);
});
server.on("error", (e: any) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${cfg.port} is already in use (is DInstinct already running?)` : e);
  process.exit(1);
});

const shutdown = async () => {
  await app.lock().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
