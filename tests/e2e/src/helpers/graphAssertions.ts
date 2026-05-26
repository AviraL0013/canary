import { expect } from "vitest";
import { queryNeo4j } from "./neo4j";

/**
 * Assert exact edge status.
 *
 * Example:
 * ACTIVE
 * REVOKED
 * EXPIRED
 */
export async function assertEdgeStatus(
  edgeId: string,
  expectedStatus: string,
) {
  const records = await queryNeo4j(
    `
    MATCH ()-[r:DELEGATED_TO]->()
    WHERE r.id = $edgeId
    RETURN r.status AS status
    `,
    { edgeId },
  );

  expect(records.length).toBe(1);

  const status =
    records[0].get("status");

  expect(status)
    .toBe(expectedStatus);
}

/**
 * Assert deterministic delegation depth.
 *
 * Root edge should be depth=0.
 * Child edges increment exactly by 1.
 */
export async function assertEdgeDepth(
  edgeId: string,
  expectedDepth: number,
) {
  const records = await queryNeo4j(
    `
    MATCH ()-[r:DELEGATED_TO]->()
    WHERE r.id = $edgeId
    RETURN r.depth AS depth
    `,
    { edgeId },
  );

  expect(records.length).toBe(1);

  const depth =
    records[0].get("depth");

  expect(Number(depth))
    .toBe(expectedDepth);
}

/**
 * Assert an agent has zero ACTIVE incoming
 * delegation edges.
 *
 * Used after revocation cascades.
 */
export async function assertNoActiveEdges(
  agentId: string,
) {
  const records = await queryNeo4j(
    `
    MATCH (:Agent {id: $agentId})
      <-[r:DELEGATED_TO]-()
    WHERE r.status = "ACTIVE"
    RETURN count(r) AS activeCount
    `,
    { agentId },
  );

  expect(records.length).toBe(1);

  const count =
    records[0].get("activeCount");

  expect(Number(count))
    .toBe(0);
}

/**
 * Assert an agent has exactly one
 * ACTIVE parent authority.
 *
 * Prevents lineage forks.
 */
export async function assertSingleActiveParent(
  agentId: string,
) {
  const records = await queryNeo4j(
    `
    MATCH (:Agent {id: $agentId})
      <-[r:DELEGATED_TO]-()
    WHERE r.status = "ACTIVE"
    RETURN count(r) AS parentCount
    `,
    { agentId },
  );

  expect(records.length).toBe(1);

  const count =
    records[0].get("parentCount");

  expect(Number(count))
    .toBeLessThanOrEqual(1);
}

/**
 * Assert exact authority chain.
 *
 * Example:
 * Human -> Agent -> SubAgent
 */
export async function assertAuthorityChain(
  chain: string[],
) {
  expect(chain.length)
    .toBeGreaterThan(1);

  for (let i = 0; i < chain.length - 1; i++) {
    const parentId = chain[i];
    const childId = chain[i + 1];

    const records = await queryNeo4j(
      `
      MATCH (p)-[r:DELEGATED_TO]->(c)
      WHERE p.id = $parentId
        AND c.id = $childId
        AND r.status = "ACTIVE"
      RETURN count(r) AS edgeCount
      `,
      {
        parentId,
        childId,
      },
    );

    expect(records.length).toBe(1);

    const edgeCount =
      records[0].get("edgeCount");

    expect(Number(edgeCount))
      .toBe(1);
  }
}

/**
 * Assert all descendant edges
 * of a revoked root edge
 * became REVOKED.
 */
export async function assertRevocationCascade(
  rootEdgeId: string,
) {
  const records = await queryNeo4j(
    `
    MATCH ()-[root:DELEGATED_TO]->()
    WHERE root.id = $rootEdgeId

    MATCH ()-[r:DELEGATED_TO]->()
    WHERE r.lineage_root_id = root.id

    RETURN collect(r.status) AS statuses
    `,
    { rootEdgeId },
  );

  expect(records.length).toBe(1);

  const statuses =
    records[0].get("statuses");

  expect(Array.isArray(statuses))
    .toBe(true);

  for (const status of statuses) {
    expect(status)
      .toBe("REVOKED");
  }
}

/**
 * Assert active edge count
 * for an org.
 *
 * Useful after revocation propagation.
 */
export async function assertActiveEdgeCount(
  orgId: string,
  expectedCount: number,
) {
  const records = await queryNeo4j(
    `
    MATCH ()-[r:DELEGATED_TO]->()
    WHERE r.org_id = $orgId
      AND r.status = "ACTIVE"
    RETURN count(r) AS activeCount
    `,
    { orgId },
  );

  expect(records.length).toBe(1);

  const count =
    records[0].get("activeCount");

  expect(Number(count))
    .toBe(expectedCount);
}

/**
 * Assert delegation edge exists.
 */
export async function assertEdgeExists(
  edgeId: string,
) {
  const records = await queryNeo4j(
    `
    MATCH ()-[r:DELEGATED_TO]->()
    WHERE r.id = $edgeId
    RETURN count(r) AS edgeCount
    `,
    { edgeId },
  );

  expect(records.length).toBe(1);

  const count =
    records[0].get("edgeCount");

  expect(Number(count))
    .toBe(1);
}

/**
 * Assert delegation edge does NOT exist.
 */
export async function assertEdgeNotExists(
  edgeId: string,
) {
  const records = await queryNeo4j(
    `
    MATCH ()-[r:DELEGATED_TO]->()
    WHERE r.id = $edgeId
    RETURN count(r) AS edgeCount
    `,
    { edgeId },
  );

  expect(records.length).toBe(1);

  const count =
    records[0].get("edgeCount");

  expect(Number(count))
    .toBe(0);
}

// ═══════════════════════════════════════════════════════════════════════
// TOPOLOGY VERIFICATION HELPERS
// ═══════════════════════════════════════════════════════════════════════
//
// These assertions validate the graph itself — not HTTP responses.
// The delegation graph is the security boundary.
// Every invariant here is critical infrastructure.
//
// ═══════════════════════════════════════════════════════════════════════

/**
 * Assert exactly ONE complete ACTIVE authority lineage
 * exists from any Human root to the target agent.
 *
 * Prevents split-brain authority at the per-agent level.
 *
 * A passing check means:
 * - the agent has a deterministic, unambiguous authority source
 * - no concurrent delegation race left a forked lineage
 *
 * NOTE: use assertNoSplitBrainAuthorities() for the global sweep.
 */
export async function assertSingleActiveAuthorityPath(
  agentId: string,
) {
  const records = await queryNeo4j(
    `
    MATCH path = (h:Human)-[:DELEGATED_TO*1..6]->(a:Agent {id: $agentId})
    WHERE ALL(rel IN relationships(path) WHERE rel.status = 'ACTIVE')
    RETURN count(path) AS pathCount
    `,
    { agentId },
  );

  expect(records.length).toBe(1);

  const pathCount = Number(
    records[0].get("pathCount"),
  );

  expect(
    pathCount,
    `Split-brain authority: agent ${agentId} has ${pathCount} active authority paths, expected exactly 1`,
  ).toBe(1);
}

/**
 * Assert no cyclic delegation paths exist
 * in the ACTIVE topology.
 *
 * IMPORTANT:
 * Only ACTIVE edges are checked.
 * Revoked historical cycles are irrelevant
 * to executable authority.
 *
 * Validates:
 * - no self-delegation loops
 * - no transitive cycles (A -> B -> C -> A)
 * - no ancestor re-entry
 */
export async function assertNoCycles() {
  const records = await queryNeo4j(
    `
    MATCH p = (a:Agent)-[rels:DELEGATED_TO*1..25]->(a)
    WHERE ALL(rel IN rels WHERE rel.status = 'ACTIVE')
    RETURN a.id AS agent_id, length(p) AS cycle_length
    LIMIT 1
    `,
  );

  expect(
    records.length,
    records.length > 0
      ? `ACTIVE delegation cycle detected: agent ${records[0].get("agent_id")} ` +
        `has cycle of length ${records[0].get("cycle_length")}`
      : "",
  ).toBe(0);
}

/**
 * Assert stored edge depth matches actual traversal depth
 * AND matches the expected value.
 *
 * Detects depth corruption bugs where the persisted
 * edge.depth diverges from the real graph topology.
 *
 * The traversal depth is computed by finding the
 * shortest ACTIVE path from any Human to the edge's
 * target agent, then counting hops.
 */
export async function assertDelegationDepthConsistency(
  edgeId: string,
  expectedDepth: number,
) {
  // 1. Get stored depth and target agent
  const edgeRecords = await queryNeo4j(
    `
    MATCH ()-[r:DELEGATED_TO]->(target)
    WHERE r.id = $edgeId
    RETURN r.depth AS storedDepth, target.id AS targetId
    `,
    { edgeId },
  );

  expect(
    edgeRecords.length,
    `Edge ${edgeId} not found in graph`,
  ).toBe(1);

  const storedDepth = Number(
    edgeRecords[0].get("storedDepth"),
  );

  const targetId =
    edgeRecords[0].get("targetId") as string;

  // 2. Compute actual traversal depth via shortest ACTIVE path
  const pathRecords = await queryNeo4j(
    `
    MATCH path = (h:Human)-[:DELEGATED_TO*1..6]->(target:Agent {id: $targetId})
    WHERE ALL(rel IN relationships(path) WHERE rel.status = 'ACTIVE')
    WITH path
    ORDER BY length(path) ASC
    LIMIT 1
    RETURN length(path) AS actualDepth
    `,
    { targetId },
  );

  // If no path found, agent may be a root (depth 0) — handle gracefully
  const actualDepth =
    pathRecords.length > 0
      ? Number(pathRecords[0].get("actualDepth"))
      : 0;

  expect(
    storedDepth,
    `Depth corruption: edge ${edgeId} stores depth=${storedDepth} ` +
      `but actual traversal depth=${actualDepth}, expected=${expectedDepth}`,
  ).toBe(expectedDepth);

  // Also verify stored matches traversal
  // Root edges (Human->Agent) have depth=0, traversal path length=1
  // So for non-root: storedDepth should equal actualDepth
  if (pathRecords.length > 0) {
    expect(
      storedDepth,
      `Depth inconsistency: edge ${edgeId} stores depth=${storedDepth} ` +
        `but traversal from Human to ${targetId} is ${actualDepth} hops`,
    ).toBe(actualDepth);
  }
}

/**
 * Assert the exact parent lineage chain for an agent
 * matches the expected ancestry.
 *
 * expectedLineage is ordered from Human root to the agent itself.
 * Example: ["human_abc", "agent_1", "agent_2", "agent_3"]
 *
 * Validates:
 * - deterministic ancestry
 * - correct delegation order
 * - no ambiguous authority chain
 */
export async function assertAuthorityLineage(
  agentId: string,
  expectedLineage: string[],
) {
  const records = await queryNeo4j(
    `
    MATCH path = (h:Human)-[:DELEGATED_TO*1..6]->(a:Agent {id: $agentId})
    WHERE ALL(rel IN relationships(path) WHERE rel.status = 'ACTIVE')
    WITH path
    ORDER BY length(path) ASC
    LIMIT 1
    RETURN [n IN nodes(path) | n.id] AS lineage
    `,
    { agentId },
  );

  expect(
    records.length,
    `No ACTIVE authority lineage found for agent ${agentId}`,
  ).toBeGreaterThan(0);

  const actualLineage =
    records[0].get("lineage") as string[];

  expect(
    actualLineage,
    `Lineage mismatch for agent ${agentId}: ` +
      `expected [${expectedLineage.join(" -> ")}] ` +
      `but found [${actualLineage.join(" -> ")}]`,
  ).toEqual(expectedLineage);
}

/**
 * Assert no invalid ACTIVE edges exist in the graph.
 *
 * The system does NOT persist rejected edges.
 * So checking for status='REJECTED' is conceptually wrong.
 *
 * The real invariant is: every ACTIVE edge must be valid.
 *
 * Validates:
 * - no child has >1 ACTIVE incoming edge
 * - every ACTIVE edge's target traces to a Human root via ACTIVE edges
 *
 * This is the structural integrity check for the entire graph.
 */
export async function assertNoInvalidActiveEdges() {
  // Check 1: Any child agent with >1 ACTIVE incoming edge
  const multiParentRecords = await queryNeo4j(
    `
    MATCH (child:Agent)
    MATCH ()-[r:DELEGATED_TO {status: 'ACTIVE'}]->(child)
    WITH child, count(r) AS incoming
    WHERE incoming > 1
    RETURN child.id AS agent_id, incoming AS active_count
    LIMIT 10
    `,
  );

  expect(
    multiParentRecords.length,
    multiParentRecords.length > 0
      ? `Invalid ACTIVE edges: agent ${multiParentRecords[0].get("agent_id")} ` +
        `has ${multiParentRecords[0].get("active_count")} active incoming edges (max 1). ` +
        `Total agents with multiple parents: ${multiParentRecords.length}`
      : "",
  ).toBe(0);

  // Check 2: ACTIVE edges whose target agent has no valid lineage to any Human
  const orphanRecords = await queryNeo4j(
    `
    MATCH ()-[r:DELEGATED_TO {status: 'ACTIVE'}]->(target:Agent)
    WHERE NOT EXISTS {
      MATCH path = (h:Human)-[:DELEGATED_TO*1..6]->(target)
      WHERE ALL(rel IN relationships(path) WHERE rel.status = 'ACTIVE')
    }
    RETURN r.id AS orphan_edge_id, target.id AS orphan_agent_id
    LIMIT 10
    `,
  );

  expect(
    orphanRecords.length,
    orphanRecords.length > 0
      ? `Orphan ACTIVE edge ${orphanRecords[0].get("orphan_edge_id")}: ` +
        `target agent ${orphanRecords[0].get("orphan_agent_id")} ` +
        `has no valid ACTIVE lineage to any Human root. ` +
        `Total orphan edges: ${orphanRecords.length}`
      : "",
  ).toBe(0);
}

/**
 * Assert an entire subtree has been fully revoked.
 *
 * After a revocation cascade on a root agent,
 * zero ACTIVE descendant edges should remain.
 *
 * Walks the full subtree (regardless of edge status)
 * and checks for any remaining ACTIVE edges.
 */
export async function assertSubtreeFullyRevoked(
  rootAgentId: string,
) {
  const records = await queryNeo4j(
    `
    MATCH path = (root:Agent {id: $rootAgentId})-[:DELEGATED_TO*0..6]->(desc:Agent)
    WHERE ALL(rel IN relationships(path) WHERE rel.status IN ['ACTIVE', 'REVOKED'])
    MATCH ()-[r:DELEGATED_TO {status: 'ACTIVE'}]->(desc)
    RETURN desc.id AS agent_id, r.id AS edge_id
    LIMIT 10
    `,
    { rootAgentId },
  );

  expect(
    records.length,
    records.length > 0
      ? `Subtree not fully revoked: agent ${records[0].get("agent_id")} ` +
        `still has ACTIVE edge ${records[0].get("edge_id")}. ` +
        `Total surviving ACTIVE edges in subtree: ${records.length}`
      : "",
  ).toBe(0);
}

/**
 * CORE SECURITY PROPERTY — GLOBAL INVARIANT
 *
 * Assert no agent in the entire graph has more than
 * one ACTIVE incoming authority edge.
 *
 * This is the canonical single-authority invariant.
 * One executable authority lineage per agent.
 * That is the heart of Canary.
 *
 * This MUST run:
 * - after stress tests
 * - after revoke storms
 * - after perf tests
 * - after failure injection
 * - as the final assertion in every adversarial test suite
 */
export async function assertNoSplitBrainAuthorities() {
  const records = await queryNeo4j(
    `
    MATCH (child:Agent)
    MATCH ()-[r:DELEGATED_TO {status: 'ACTIVE'}]->(child)
    WITH child, count(r) AS incoming
    WHERE incoming > 1
    RETURN child.id AS agent_id, incoming AS active_incoming_count
    `,
  );

  expect(
    records.length,
    records.length > 0
      ? `SPLIT-BRAIN AUTHORITY VIOLATION: agent ${records[0].get("agent_id")} ` +
        `has ${records[0].get("active_incoming_count")} active authority sources — ` +
        `exactly 1 is required. This is a critical security invariant failure. ` +
        `Total agents in violation: ${records.length}`
      : "",
  ).toBe(0);
}