// GET /v1/audit — paginated compliance query (EU AI Act Article 12)

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Neo4jDelegationRepository } from "@canary/graph-core";

export async function auditRoute(server: FastifyInstance) {
  const neo4jUri = process.env["NEO4J_URI"] ?? "bolt://localhost:7687";
  const neo4jUser = process.env["NEO4J_USER"] ?? "neo4j";
  const neo4jPass = process.env["NEO4J_PASSWORD"] ?? "canary_secret";

  const repository = new Neo4jDelegationRepository(neo4jUri, neo4jUser, neo4jPass);

  server.addHook("onClose", async () => {
    await repository.close();
  });

  const QuerySchema = z.object({
    org_id: z.string().min(1),
    human_id: z.string().optional(),
    start_time: z.string(),
    end_time: z.string(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  });

  server.get("/audit", async (request, reply) => {
    const parseResult = QuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: "VALIDATION_ERROR",
        details: parseResult.error.issues,
      });
    }

    const params = parseResult.data;

    const result = await repository.auditQuery({
      org_id: params.org_id,
      human_id: params.human_id,
      start_time: params.start_time,
      end_time: params.end_time,
      page: params.page,
      limit: params.limit,
    });

    return reply.status(200).send(result);
  });
}
