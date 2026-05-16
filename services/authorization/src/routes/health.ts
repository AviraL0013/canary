// GET /v1/health — verifies Neo4j, Redis, PostgreSQL connectivity

import type { FastifyInstance } from "fastify";
import { Neo4jDelegationRepository } from "@canary/graph-core";
import { ContextCache } from "@canary/authorization-engine";
import { Redis } from "ioredis";
import postgres from "postgres";

export async function healthRoute(server: FastifyInstance) {
  const neo4jUri = process.env["NEO4J_URI"] ?? "bolt://localhost:7687";
  const neo4jUser = process.env["NEO4J_USER"] ?? "neo4j";
  const neo4jPass = process.env["NEO4J_PASSWORD"] ?? "canary_secret";
  const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";
  const pgUrl = process.env["POSTGRES_URL"] ?? "postgresql://canary:canary_secret@localhost:5432/canary";

  const repository = new Neo4jDelegationRepository(neo4jUri, neo4jUser, neo4jPass);
  const redis = new Redis(redisUrl);
  const cache = new ContextCache(redis);
  const sql = postgres(pgUrl);

  server.addHook("onClose", async () => {
    await repository.close();
    redis.disconnect();
    await sql.end();
  });

  server.get("/health", async (_request, reply) => {
    const [neo4jOk, redisOk, postgresOk] = await Promise.all([
      repository.verifyConnectivity(),
      cache.verifyConnectivity(),
      sql`SELECT 1`.then(() => true).catch(() => false),
    ]);

    const allOk = neo4jOk && redisOk && postgresOk;
    const status = allOk ? "healthy" : "degraded";

    return reply.status(allOk ? 200 : 503).send({
      status,
      neo4j_ok: neo4jOk,
      redis_ok: redisOk,
      postgres_ok: postgresOk,
    });
  });
}
