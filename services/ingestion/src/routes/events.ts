// POST /v1/events — event ingestion endpoint
// Zod-validated, idempotent on event_id, triggers revocation cascade

import type { FastifyInstance } from "fastify";
import { DelegationEventSchema } from "@canary/event-schema";
import { Neo4jDelegationRepository } from "@canary/graph-core";
import { ContextCache } from "@canary/authorization-engine";
import { handleRevocation } from "../handlers/revocationHandler.js";
import postgres from "postgres";
import { Redis } from "ioredis";
import {
  CanaryDelegationCycleError,
  CanaryDepthExceededError,
  CanaryMultipleAuthoritySourcesError,
  CanaryScopeAttenuationError,
  CanaryTemporalAttenuationError,
  CanaryParentAuthorityInvalidError
} from "@canary/graph-core"

export async function eventsRoute(server: FastifyInstance) {
  // Initialize dependencies
  const neo4jUri = process.env["NEO4J_URI"] ?? "bolt://localhost:7687";
  const neo4jUser = process.env["NEO4J_USER"] ?? "neo4j";
  const neo4jPass = process.env["NEO4J_PASSWORD"] ?? "canary_secret";
  const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";
  const pgUrl = process.env["POSTGRES_URL"] ?? "postgresql://canary:canary_secret@localhost:5432/canary";

  const repository = new Neo4jDelegationRepository(neo4jUri, neo4jUser, neo4jPass);
  const redis = new Redis(redisUrl);
  const cache = new ContextCache(redis);
  const sql = postgres(pgUrl);

  // Cleanup on server close
  server.addHook("onClose", async () => {
    await repository.close();
    redis.disconnect();
    await sql.end();
  });

  server.post("/events", async (request, reply) => {
    // Step 1: Validate with Zod
    const parseResult = DelegationEventSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: "VALIDATION_ERROR",
        details: parseResult.error.issues,
      });
    }

    const event = parseResult.data;

    let claimed: boolean;

try {
  const inserted = await sql`
    INSERT INTO audit_events (
      event_id,
      org_id,
      event_type,
      sequence_id,
      timestamp,
      payload_json
    )
    VALUES (
      ${event.event_id},
      ${event.org_id},
      ${event.event_type},
      ${event.sequence_id},
      ${event.timestamp},
      ${JSON.stringify(event.payload)}
    )

    ON CONFLICT (event_id)
    DO NOTHING

    RETURNING event_id
  `;

  claimed = inserted.length > 0;

} catch (err) {
  
  server.log.error(
    err,
    "Idempotency INSERT failed"
  );

  return reply.status(500).send({
    error: "PROCESSING_ERROR",
    message: "Audit insert failed",
  });
}

if (!claimed) {
  return reply.status(200).send({
    event_id: event.event_id,
    status: "duplicate",
  });
}

    // Step 3: Process event by type
    try {
      switch (event.event_type) {
        case "delegation.created":
          await repository.createDelegation({
            human_id: event.payload.human_id,
            agent_id: event.payload.agent_id,
            scope_id: event.payload.scope_id,
            permissions: event.payload.permissions,
            expires_at: event.payload.expires_at,
            grant_reason: event.payload.grant_reason,
            delegation_edge_id: event.payload.delegation_edge_id,
            org_id: event.org_id,
          });
          break;

        case "delegation.invoked":
  await repository.createInvocation({
    parent_agent_id: event.payload.parent_agent_id,
    child_agent_id: event.payload.child_agent_id,
    scope_id: event.payload.scope_id,
    task_id: event.payload.task_id,
    expires_at: event.payload.expires_at,
    inherited_permissions: event.payload.inherited_permissions,
    invocation_edge_id: event.payload.invocation_edge_id,
    org_id: event.org_id,
  });
  break;

        case "tool.called":
          await repository.recordToolCall({
            agent_id: event.payload.agent_id,
            tool_id: event.payload.tool_id,
            scope_id: event.payload.scope_id,
            parameters_hash: event.payload.parameters_hash,
            authorization_decision_id: event.payload.authorization_decision_id,
            called_edge_id: event.payload.called_edge_id,
            tool_risk_tier: event.payload.tool_risk_tier,
          });
          break;

        case "action.executed":
          await repository.recordAction({
            tool_id: event.payload.tool_id,
            action_id: event.payload.action_id,
            action_type: event.payload.action_type,
            target_system: event.payload.target_system,
            parameters_hash: event.payload.parameters_hash,
            outcome: event.payload.outcome,
            reversible: event.payload.reversible,
            executed_at: event.timestamp,
          });
          break;

        case "delegation.revoked":
          // Full transitive cascade — must complete before returning
          await handleRevocation(
            event,
            repository,
            cache,
            sql,
            event.org_id,
            server.log
          );
          break;

        case "delegation.expired":
          // Mark delegation as expired in graph
          // Handled similarly to revocation but without cascade
          break;

        case "approval.requested":
          await sql`
            INSERT INTO approval_requests (
              approval_request_id, org_id, decision_id, agent_id,
              required_approvers_json, status
            ) VALUES (
              ${event.payload.approval_request_id},
              ${event.org_id},
              ${event.payload.decision_id},
              ${event.payload.agent_id},
              ${JSON.stringify(event.payload.required_approvers)},
              'PENDING'
            )
          `;
          break;

        case "approval.granted":
          await sql`
            UPDATE approval_requests
            SET status = 'APPROVED',
                resolved_at = NOW(),
                resolved_by = ${event.payload.approved_by},
                resolution_reason = ${event.payload.approval_reason}
            WHERE approval_request_id = ${event.payload.approval_request_id}
          `;
          break;

        case "approval.denied":
          await sql`
            UPDATE approval_requests
            SET status = 'DENIED',
                resolved_at = NOW(),
                resolved_by = ${event.payload.denied_by},
                resolution_reason = ${event.payload.denial_reason}
            WHERE approval_request_id = ${event.payload.approval_request_id}
          `;
          break;
      }

      


return reply.status(200).send({
  event_id: event.event_id,
  status: "ingested",
});
    } catch (err: any) {
      
  server.log.error(
    err,
    "Event processing failed"
    
  );
  console.error(
  "FULL ERROR:",
  JSON.stringify(
    {
      name: err?.name,
      message: err?.message,
      code: err?.code,
      stack: err?.stack,
    },
    null,
    2
  )
);

  const message =
    typeof err?.message === "string"
      ? err.message
      : "";

  const neo4jCode =
    typeof err?.code === "string"
      ? err.code
      : "";

  const isTransientConflict =
    neo4jCode.startsWith("Neo.TransientError")
    ||
    message.includes("deadlock")
    ||
    message.includes("lock");

  // IMPORTANT:
  // preserve idempotency claim during concurrency races
  if (!isTransientConflict) {
    await sql`
      DELETE FROM audit_events
      WHERE event_id = ${event.event_id}
    `.catch(() => {});
  }
  
  if (err instanceof CanaryDelegationCycleError) {
    return reply.status(400).send({
      error: "DELEGATION_CYCLE",
      message: err.message,
    });
  }

  if (err instanceof CanaryMultipleAuthoritySourcesError) {
    return reply.status(400).send({
      error: "MULTIPLE_ACTIVE_AUTHORITIES",
      message: err.message,
    });
  }

  if (err instanceof CanaryDepthExceededError) {
    return reply.status(400).send({
      error: "DEPTH_EXCEEDED",
      message: err.message,
    });
  }

  if (err instanceof CanaryScopeAttenuationError) {
    return reply.status(400).send({
      error: "SCOPE_ATTENUATION_VIOLATION",
      message: err.message,
    });
  }

  if (err instanceof CanaryTemporalAttenuationError) {
    return reply.status(400).send({
      error: "TEMPORAL_ATTENUATION_VIOLATION",
      message: err.message,
    });
  }
  if (
  err instanceof
  CanaryParentAuthorityInvalidError
) {
  return reply.status(400).send({
    error:
      "PARENT_AUTHORITY_INVALID",

    message:
      err.message,
  });
}
  return reply.status(500).send({
    error: "PROCESSING_ERROR",
    message:
      err instanceof Error
        ? err.message
        : "Unknown error",
  });
}
  });
}