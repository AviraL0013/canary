// GET /v1/risk/:agent_id — returns RiskScoreBreakdown

import type { FastifyInstance } from "fastify";
import { Neo4jDelegationRepository } from "@canary/graph-core";
import { RiskScorer } from "@canary/authorization-engine";
import postgres from "postgres";

export async function riskRoute(server: FastifyInstance) {
  const neo4jUri = process.env["NEO4J_URI"] ?? "bolt://localhost:7687";
  const neo4jUser = process.env["NEO4J_USER"] ?? "neo4j";
  const neo4jPass = process.env["NEO4J_PASSWORD"] ?? "canary_secret";
  const pgUrl = process.env["POSTGRES_URL"] ?? "postgresql://canary:canary_secret@localhost:5432/canary";

  const repository = new Neo4jDelegationRepository(neo4jUri, neo4jUser, neo4jPass);
  const sql = postgres(pgUrl);
  const riskScorer = new RiskScorer();

  server.addHook("onClose", async () => {
    await repository.close();
    await sql.end();
  });

  server.get<{ Params: { agent_id: string }; Querystring: { org_id: string } }>(
    "/risk/:agent_id",
    async (request, reply) => {
      const { agent_id } = request.params;
      const org_id = (request.query as { org_id?: string }).org_id;

      if (!org_id) {
        return reply.status(400).send({
          error: "VALIDATION_ERROR",
          message: "org_id query parameter required",
        });
      }

      const context = await repository.getAuthorizationContext(agent_id, org_id);
      if (!context) {
        return reply.status(404).send({
          error: "NOT_FOUND",
          message: `Agent ${agent_id} not found or no delegation chain exists`,
        });
      }

      // Get org config for max depth
      const orgRows = await sql`
        SELECT max_delegation_depth FROM org_config
        WHERE org_id = ${org_id} OR org_id = 'SYSTEM'
        ORDER BY CASE WHEN org_id = ${org_id} THEN 0 ELSE 1 END
        LIMIT 1
      `;
      const maxDepth = (orgRows[0]?.["max_delegation_depth"] as number) ?? 5;

      const riskScore = riskScorer.computeRiskScore({
        delegation_depth: context.delegation_depth,
        max_policy_depth: maxDepth,
        unique_permissions: context.effective_permissions.length,
        total_possible_permissions: 100,
        critical_tools_count: context.accessible_tools.filter(
          (t) => t.risk_tier === "CRITICAL"
        ).length,
        baseline_deviation: 0,
        agent_created_at: context.risk_score_inputs.agent_created_at,
      });

      return reply.status(200).send(riskScore);
    }
  );
}
