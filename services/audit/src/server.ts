// Audit Service — Fastify server
// GET /v1/trace/:action_id, /v1/audit, /v1/inventory/*, /v1/risk/:agent_id

import Fastify from "fastify";
import cors from "@fastify/cors";
import { traceRoute } from "./routes/trace.js";
import { auditRoute } from "./routes/audit.js";
import { inventoryRoute } from "./routes/inventory.js";
import { riskRoute } from "./routes/risk.js";

const PORT = parseInt(process.env["PORT"] ?? "3003", 10);

export async function buildServer() {
  const server = Fastify({ logger: true });
  await server.register(cors);

  server.get("/v1/health", async () => {
    return { status: "ok", service: "audit", port: PORT };
  });

  await server.register(traceRoute, { prefix: "/v1" });
  await server.register(auditRoute, { prefix: "/v1" });
  await server.register(inventoryRoute, { prefix: "/v1" });
  await server.register(riskRoute, { prefix: "/v1" });

  return server;
}

async function main() {
  const server = await buildServer();
  try {
    await server.listen({ port: PORT, host: "0.0.0.0" });
    server.log.info(`Canary Audit Service listening on :${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
