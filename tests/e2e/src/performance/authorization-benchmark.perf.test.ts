/**
 * Authorization query benchmark.
 *
 * Measures sequential and concurrent authorization query throughput.
 * Lineage resolution time at varying depths.
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

describe("authorization benchmark perf test", () => {
  const collector = createCollector("authorization_benchmark");
  const orgId = uid("org");
  const humanId = uid("human");
  const scopeId = uid("scope");
  const toolId = uid("tool");
  
  const agents = Array.from({ length: 5 }, (_, i) => uid(`agent_${i}`));
  const expires = expiresIn(ONE_DAY);

  beforeAll(async () => {
    // Chain: Human -> agent_0 -> agent_1 -> agent_2 -> agent_3 -> agent_4
    await emitEvent(orgId, "delegation.created", {
      human_id: humanId,
      agent_id: agents[0],
      scope_id: scopeId,
      permissions: ["read", "execute"],
      expires_at: expires,
      grant_reason: "auth perf test",
      delegation_edge_id: freshEdgeId(),
    });

    for (let i = 0; i < 4; i++) {
      await emitEvent(orgId, "delegation.invoked", {
        parent_agent_id: agents[i],
        child_agent_id: agents[i + 1],
        scope_id: scopeId,
        task_id: uid("task"),
        inherited_permissions: ["read", "execute"],
        expires_at: expires,
        invocation_edge_id: freshEdgeId(),
      });
    }

    // Tool called on leaf agent
    await emitEvent(orgId, "tool.called", {
      agent_id: agents[4],
      tool_id: toolId,
      scope_id: scopeId,
      parameters_hash: "hash",
      authorization_decision_id: "bootstrap",
      called_edge_id: freshEdgeId(),
      tool_risk_tier: "LOW",
    });
    
    // Wait for settlement
    await new Promise(r => setTimeout(r, 2000));
  });

  it("measures 100 sequential authorization queries", async () => {
    const { duration_ms } = await measure("auth_seq_100", async () => {
      for (let i = 0; i < 100; i++) {
        await authorize({
          orgId,
          taskId: uid("task"),
          agentId: agents[4],
          toolId,
          scopeId,
          actionType: "execute",
        });
      }
    });

    collector.record("auth_seq_100", duration_ms);
  });

  it("measures 50 concurrent authorization queries", async () => {
    const { duration_ms } = await measure("auth_concurrent_50", async () => {
      const promises = Array.from({ length: 50 }, () => 
        authorize({
          orgId,
          taskId: uid("task"),
          agentId: agents[4],
          toolId,
          scopeId,
          actionType: "execute",
        })
      );
      await Promise.all(promises);
    });

    collector.record("auth_concurrent_50", duration_ms);
    await collector.flush();
  });
});
