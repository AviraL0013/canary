/**
 * Deep chain scale test.
 *
 * Generates wide trees of depth-5 chains (the maximum allowed depth).
 * Measures authorization traversal latency per chain and graph query time
 * at increasing graph sizes.
 */

import { beforeAll, describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { emitEvent } from "../helpers/emitEvent";
import { authorize } from "../helpers/authorize";
import { createCollector, measure } from "../helpers/perfInstrumentation";

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

async function setupChain(
  orgId: string,
  humanId: string,
  depth: number,
  scopeId: string,
  expiresAt: string,
): Promise<{ leafAgentId: string }> {
  const agents = Array.from({ length: depth }, (_, i) => uid(`chain_${i}`));
  
  // Human -> Agent 0
  await emitEvent(orgId, "delegation.created", {
    human_id: humanId,
    agent_id: agents[0],
    scope_id: scopeId,
    permissions: ["read", "execute"],
    expires_at: expiresAt,
    grant_reason: "deep chain perf test",
    delegation_edge_id: freshEdgeId(),
  });

  // Agent i -> Agent i+1
  for (let i = 0; i < depth - 1; i++) {
    await emitEvent(orgId, "delegation.invoked", {
      parent_agent_id: agents[i],
      child_agent_id: agents[i + 1],
      scope_id: scopeId,
      task_id: uid("task"),
      inherited_permissions: ["read", "execute"],
      expires_at: expiresAt,
      invocation_edge_id: freshEdgeId(),
    });
  }

  return { leafAgentId: agents[depth - 1] };
}

describe("deep chain perf test", () => {
  const collector = createCollector("deep_chain");
  const orgId = uid("org");
  const humanId = uid("human");
  const scopeId = uid("scope");
  const toolId = uid("tool");
  
  // Create 20 parallel chains of depth 5 (100 agents total)
  const CHAIN_COUNT = 20;
  const DEPTH = 5;
  const leafAgents: string[] = [];
  const expires = expiresIn(ONE_DAY);

  beforeAll(async () => {
    // We register the tool once for all agents, just using a dummy agent first
    await emitEvent(orgId, "tool.called", {
      agent_id: uid("dummy"),
      tool_id: toolId,
      scope_id: scopeId,
      parameters_hash: "hash",
      authorization_decision_id: "bootstrap",
      called_edge_id: freshEdgeId(),
      tool_risk_tier: "LOW",
    });

    const chainPromises = Array.from({ length: CHAIN_COUNT }, () =>
      setupChain(orgId, humanId, DEPTH, scopeId, expires)
    );
    
    const results = await Promise.all(chainPromises);
    for (const r of results) {
      leafAgents.push(r.leafAgentId);
    }

    // Register tool calls for leaf agents
    await Promise.all(leafAgents.map(agentId =>
      emitEvent(orgId, "tool.called", {
        agent_id: agentId,
        tool_id: toolId,
        scope_id: scopeId,
        parameters_hash: "hash",
        authorization_decision_id: "bootstrap",
        called_edge_id: freshEdgeId(),
        tool_risk_tier: "LOW",
      })
    ));

    // Wait for graph to settle
    await new Promise(r => setTimeout(r, 5000));
  });

  it("measures authorization latency on deep chains", async () => {
    for (const leaf of leafAgents) {
      const { result, duration_ms } = await measure("auth_eval_depth_5", async () => {
        return authorize({
          orgId,
          taskId: uid("task"),
          agentId: leaf,
          toolId,
          scopeId,
          actionType: "execute",
        });
      });

      collector.record("auth_eval_depth_5", duration_ms, { depth: DEPTH });
      expect(result.status).toBe(200);
      expect(result.body.decision).toBe("ALLOW");
    }

    const report = await collector.flush();
    expect(report.metrics.length).toBe(CHAIN_COUNT);
  });
});
