// RevocationHandler — full transitive revocation cascade
// ON delegation.revoked:
//   1. QUERY 5: mark edges REVOKED, get affected agent IDs
//   2. Invalidate Redis cache for all affected agents
//   3. Auto-deny pending approval requests in subtree
//   4. Emit security alert if post-revocation actions detected
// MUST complete atomically before returning response.

import type { DelegationGraphRepository } from "@canary/graph-core";
import type { ContextCache } from "@canary/authorization-engine";
import type { ValidatedDelegationRevokedEvent } from "@canary/event-schema";
import type { Sql } from "postgres";
import type { FastifyBaseLogger } from "fastify";

export async function handleRevocation(
  event: ValidatedDelegationRevokedEvent,
  repository: DelegationGraphRepository,
  cache: ContextCache,
  sql: Sql,
  org_id: string,
  log: FastifyBaseLogger
): Promise<void> {
  const { delegation_edge_id, agent_id } = event.payload;

  // Step 1: Atomic graph write — mark all edges REVOKED, get affected agents
  let affectedAgentIds: string[];
  try {
    const cascadeResult = await repository.revocationCascade(delegation_edge_id);
    affectedAgentIds = cascadeResult.affected_agent_ids;

    log.info(
      { delegation_edge_id, affected_count: affectedAgentIds.length },
      "Revocation cascade completed in graph"
    );
  } catch (err) {
    // Neo4j write failed — reject event, return 500, let client retry
    // Never partially complete a revocation.
    log.error(err, "Revocation cascade graph write failed — rejecting event");
    throw err;
  }

  // Step 2: Invalidate Redis cache for ALL affected agents
  // Include the directly revoked agent in case it wasn't in the cascade result
  const allAffected = [...new Set([agent_id, ...affectedAgentIds])];
  await cache.invalidateMany(org_id, allAffected);

  log.info(
    { invalidated_count: allAffected.length },
    "Cache invalidation complete"
  );

  // Step 3: Auto-deny all pending approval requests in subtree
  if (allAffected.length > 0) {
    await sql`
      UPDATE approval_requests
      SET status = 'AUTO_DENIED',
          resolved_at = NOW(),
          resolution_reason = 'delegation_revoked'
      WHERE agent_id = ANY(${allAffected})
        AND status = 'PENDING'
    `;
  }

  // Step 4: Detect out-of-order actions (security alert)
  // Check if any actions were executed after the revocation timestamp
  const revokedAt = event.timestamp;
  const postRevocationActions = await sql`
    SELECT ae.event_id, ae.event_type, ae.timestamp
    FROM audit_events ae
    WHERE ae.org_id = ${org_id}
      AND ae.event_type IN ('tool.called', 'action.executed')
      AND ae.timestamp > ${revokedAt}
      AND ae.payload_json->>'agent_id' = ANY(${allAffected})
    LIMIT 10
  `;

  if (postRevocationActions.length > 0) {
    // Emit security alert — actions were executed after revocation
    log.warn(
      {
        delegation_edge_id,
        post_revocation_action_count: postRevocationActions.length,
        actions: postRevocationActions.map((a) => ({
          event_id: a["event_id"],
          type: a["event_type"],
          timestamp: a["timestamp"],
        })),
      },
      "SECURITY ALERT: Actions executed after delegation revocation (out-of-order detection)"
    );

    // Write security alert to audit log
    await sql`
      INSERT INTO audit_events (event_id, org_id, event_type, sequence_id, timestamp, payload_json)
      VALUES (
        ${"security_alert_" + event.event_id},
        ${org_id},
        'security.post_revocation_action_detected',
        ${event.sequence_id},
        ${new Date().toISOString()},
        ${JSON.stringify({
          delegation_edge_id,
          affected_agents: allAffected,
          post_revocation_actions: postRevocationActions,
        })}
      )
      ON CONFLICT (event_id) DO NOTHING
    `;
  }

  // Write revocation cascade event to audit log
  await sql`
    INSERT INTO audit_events (event_id, org_id, event_type, sequence_id, timestamp, payload_json)
    VALUES (
      ${"cascade_" + event.event_id},
      ${org_id},
      'delegation.revocation_cascade',
      ${event.sequence_id},
      ${new Date().toISOString()},
      ${JSON.stringify({
        delegation_edge_id,
        affected_agent_ids: allAffected,
        original_event_id: event.event_id,
      })}
    )
    ON CONFLICT (event_id) DO NOTHING
  `;
}
