// Query 5 — Transitive revocation cascade
// Atomically: finds all descendant agents, marks all edges REVOKED,
// returns affected agent IDs for cache invalidation.
// MUST be a single atomic write transaction.

import type { Driver, Session } from "neo4j-driver";
import type { RevocationCascadeResult } from "../types/results.js";

// Single atomic Cypher transaction:
// 1. Find the root agent of the revoked edge
// 2. Find ALL descendant agents in the subtree (any depth)
// 3. Mark all DELEGATED_TO and INVOKED edges in subtree as REVOKED
// 4. Return affected agent IDs
const REVOCATION_CASCADE_CYPHER = `
// Find the edge being revoked and the root agent
MATCH ()-[root_edge:DELEGATED_TO {id: $delegation_edge_id}]->(root_agent:Agent)

// Find all descendant agents through INVOKED edges at any depth
MATCH (root_agent)-[:INVOKED*0..]->(descendant:Agent)

// Mark the root DELEGATED_TO edge as REVOKED
SET root_edge.status = 'REVOKED',
    root_edge.revoked_at = datetime()

// Mark all INVOKED edges in the subtree as REVOKED
WITH root_agent, root_edge, collect(DISTINCT descendant) AS descendants
UNWIND descendants AS desc
OPTIONAL MATCH (parent:Agent)-[inv:INVOKED]->(desc)
WHERE (parent)-[:INVOKED*0..]->(root_agent) OR parent.id = root_agent.id
SET inv.status = 'REVOKED',
    inv.revoked_at = datetime()

WITH root_edge, descendants
RETURN
  $delegation_edge_id            AS revoked_edge_id,
  [d IN descendants | d.id]      AS affected_agent_ids,
  size(descendants) + 1          AS edges_marked_revoked
`;

// Fallback query when DELEGATED_TO edges don't have an id property
// Uses scope-based matching instead
const REVOCATION_CASCADE_BY_SCOPE_CYPHER = `
MATCH (human:Human)-[root_edge:DELEGATED_TO]->(root_agent:Agent)
WHERE root_edge.scope_id = $scope_id OR root_edge.id = $delegation_edge_id

MATCH (root_agent)-[:INVOKED*0..]->(descendant:Agent)

SET root_edge.status = 'REVOKED',
    root_edge.revoked_at = datetime()

WITH root_agent, root_edge, collect(DISTINCT descendant) AS descendants
UNWIND CASE WHEN size(descendants) > 0 THEN descendants ELSE [null] END AS desc
WITH root_agent, root_edge, descendants, desc
WHERE desc IS NOT NULL
OPTIONAL MATCH (parent:Agent)-[inv:INVOKED]->(desc)
SET inv.status = 'REVOKED',
    inv.revoked_at = datetime()

WITH root_edge, descendants
RETURN
  $delegation_edge_id            AS revoked_edge_id,
  [d IN descendants | d.id]      AS affected_agent_ids,
  size(descendants) + 1          AS edges_marked_revoked
`;

export async function revocationCascade(
  driver: Driver,
  delegation_edge_id: string
): Promise<RevocationCascadeResult> {
  // Use a write transaction — this must be atomic
  const session: Session = driver.session({ defaultAccessMode: "WRITE" });
  const tx = session.beginTransaction();

  try {
    const result = await tx.run(REVOCATION_CASCADE_CYPHER, {
      delegation_edge_id,
    });

    if (result.records.length === 0) {
      // Edge not found by ID — try fallback
      const fallbackResult = await tx.run(REVOCATION_CASCADE_BY_SCOPE_CYPHER, {
        delegation_edge_id,
        scope_id: delegation_edge_id, // treated as scope_id in fallback
      });

      if (fallbackResult.records.length === 0) {
        await tx.rollback();
        throw new CanaryRevocationError(
          `Delegation edge not found: ${delegation_edge_id}`,
          delegation_edge_id
        );
      }

      const fb = fallbackResult.records[0];
      if (!fb) throw new CanaryRevocationError("Empty fallback record", delegation_edge_id);

      await tx.commit();
      return {
        revoked_edge_id: delegation_edge_id,
        affected_agent_ids: (fb.get("affected_agent_ids") as string[]).filter(Boolean),
        edges_marked_revoked: Number(fb.get("edges_marked_revoked")),
      };
    }

    const record = result.records[0];
    if (!record) throw new CanaryRevocationError("Empty result record", delegation_edge_id);

    await tx.commit();

    return {
      revoked_edge_id: delegation_edge_id,
      affected_agent_ids: (record.get("affected_agent_ids") as string[]).filter(Boolean),
      edges_marked_revoked: Number(record.get("edges_marked_revoked")),
    };
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    await session.close();
  }
}

export class CanaryRevocationError extends Error {
  readonly delegation_edge_id: string;
  constructor(message: string, delegation_edge_id: string) {
    super(message);
    this.name = "CanaryRevocationError";
    this.delegation_edge_id = delegation_edge_id;
  }
}
