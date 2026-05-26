/**
 * Revocation cascade benchmark.
 *
 * Builds a balanced tree: root -> 10 children -> 10 grandchildren each (110 agents).
 * Revokes root and measures cascade timing, edge mutation count.
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

describe("cascade benchmark perf test", () => {
  const collector = createCollector("cascade_benchmark");
  const orgId = uid("org");
  const humanId = uid("human");
  const scopeId = uid("scope");
  const rootAgentId = uid("root");
  
  let rootEdgeId: string;
  const L1_COUNT = 10;
  const L2_COUNT = 10;
  const allAgents = [rootAgentId];
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
      grant_reason: "cascade perf test",
      delegation_edge_id: rootEdgeId,
    });
    
    const invocationPromises: Promise<unknown>[] = [];

    // Root -> L1
    for (let i = 0; i < L1_COUNT; i++) {
      const l1Agent = uid(`l1_${i}`);
      allAgents.push(l1Agent);
      invocationPromises.push(
        emitEvent(orgId, "delegation.invoked", {
          parent_agent_id: rootAgentId,
          child_agent_id: l1Agent,
          scope_id: scopeId,
          task_id: uid("task"),
          inherited_permissions: ["read", "execute"],
          expires_at: expires,
          invocation_edge_id: freshEdgeId(),
        })
      );
      
      // L1 -> L2
      for (let j = 0; j < L2_COUNT; j++) {
        const l2Agent = uid(`l2_${i}_${j}`);
        allAgents.push(l2Agent);
        invocationPromises.push(
          emitEvent(orgId, "delegation.invoked", {
            parent_agent_id: l1Agent,
            child_agent_id: l2Agent,
            scope_id: scopeId,
            task_id: uid("task"),
            inherited_permissions: ["read", "execute"],
            expires_at: expires,
            invocation_edge_id: freshEdgeId(),
          })
        );
      }
    }
    
    await Promise.all(invocationPromises);
    
    // Wait for settlement
    while (true) {
      const records = await queryNeo4j(
        `MATCH ()-[r:DELEGATED_TO {status: 'ACTIVE'}]->() RETURN count(r) AS n`
      );
      if (Number(records[0]?.get("n")) >= L1_COUNT * L2_COUNT + L1_COUNT + 1) break;
      await new Promise(r => setTimeout(r, 500));
    }
  });

  it("measures revocation cascade duration across balanced tree", async () => {
    const { duration_ms } = await measure("cascade_balanced_110", async () => {
      await emitEvent(orgId, "delegation.revoked", {
        delegation_edge_id: rootEdgeId,
        human_id: humanId,
        agent_id: rootAgentId,
        revocation_reason: "cascade perf test",
        cascade_affected_agents: allAgents,
      });
      
      // Wait for all edges to be revoked in subtree
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

    collector.record("cascade_balanced_110", duration_ms, { agent_count: allAgents.length });
    await collector.flush();
  });
});
