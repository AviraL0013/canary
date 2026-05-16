// GET /v1/trace/:action_id — complete delegation chain + decision record

import type { FastifyInstance } from "fastify";
import { Neo4jDelegationRepository } from "@canary/graph-core";
import postgres from "postgres";

export async function traceRoute(server: FastifyInstance) {
  const neo4jUri = process.env["NEO4J_URI"] ?? "bolt://localhost:7687";
  const neo4jUser = process.env["NEO4J_USER"] ?? "neo4j";
  const neo4jPass = process.env["NEO4J_PASSWORD"] ?? "canary_secret";
  const pgUrl = process.env["POSTGRES_URL"] ?? "postgresql://canary:canary_secret@localhost:5432/canary";

  const repository = new Neo4jDelegationRepository(neo4jUri, neo4jUser, neo4jPass);
  const sql = postgres(pgUrl);

  server.addHook("onClose", async () => {
    await repository.close();
    await sql.end();
  });

  server.get<{ Params: { action_id: string } }>(
    "/trace/:action_id",
    async (request, reply) => {
      const { action_id } = request.params;

      const trace = await repository.traceAction(action_id);
      if (!trace) {
        return reply.status(404).send({
          error: "NOT_FOUND",
          message: `Action ${action_id} not found in delegation graph`,
        });
      }

      // Enrich with decision record from PostgreSQL
      const decisions = await sql`
        SELECT decision_id, decision, reasoning_json, chain_summary_json, evaluated_at
        FROM authorization_decisions
        WHERE decision_id LIKE ${'%' + action_id + '%'}
           OR agent_id IN (${sql.unsafe(trace.chain.filter(h => h.node_type === 'Agent').map(h => `'${h.node_id}'`).join(',') || "'__none__'")})
        ORDER BY evaluated_at DESC
        LIMIT 5
      `;

      return reply.status(200).send({
        trace,
        decisions: decisions.map((d) => ({
          decision_id: d["decision_id"],
          decision: d["decision"],
          reasoning: d["reasoning_json"],
          chain_summary: d["chain_summary_json"],
          evaluated_at: d["evaluated_at"],
        })),
      });
    }
  );
}
