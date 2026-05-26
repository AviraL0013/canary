/**
 * Wide fanout scale test.
 *
 * One human, one root agent -> 100 unique child agents.
 * Measures write throughput per delegation, total setup time.
 * Then revoke root and measure cascade cost across all children.
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

describe("wide fanout perf test", () => {
  const collector = createCollector("wide_fanout");
  const orgId = uid("org");
  const humanId = uid("human");
  const scopeId = uid("scope");
  const rootAgentId = uid("root");
  
  const CHILD_COUNT = 100;
  const childAgents = Array.from({ length: CHILD_COUNT }, (_, i) => uid(`child_${i}`));
  let rootEdgeId: string;
  const expires = expiresIn(ONE_DAY);

  beforeAll(async () => {
    // Setup root
    rootEdgeId = freshEdgeId();
    await emitEvent(orgId, "delegation.created", {
      human_id: humanId,
      agent_id: rootAgentId,
      scope_id: scopeId,
      permissions: ["read", "execute"],
      expires_at: expires,
      grant_reason: "wide fanout perf test",
      delegation_edge_id: rootEdgeId,
    });
    
    // Wait for root to settle
    await new Promise(r => setTimeout(r, 2000));
  });

  it("measures setup time for wide fanout (write throughput)", async () => {
    const { duration_ms } = await measure("fanout_setup_100", async () => {
      const promises = childAgents.map(child => 
        emitEvent(orgId, "delegation.invoked", {
          parent_agent_id: rootAgentId,
          child_agent_id: child,
          scope_id: scopeId,
          task_id: uid("task"),
          inherited_permissions: ["read", "execute"],
          expires_at: expires,
          invocation_edge_id: freshEdgeId(),
        })
      );
      
      await Promise.all(promises);
      
      // Verify all children are written
      while (true) {
        const records = await queryNeo4j(
          `MATCH (parent:Agent {id: $rootAgentId})-[:DELEGATED_TO]->(child:Agent) RETURN count(child) AS n`,
          { rootAgentId }
        );
        if (Number(records[0]?.get("n")) === CHILD_COUNT) break;
        await new Promise(r => setTimeout(r, 500));
      }
    });

    collector.record("fanout_setup_100", duration_ms, { child_count: CHILD_COUNT });
  });

  it("measures revocation cascade cost across all children", async () => {
    const { duration_ms } = await measure("fanout_cascade_100", async () => {
      await emitEvent(orgId, "delegation.revoked", {
        delegation_edge_id: rootEdgeId,
        human_id: humanId,
        agent_id: rootAgentId,
        revocation_reason: "wide fanout perf test",
        cascade_affected_agents: [rootAgentId, ...childAgents],
      });
      
      // Wait for all edges to be revoked
      while (true) {
        const records = await queryNeo4j(
          `MATCH (parent:Agent {id: $rootAgentId})-[:DELEGATED_TO*0..2]->(desc:Agent)
           MATCH ()-[r:DELEGATED_TO {status: 'ACTIVE'}]->(desc)
           RETURN count(r) AS n`,
          { rootAgentId }
        );
        if (Number(records[0]?.get("n")) === 0) break;
        await new Promise(r => setTimeout(r, 500));
      }
    });

    collector.record("fanout_cascade_100", duration_ms, { child_count: CHILD_COUNT });
    
    await collector.flush();
  });
});
