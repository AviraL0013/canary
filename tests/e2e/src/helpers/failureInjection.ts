/**
 * Failure injection test utilities.
 *
 * These utilities create adversarial conditions at the HTTP/event level
 * to stress the system's invariant enforcement under failure.
 *
 * They do NOT mock internals — they exercise the real
 * ingestion → graph mutation → authorization pipeline.
 */

import { randomUUID } from "crypto";
import { emitEvent } from "./emitEvent";

const INGESTION_URL =
  process.env["INGESTION_URL"] ?? "http://localhost:3001";

/**
 * Flood N identical events with the same idempotency key.
 * Tests idempotency enforcement under contention.
 *
 * Returns all HTTP responses for analysis.
 */
export async function duplicateFlood(
  orgId: string,
  envelope: object,
  count: number,
): Promise<Array<{ status: number; body: Record<string, unknown> }>> {
  const results = await Promise.all(
    Array.from({ length: count }, () =>
      fetch(`${INGESTION_URL}/v1/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      }).then(async (res) => ({
        status: res.status,
        body: (await res.json()) as Record<string, unknown>,
      })),
    ),
  );

  return results;
}

/**
 * Fire N concurrent revocations against different edges
 * in the same subtree.
 *
 * This creates a revocation storm — multiple concurrent
 * cascade operations competing for the same subtree locks.
 */
export async function revocationStorm(
  orgId: string,
  edges: Array<{
    edgeId: string;
    humanId: string;
    agentId: string;
    cascadeAgents: string[];
  }>,
): Promise<Array<{ status: number; body: unknown }>> {
  return Promise.all(
    edges.map((edge) =>
      emitEvent(orgId, "delegation.revoked", {
        delegation_edge_id: edge.edgeId,
        human_id: edge.humanId,
        agent_id: edge.agentId,
        revocation_reason: "revocation storm test",
        cascade_affected_agents: edge.cascadeAgents,
      }),
    ),
  );
}

/**
 * Fire N concurrent delegations to the same child
 * from different parents.
 *
 * This creates a delegation race — multiple concurrent
 * createInvocation() calls competing for the same
 * child agent's single-authority slot.
 */
export async function delegationRace(
  orgId: string,
  parentIds: string[],
  childId: string,
  scopeId: string,
  expiresAt: string,
): Promise<Array<{ status: number; body: unknown }>> {
  return Promise.all(
    parentIds.map((parentId) =>
      emitEvent(orgId, "delegation.invoked", {
        parent_agent_id: parentId,
        child_agent_id: childId,
        scope_id: scopeId,
        task_id: `task_${randomUUID().slice(0, 8)}`,
        inherited_permissions: ["read"],
        expires_at: expiresAt,
        invocation_edge_id: `edge_${randomUUID()}`,
      }),
    ),
  );
}

/**
 * Fire delegation + revocation simultaneously against
 * the same parent agent.
 *
 * Tests the race between createInvocation() and
 * revocationCascade() competing for locks on the same subtree.
 */
export async function delegateRevocationRace(
  orgId: string,
  params: {
    parentId: string;
    childId: string;
    scopeId: string;
    expiresAt: string;
    revokeEdgeId: string;
    humanId: string;
    cascadeAgents: string[];
  },
): Promise<{
  delegateResult: { status: number; body: unknown };
  revokeResult: { status: number; body: unknown };
}> {
  const [delegateResult, revokeResult] = await Promise.all([
    emitEvent(orgId, "delegation.invoked", {
      parent_agent_id: params.parentId,
      child_agent_id: params.childId,
      scope_id: params.scopeId,
      task_id: `task_${randomUUID().slice(0, 8)}`,
      inherited_permissions: ["read"],
      expires_at: params.expiresAt,
      invocation_edge_id: `edge_${randomUUID()}`,
    }),
    emitEvent(orgId, "delegation.revoked", {
      delegation_edge_id: params.revokeEdgeId,
      human_id: params.humanId,
      agent_id: params.parentId,
      revocation_reason: "delegate-revoke race test",
      cascade_affected_agents: params.cascadeAgents,
    }),
  ]);

  return { delegateResult, revokeResult };
}
