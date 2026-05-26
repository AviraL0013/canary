// Query 5 — Transitive revocation cascade
// Canonical delegation graph revocation
//
// SECURITY INVARIANT:
// Revoking upstream authority MUST revoke
// ALL downstream delegated authority.
//
// Graph topology:
//
// (Human)-[:DELEGATED_TO]->(Agent)
// (Agent)-[:DELEGATED_TO]->(Agent)
//
// This query atomically:
// 1. Finds the revoked edge
// 2. Finds the root delegated agent
// 3. Traverses the ENTIRE descendant subtree
// 4. Revokes ALL subtree DELEGATED_TO edges
// 5. Returns affected agent IDs for cache invalidation

import type { Driver, Session } from "neo4j-driver";
import type { RevocationCascadeResult } from "../types/results.js";

const REVOCATION_CASCADE_CYPHER = `
MATCH ()-[root_edge:DELEGATED_TO {
  id: $delegation_edge_id
}]->(root_agent:Agent)

// Acquire write lock immediately.
// Serializes concurrent delegation attempts.
SET root_agent._lock = timestamp()

WITH
  root_edge,
  root_agent

// Traverse full subtree.
MATCH (root_agent)-[:DELEGATED_TO*0..5]->(descendant:Agent)

// Lock descendants too.
// Prevents concurrent subtree mutations.
SET descendant._lock = timestamp()

WITH
  root_edge,
  root_agent,
  collect(DISTINCT descendant) AS descendants

SET
  root_edge.status = 'REVOKED',
  root_edge.revoked_at = datetime(),
  root_edge.active_child_key = NULL

WITH
  root_edge,
  root_agent,
  descendants

UNWIND descendants AS desc

OPTIONAL MATCH (parent)-[edge:DELEGATED_TO]->(desc)

WHERE
  parent = root_agent
  OR
  (root_agent)-[:DELEGATED_TO*0..5]->(parent)

SET
  edge.status = 'REVOKED',
  edge.revoked_at = datetime(),
  edge.active_child_key = NULL

WITH
  root_edge,
  descendants

RETURN
  root_edge.id AS revoked_edge_id,
  [d IN descendants | d.id] AS affected_agent_ids,
  size(descendants) + 1 AS edges_marked_revoked
`;

export async function revocationCascade(
  driver: Driver,
  delegation_edge_id: string
): Promise<RevocationCascadeResult> {
  const session: Session = driver.session({
    defaultAccessMode: "WRITE",
  });

  const tx = session.beginTransaction();

  try {
    const result = await tx.run(
      REVOCATION_CASCADE_CYPHER,
      {
        delegation_edge_id,
      }
    );

    if (result.records.length === 0) {
      await tx.rollback();

      throw new CanaryRevocationError(
        `Delegation edge not found: ${delegation_edge_id}`,
        delegation_edge_id
      );
    }

    const record = result.records[0];

    if (!record) {
      await tx.rollback();

      throw new CanaryRevocationError(
        "Empty revocation result",
        delegation_edge_id
      );
    }

    await tx.commit();

    return {
      revoked_edge_id:
        record.get("revoked_edge_id") as string,

      affected_agent_ids:
        (
          record.get(
            "affected_agent_ids"
          ) as string[]
        ).filter(Boolean),

      edges_marked_revoked:
        Number(
          record.get("edges_marked_revoked")
        ),
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

  constructor(
    message: string,
    delegation_edge_id: string
  ) {
    super(message);

    this.name = "CanaryRevocationError";

    this.delegation_edge_id =
      delegation_edge_id;
  }
}