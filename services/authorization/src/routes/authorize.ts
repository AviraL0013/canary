// POST /v1/authorize — full authorization decision flow
// p99 target: <50ms (cache hit), <150ms (cache miss)

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Neo4jDelegationRepository } from "@canary/graph-core";
import {
  DecisionEngine,
  ContextCache,
  RiskScorer,
  PolicyEvaluator,
  type PolicyConfig,
  type OrgConfig,
} from "@canary/authorization-engine";
import { Redis } from "ioredis";
import postgres from "postgres";

const AuthorizationRequestSchema = z.object({
  request_id: z.string().uuid(),
  requesting_agent_id: z.string().min(1),
  tool_id: z.string().min(1),
  action_type: z.string().min(1),
  scope_id: z.string().min(1),
  task_id: z.string().min(1),
  org_id: z.string().min(1),
  timestamp: z.string(),
  parameters_hash: z.string(),
});

export async function authorizeRoute(server: FastifyInstance) {
  const neo4jUri = process.env["NEO4J_URI"] ?? "bolt://localhost:7687";
  const neo4jUser = process.env["NEO4J_USER"] ?? "neo4j";
  const neo4jPass = process.env["NEO4J_PASSWORD"] ?? "canary_secret";
  const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";
  const pgUrl = process.env["POSTGRES_URL"] ?? "postgresql://canary:canary_secret@localhost:5432/canary";

  const repository = new Neo4jDelegationRepository(neo4jUri, neo4jUser, neo4jPass);
  const redis = new Redis(redisUrl);
  const cache = new ContextCache(redis);
  const sql = postgres(pgUrl);

  const riskScorer = new RiskScorer();
  const policyEvaluator = new PolicyEvaluator();
  const engine = new DecisionEngine(repository, cache, riskScorer, policyEvaluator);

  // Load policies from PostgreSQL
  const loadPolicies = async () => {
    const rows = await sql`
      SELECT policy_id, policy_type, config_json, enabled FROM policies WHERE enabled = true
    `;
    const policies: PolicyConfig[] = rows.map((r) => ({
      policy_id: r["policy_id"] as string,
      policy_type: r["policy_type"] as string,
      config_json: (r["config_json"] ?? {}) as Record<string, unknown>,
      enabled: r["enabled"] as boolean,
    }));
    engine.loadPolicies(policies);
    server.log.info({ count: policies.length }, "Policies loaded");
  };

  // Load on startup
  await loadPolicies();

  // Subscribe to policy updates via Redis pub/sub
  const redisSub = new Redis(redisUrl);
  redisSub.subscribe("canary:policy_update");
  redisSub.on("message", async (channel: string) => {
    if (channel === "canary:policy_update") {
      server.log.info("Policy update received — reloading");
      await loadPolicies();
    }
  });

  server.addHook("onClose", async () => {
    await repository.close();
    redis.disconnect();
    redisSub.disconnect();
    await sql.end();
  });

  server.post("/authorize", async (request, reply) => {
    const parseResult = AuthorizationRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: "VALIDATION_ERROR",
        details: parseResult.error.issues,
      });
    }

    const authRequest = parseResult.data;

    // Idempotency check — return existing decision if found
    const existing = await sql`
      SELECT reasoning_json, chain_summary_json, decision, evaluation_source, evaluated_at, decision_id
      FROM authorization_decisions
      WHERE request_id = ${authRequest.request_id}
      LIMIT 1
    `;
    if (existing.length > 0) {
      const row = existing[0]!;
      return reply.status(200).send({
        decision_id: row["decision_id"],
        request_id: authRequest.request_id,
        decision: row["decision"],
        evaluated_at: row["evaluated_at"],
        evaluation_source: row["evaluation_source"],
        reasoning: row["reasoning_json"],
        chain_summary: row["chain_summary_json"],
      });
    }

    // Load org config
    const orgRows = await sql`
      SELECT org_id, fail_mode, max_delegation_depth, risk_score_threshold, security_contact_id
      FROM org_config
      WHERE org_id = ${authRequest.org_id} OR org_id = 'SYSTEM'
      ORDER BY CASE WHEN org_id = ${authRequest.org_id} THEN 0 ELSE 1 END
      LIMIT 1
    `;
    const orgConfig: OrgConfig = orgRows.length > 0
      ? {
          org_id: orgRows[0]!["org_id"] as string,
          fail_mode: orgRows[0]!["fail_mode"] as "CLOSED" | "OPEN",
          max_delegation_depth: orgRows[0]!["max_delegation_depth"] as number,
          risk_score_threshold: orgRows[0]!["risk_score_threshold"] as number,
          security_contact_id: (orgRows[0]!["security_contact_id"] as string) || null,
        }
      : {
          org_id: authRequest.org_id,
          fail_mode: "CLOSED",
          max_delegation_depth: 5,
          risk_score_threshold: 750,
          security_contact_id: null,
        };

    try {
      // Look up tool risk tier from graph evaluation
      const evalResult = await repository.evaluateAuthorization({
        agent_id: authRequest.requesting_agent_id,
        tool_id: authRequest.tool_id,
        action_type: authRequest.action_type,
        scope_id: authRequest.scope_id,
        org_id: authRequest.org_id,
      });
      const toolRiskTier = evalResult.tool_risk_tier ?? "LOW";
      const toolOrgId = evalResult.tool_org_id || authRequest.org_id;

      // Evaluate authorization
      const decision = await engine.evaluate(
        authRequest,
        orgConfig,
        toolRiskTier,
        toolOrgId
      );

      // Write decision to PostgreSQL (append-only audit log)
      await sql`
        INSERT INTO authorization_decisions (
          decision_id, request_id, org_id, agent_id, tool_id,
          action_type, decision, reasoning_json, chain_summary_json,
          evaluation_source, evaluated_at
        ) VALUES (
          ${decision.decision_id},
          ${decision.request_id},
          ${authRequest.org_id},
          ${authRequest.requesting_agent_id},
          ${authRequest.tool_id},
          ${authRequest.action_type},
          ${decision.decision},
          ${JSON.stringify(decision.reasoning)},
          ${JSON.stringify(decision.chain_summary)},
          ${decision.evaluation_source},
          ${decision.evaluated_at}
        )
        ON CONFLICT (decision_id) DO NOTHING
      `;

      return reply.status(200).send(decision);
    } catch (err) {
      server.log.error(err, "Authorization evaluation failed");

      // Fail closed by default
      if (orgConfig.fail_mode === "CLOSED") {
        return reply.status(503).send({
          error: "CANARY_UNAVAILABLE",
          decision: "BLOCK",
          reason: "Authorization engine unavailable — fail-closed mode active",
        });
      }

      // Fail open — explicit opt-in
      return reply.status(200).send({
        decision: "ALLOW",
        degraded_mode: true,
        reason: "Authorization engine unavailable — fail-open mode (org opt-in)",
      });
    }
  });
}