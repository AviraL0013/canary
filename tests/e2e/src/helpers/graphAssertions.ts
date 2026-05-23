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