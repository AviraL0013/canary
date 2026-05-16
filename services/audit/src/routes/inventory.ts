// GET /v1/inventory/agents, GET /v1/inventory/delegations

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Neo4jDelegationRepository } from "@canary/graph-core";

export async function inventoryRoute(server: FastifyInstance) {
  const neo4jUri = process.env["NEO4J_URI"] ?? "bolt://localhost:7687";
  const neo4jUser = process.env["NEO4J_USER"] ?? "neo4j";
  const neo4jPass = process.env["NEO4J_PASSWORD"] ?? "canary_secret";

  const repository = new Neo4jDelegationRepository(neo4jUri, neo4jUser, neo4jPass);

  server.addHook("onClose", async () => {
    await repository.close();
  });

  // GET /v1/inventory/agents
  const AgentsQuerySchema = z.object({
    org_id: z.string().min(1),
    framework: z.string().optional(),
    status: z.string().optional(),
  });

  server.get("/inventory/agents", async (request, reply) => {
    const parseResult = AgentsQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: "VALIDATION_ERROR",
        details: parseResult.error.issues,
      });
    }

    const agents = await repository.listAgents(parseResult.data);
    return reply.status(200).send({ agents });
  });

  // GET /v1/inventory/delegations
  const DelegationsQuerySchema = z.object({
    org_id: z.string().min(1),
    status: z.string().optional(),
  });

  server.get("/inventory/delegations", async (request, reply) => {
    const parseResult = DelegationsQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: "VALIDATION_ERROR",
        details: parseResult.error.issues,
      });
    }

    const delegations = await repository.listDelegations(parseResult.data);
    return reply.status(200).send({ delegations });
  });
}
