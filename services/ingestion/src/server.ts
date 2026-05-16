// Ingestion Service — Fastify server
// POST /v1/events — validates, ingests, and handles revocation cascades

import Fastify from "fastify";
import cors from "@fastify/cors";
import { eventsRoute } from "./routes/events.js";

const PORT = parseInt(process.env["PORT"] ?? "3001", 10);

export async function buildServer() {
  const server = Fastify({ logger: true });
  await server.register(cors);

  // Health check
  server.get("/v1/health", async () => {
    return { status: "ok", service: "ingestion", port: PORT };
  });

  // Event ingestion route
  await server.register(eventsRoute, { prefix: "/v1" });

  return server;
}

async function main() {
  const server = await buildServer();
  try {
    await server.listen({ port: PORT, host: "0.0.0.0" });
    server.log.info(`Canary Ingestion Service listening on :${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
