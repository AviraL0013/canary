/**
 * Concurrent mutation stress test.
 *
 * Concurrent delegation races (N parents -> 1 child)
 * Measures conflict count, retry frequency, invariant violations.
 */

import { beforeAll, describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { emitEvent } from "../helpers/emitEvent";
import { createCollector, measure } from "../helpers/perfInstrumentation";
import { queryNeo4j } from "../helpers/neo4j";

function uid(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function freshEdgeId() {
  return `edge_${randomUUID()}`;
}

const ONE_DAY = 86_400_000;
function expiresIn(ms: number) {
  return new Date(Date.now() + ms).toISOString();
}

describe("concurrent stress perf test", () => {
  const collector = createCollector("concurrent_stress");
  const orgId = uid("org");
  const humanId = uid("human");
  const scopeId = uid("scope");
  
  const PARENT_COUNT = 50;
  const parents = Array.from({ length: PARENT_COUNT }, (_, i) => uid(`parent_${i}`));
  const childId = uid("contested_child");
  const expires = expiresIn(ONE_DAY);

  beforeAll(async () => {
    const parentPromises = parents.map(parentAgentId => 
      emitEvent(orgId, "delegation.created", {
        human_id: humanId,
        agent_id: parentAgentId,
        scope_id: scopeId,
        permissions: ["read", "execute"],
        expires_at: expires,
        grant_reason: "concurrent stress perf test",
        delegation_edge_id: freshEdgeId(),
      })
    );
    await Promise.all(parentPromises);
    
    // Wait for settlement
    await new Promise(r => setTimeout(r, 2000));
  });

  it("measures duration and success rate of 50 concurrent delegations to same child", async () => {
    const { duration_ms } = await measure("concurrent_race_50", async () => {
      const promises = parents.map(parentId => 
        emitEvent(orgId, "delegation.invoked", {
          parent_agent_id: parentId,
          child_agent_id: childId,
          scope_id: scopeId,
          task_id: uid("task"),
          inherited_permissions: ["read", "execute"],
          expires_at: expires,
          invocation_edge_id: freshEdgeId(),
        })
      );
      
      const results = await Promise.all(promises);
      const errors = results.filter(r => r.status >= 400);
      
      // We expect many conflicts/errors (e.g. MULTIPLE_ACTIVE_AUTHORITIES)
      // Only one or a few might succeed due to locking. Wait for settlement.
      await new Promise(r => setTimeout(r, 2000));
      return { errors: errors.length };
    });

    collector.record("concurrent_race_50", duration_ms, { parent_count: PARENT_COUNT });
    
    // Validate invariant: child has <= 1 incoming active edge
    const records = await queryNeo4j(
      `MATCH ()-[r:DELEGATED_TO {status: 'ACTIVE'}]->(child:Agent {id: $childId}) RETURN count(r) AS n`,
      { childId }
    );
    expect(Number(records[0]?.get("n"))).toBeLessThanOrEqual(1);

    await collector.flush();
  });
});
