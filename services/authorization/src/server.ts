// Authorization Service — Fastify server
// POST /v1/authorize, GET /v1/health

import Fastify from "fastify";
import cors from "@fastify/cors";
import { authorizeRoute } from "./routes/authorize.js";
import { healthRoute } from "./routes/health.js";

const PORT = parseInt(process.env["PORT"] ?? "3002", 10);

export async function buildServer() {
  const server = Fastify({ logger: true });
  await server.register(cors);

  await server.register(authorizeRoute, { prefix: "/v1" });
  await server.register(healthRoute, { prefix: "/v1" });

  return server;
}

async function main() {
  const server = await buildServer();
  try {
    await server.listen({ port: PORT, host: "0.0.0.0" });
    server.log.info(`Canary Authorization Service listening on :${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
