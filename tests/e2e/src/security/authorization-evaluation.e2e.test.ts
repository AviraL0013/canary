/**
 * AUTHORIZATION EVALUATION TESTS
 * ═══════════════════════════════════════════════════════════════════════
 *
 * These tests validate runtime authorization SEMANTICS — not delegation
 * creation mechanics. The existing test suites validate that the graph
 * is built correctly. This suite validates that authorization QUERIES
 * return correct decisions against the graph.
 *
 * Separation matters:
 *   delegation creation = graph mutation correctness
 *   authorization evaluation = graph query correctness
 *
 * Every test validates BOTH:
 *   1. The HTTP authorization response (decision, reasoning)
 *   2. The graph state (topology assertions)
 *
 * ═══════════════════════════════════════════════════════════════════════
 */

import {
  beforeAll,
  afterAll,
  describe,
  expect,
  it,
} from "vitest";

import { randomUUID } from "crypto";

import { emitEvent } from "../helpers/emitEvent";
import { authorize } from "../helpers/authorize";
import { queryNeo4j } from "../helpers/neo4j";

import {
  waitFor,
  waitForEdgeStatus,
  waitForNoActiveEdges,
} from "../helpers/waitFor";

import {
  assertSingleActiveAuthorityPath,
  assertAuthorityLineage,
  assertSubtreeFullyRevoked,
  assertNoSplitBrainAuthorities,
  assertNoActiveEdges,
} from "../helpers/graphAssertions";

// ─── helpers ──────────────────────────────────────────────────────────────────

function uid(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function freshEdgeId() {
  return `edge_${randomUUID()}`;
}

function expiresIn(ms: number) {
  return new Date(Date.now() + ms).toISOString();
}

const ONE_DAY = 86_400_000;

/**
 * Establish Human→Agent root delegation and wait for graph convergence.
 */
async function setupRoot(params: {
  orgId: string;
  humanId: string;
  agentId: string;
  scopeId: string;
  permissions?: string[];
  expiresAt?: string;
}): Promise<{ edgeId: string }> {
  const edgeId = freshEdgeId();

  const result = await emitEvent(params.orgId, "delegation.created", {
    human_id: params.humanId,
    agent_id: params.agentId,
    scope_id: params.scopeId,
    permissions: params.permissions ?? ["read", "execute"],
    expires_at: params.expiresAt ?? expiresIn(ONE_DAY),
    grant_reason: "auth-eval test setup",
    delegation_edge_id: edgeId,
  });

  expect(result.status, `root setup failed: ${JSON.stringify(result.body)}`).toBe(200);

  await waitFor(
    async () => {
      const records = await queryNeo4j(
        `MATCH (a:Agent {id: $agentId}) RETURN count(a) AS n`,
        { agentId: params.agentId },
      );
      return Number(records[0]?.get("n") ?? 0) > 0;
    },
    { timeoutMs: 15_000, intervalMs: 200, description: `agent ${params.agentId} appears` },
  );

  return { edgeId };
}

/**
 * Establish Agent→Agent invocation and wait for graph convergence.
 */
async function setupInvocation(params: {
  orgId: string;
  parentId: string;
  childId: string;
  scopeId: string;
  permissions: string[];
  expiresAt?: string;
  taskId?: string;
}): Promise<{ edgeId: string }> {
  const edgeId = freshEdgeId();

  const result = await emitEvent(params.orgId, "delegation.invoked", {
    parent_agent_id: params.parentId,
    child_agent_id: params.childId,
    scope_id: params.scopeId,
    task_id: params.taskId ?? uid("task"),
    inherited_permissions: params.permissions,
    expires_at: params.expiresAt ?? expiresIn(ONE_DAY),
    invocation_edge_id: edgeId,
  });

  expect(result.status, `invocation setup failed: ${JSON.stringify(result.body)}`).toBe(200);

  await waitFor(
    async () => {
      const records = await queryNeo4j(
        `MATCH ()-[r:DELEGATED_TO {id: $edgeId}]->() RETURN count(r) AS n`,
        { edgeId },
      );
      return Number(records[0]?.get("n") ?? 0) > 0;
    },
    { timeoutMs: 15_000, intervalMs: 200, description: `edge ${edgeId} appears` },
  );

  return { edgeId };
}

/**
 * Register a tool call so the authorization service can find the tool node.
 */
async function registerTool(params: {
  orgId: string;
  agentId: string;
  toolId: string;
  scopeId: string;
}) {
  await emitEvent(params.orgId, "tool.called", {
    agent_id: params.agentId,
    tool_id: params.toolId,
    scope_id: params.scopeId,
    parameters_hash: "e2e_hash",
    authorization_decision_id: "bootstrap",
    called_edge_id: freshEdgeId(),
    tool_risk_tier: "LOW",
  });
}

/**
 * Wait until authorize() returns an expected decision.
 */
async function waitForDecision(
  params: Parameters<typeof authorize>[0],
  expectedDecision: string,
  description: string,
) {
  await waitFor(
    async () => {
      const result = await authorize(params);
      return result.status === 200 && result.body.decision === expectedDecision;
    },
    { timeoutMs: 15_000, intervalMs: 500, description },
  );
}

// ─── test suite ───────────────────────────────────────────────────────────────

describe("authorization evaluation", () => {

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 1 — Valid delegated execution
  //
  // Human delegates [read, execute] to Parent.
  // Parent invokes Child with [read, execute].
  // Child calls Tool.
  // Authorization query for child + execute → ALLOW.
  // ──────────────────────────────────────────────────────────────────────────
  describe("valid delegated execution", () => {
    const org = uid("org");
    const human = uid("human");
    const scope = uid("scope");
    const parent = uid("parent");
    const child = uid("child");
    const tool = uid("tool");
    const task = uid("task");
    let expires: string;

    beforeAll(async () => {
      expires = expiresIn(ONE_DAY);
      await setupRoot({ orgId: org, humanId: human, agentId: parent, scopeId: scope, expiresAt: expires });
      await setupInvocation({ orgId: org, parentId: parent, childId: child, scopeId: scope, permissions: ["read", "execute"], expiresAt: expires });
      await registerTool({ orgId: org, agentId: child, toolId: tool, scopeId: scope });
      await waitForDecision(
        { orgId: org, taskId: task, agentId: child, toolId: tool, scopeId: scope, actionType: "execute" },
        "ALLOW",
        "authorization readiness for valid execution",
      );
    });

    it("returns ALLOW with valid chain reasoning", async () => {
      const result = await authorize({
        orgId: org, taskId: task, agentId: child,
        toolId: tool, scopeId: scope, actionType: "execute",
      });

      expect(result.status).toBe(200);
      expect(result.body.decision).toBe("ALLOW");
      expect(result.body.reasoning.chain_found).toBe(true);
      expect(result.body.reasoning.chain_unrevoked).toBe(true);
      expect(result.body.reasoning.action_within_scope).toBe(true);
    });

    it("graph confirms single active authority path", async () => {
      await assertSingleActiveAuthorityPath(child);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 2 — Revoked authority execution denial
  //
  // Same chain as test 1, then revoke root edge.
  // Authorization query MUST deny execution.
  // ──────────────────────────────────────────────────────────────────────────
  describe("revoked authority execution denial", () => {
    const org = uid("org");
    const human = uid("human");
    const scope = uid("scope");
    const parent = uid("parent");
    const child = uid("child");
    const tool = uid("tool");
    const task = uid("task");
    let expires: string;

    let rootEdgeId: string;

    beforeAll(async () => {
      expires = expiresIn(ONE_DAY);
      const root = await setupRoot({ orgId: org, humanId: human, agentId: parent, scopeId: scope, expiresAt: expires });
      rootEdgeId = root.edgeId;
      await setupInvocation({ orgId: org, parentId: parent, childId: child, scopeId: scope, permissions: ["read", "execute"], expiresAt: expires });
      await registerTool({ orgId: org, agentId: child, toolId: tool, scopeId: scope });

      // Confirm ALLOW before revocation
      await waitForDecision(
        { orgId: org, taskId: task, agentId: child, toolId: tool, scopeId: scope, actionType: "execute" },
        "ALLOW",
        "pre-revocation ALLOW",
      );

      // Revoke root
      const revoke = await emitEvent(org, "delegation.revoked", {
        delegation_edge_id: rootEdgeId,
        human_id: human,
        agent_id: parent,
        revocation_reason: "auth eval test",
        cascade_affected_agents: [parent, child],
      });
      expect(revoke.status).toBe(200);

      await waitForEdgeStatus(rootEdgeId, "REVOKED");
    });

    it("returns BLOCK after revocation", async () => {
      await waitForDecision(
        { orgId: org, taskId: task, agentId: child, toolId: tool, scopeId: scope, actionType: "execute" },
        "BLOCK",
        "post-revocation BLOCK convergence",
      );

      const result = await authorize({
        orgId: org, taskId: task, agentId: child,
        toolId: tool, scopeId: scope, actionType: "execute",
      });

      expect(result.status).toBe(200);
      expect(result.body.decision).toBe("BLOCK");
    });

    it("graph confirms subtree fully revoked", async () => {
      await assertSubtreeFullyRevoked(parent);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 3 — Expired authority denial
  //
  // Delegation with very short expiry.
  // Wait for expiry. Authorization MUST fail.
  // ──────────────────────────────────────────────────────────────────────────
  describe("expired authority denial", () => {
    const org = uid("org");
    const human = uid("human");
    const scope = uid("scope");
    const agent = uid("agent");
    const tool = uid("tool");
    const task = uid("task");

    let shortExpiry: string;

    beforeAll(async () => {
      shortExpiry = expiresIn(10_000); // 10-second expiry window
      await setupRoot({ orgId: org, humanId: human, agentId: agent, scopeId: scope, expiresAt: shortExpiry });
      await registerTool({ orgId: org, agentId: agent, toolId: tool, scopeId: scope });

      // Confirm it works while valid
      await waitForDecision(
        { orgId: org, taskId: task, agentId: agent, toolId: tool, scopeId: scope, actionType: "read" },
        "ALLOW",
        "pre-expiry ALLOW",
      );

      // Wait for expiry
      await new Promise((r) => setTimeout(r, 11_000));
    });

    it("returns BLOCK after expiry", async () => {
      const result = await authorize({
        orgId: org, taskId: task, agentId: agent,
        toolId: tool, scopeId: scope, actionType: "read",
      });

      expect(result.status).toBe(200);
      expect(result.body.decision).toBe("BLOCK");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 4 — Scope attenuation enforcement
  //
  // Parent has [read, write]. Child narrowed to [read].
  // Child tries to execute "write" → MUST be denied.
  // ──────────────────────────────────────────────────────────────────────────
  describe("scope attenuation enforcement", () => {
    const org = uid("org");
    const human = uid("human");
    const scope = uid("scope");
    const parent = uid("parent");
    const child = uid("child");
    const tool = uid("tool");
    const task = uid("task");
    let expires: string;

    beforeAll(async () => {
      expires = expiresIn(ONE_DAY);
      await setupRoot({ orgId: org, humanId: human, agentId: parent, scopeId: scope, permissions: ["read", "write"], expiresAt: expires });
      await setupInvocation({ orgId: org, parentId: parent, childId: child, scopeId: scope, permissions: ["read"], expiresAt: expires });
      await registerTool({ orgId: org, agentId: child, toolId: tool, scopeId: scope });

      // Confirm read works
      await waitForDecision(
        { orgId: org, taskId: task, agentId: child, toolId: tool, scopeId: scope, actionType: "read" },
        "ALLOW",
        "child read ALLOW",
      );
    });

    it("allows action within attenuated scope", async () => {
      const result = await authorize({
        orgId: org, taskId: task, agentId: child,
        toolId: tool, scopeId: scope, actionType: "read",
      });

      expect(result.status).toBe(200);
      expect(result.body.decision).toBe("ALLOW");
    });

    it("blocks action outside attenuated scope", async () => {
      const result = await authorize({
        orgId: org, taskId: uid("task"), agentId: child,
        toolId: tool, scopeId: scope, actionType: "write",
      });

      expect(result.status).toBe(200);
      expect(result.body.decision).toBe("BLOCK");
      expect(result.body.reasoning.action_within_scope).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 5 — Multi-hop inherited authority
  //
  // Human → Planner [read, execute] → Worker [read]
  //
  // Worker: read → ALLOW
  // Worker: execute → BLOCK (not in inherited permissions)
  //
  // No privilege amplification allowed.
  // ──────────────────────────────────────────────────────────────────────────
  describe("multi-hop inherited authority", () => {
    const org = uid("org");
    const human = uid("human");
    const scope = uid("scope");
    const planner = uid("planner");
    const worker = uid("worker");
    const tool = uid("tool");
    const task = uid("task");
    let expires: string;

    beforeAll(async () => {
      expires = expiresIn(ONE_DAY);
      await setupRoot({ orgId: org, humanId: human, agentId: planner, scopeId: scope, permissions: ["read", "execute"], expiresAt: expires });
      await setupInvocation({ orgId: org, parentId: planner, childId: worker, scopeId: scope, permissions: ["read"], expiresAt: expires });
      await registerTool({ orgId: org, agentId: worker, toolId: tool, scopeId: scope });

      await waitForDecision(
        { orgId: org, taskId: task, agentId: worker, toolId: tool, scopeId: scope, actionType: "read" },
        "ALLOW",
        "worker read ALLOW readiness",
      );
    });

    it("allows worker to execute within inherited permissions", async () => {
      const result = await authorize({
        orgId: org, taskId: task, agentId: worker,
        toolId: tool, scopeId: scope, actionType: "read",
      });

      expect(result.status).toBe(200);
      expect(result.body.decision).toBe("ALLOW");
    });

    it("blocks privilege amplification beyond inherited permissions", async () => {
      const result = await authorize({
        orgId: org, taskId: uid("task"), agentId: worker,
        toolId: tool, scopeId: scope, actionType: "execute",
      });

      expect(result.status).toBe(200);
      expect(result.body.decision).toBe("BLOCK");
    });

    it("graph confirms correct lineage", async () => {
      await assertAuthorityLineage(worker, [human, planner, worker]);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 6 — Concurrent revoke during authorization evaluation
  //
  // Fire revoke + authorize in Promise.all().
  // After settle: authorize() → BLOCK (deterministic).
  //
  // This validates authorization query determinism.
  // No stale ALLOW after revocation commit.
  // ──────────────────────────────────────────────────────────────────────────
  describe("concurrent revoke during authorization evaluation", () => {
    const org = uid("org");
    const human = uid("human");
    const scope = uid("scope");
    const agent = uid("agent");
    const tool = uid("tool");
    const task = uid("task");
    let expires: string;

    let rootEdgeId: string;

    beforeAll(async () => {
      expires = expiresIn(ONE_DAY);
      const root = await setupRoot({ orgId: org, humanId: human, agentId: agent, scopeId: scope, expiresAt: expires });
      rootEdgeId = root.edgeId;
      await registerTool({ orgId: org, agentId: agent, toolId: tool, scopeId: scope });

      await waitForDecision(
        { orgId: org, taskId: task, agentId: agent, toolId: tool, scopeId: scope, actionType: "read" },
        "ALLOW",
        "pre-concurrent-revoke ALLOW",
      );
    });

    it("authorization deterministically becomes BLOCK after concurrent revoke", async () => {
      // Fire simultaneously
      await Promise.all([
        emitEvent(org, "delegation.revoked", {
          delegation_edge_id: rootEdgeId,
          human_id: human,
          agent_id: agent,
          revocation_reason: "concurrent auth eval test",
          cascade_affected_agents: [agent],
        }),
        authorize({
          orgId: org, taskId: uid("task"), agentId: agent,
          toolId: tool, scopeId: scope, actionType: "read",
        }),
      ]);

      // After settle: must be BLOCK
      await waitForDecision(
        { orgId: org, taskId: uid("task"), agentId: agent, toolId: tool, scopeId: scope, actionType: "read" },
        "BLOCK",
        "post-concurrent-revoke BLOCK convergence",
      );

      const result = await authorize({
        orgId: org, taskId: uid("task"), agentId: agent,
        toolId: tool, scopeId: scope, actionType: "read",
      });

      expect(result.body.decision).toBe("BLOCK");
    });

    it("graph has no split-brain authorities", async () => {
      await assertNoSplitBrainAuthorities();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 7 — Delegation depth enforcement
  //
  // Build chain to MAX_AUTHORITY_PATH_DEPTH (5).
  // Agent at depth 5 is valid. Depth 6 is rejected at delegation time.
  // Verify the deepest valid agent can still authorize.
  // ──────────────────────────────────────────────────────────────────────────
  describe("delegation depth enforcement", () => {
    const org = uid("org");
    const human = uid("human");
    const scope = uid("scope");
    const tool = uid("tool");
    const task = uid("task");
    let expires: string;

    const agents: string[] = [];
    for (let i = 0; i < 7; i++) {
      agents.push(uid(`depth_agent_${i}`));
    }

    beforeAll(async () => {
      expires = expiresIn(ONE_DAY);
      // Human → agent[0]
      await setupRoot({ orgId: org, humanId: human, agentId: agents[0], scopeId: scope, permissions: ["read"], expiresAt: expires });

      // Chain: agent[0] → agent[1] → ... → agent[4] (depth 5)
      for (let i = 0; i < 5; i++) {
        await setupInvocation({
          orgId: org,
          parentId: agents[i],
          childId: agents[i + 1],
          scopeId: scope,
          permissions: ["read"],
          expiresAt: expires,
        });
      }

      // Register tool on deepest valid agent
      await registerTool({ orgId: org, agentId: agents[5], toolId: tool, scopeId: scope });
    });

    it("authorizes agent at max depth", async () => {
      await waitForDecision(
        { orgId: org, taskId: task, agentId: agents[5], toolId: tool, scopeId: scope, actionType: "read" },
        "ALLOW",
        "max-depth agent ALLOW",
      );

      const result = await authorize({
        orgId: org, taskId: task, agentId: agents[5],
        toolId: tool, scopeId: scope, actionType: "read",
      });

      expect(result.status).toBe(200);
      expect(result.body.decision).toBe("ALLOW");
    });

    it("rejects delegation beyond max depth", async () => {
      const overflow = await emitEvent(org, "delegation.invoked", {
        parent_agent_id: agents[5],
        child_agent_id: agents[6],
        scope_id: scope,
        task_id: uid("task"),
        inherited_permissions: ["read"],
        expires_at: expiresIn(ONE_DAY),
        invocation_edge_id: freshEdgeId(),
      });

      expect(overflow.status).toBe(400);
      expect(overflow.body.error).toBe("DEPTH_EXCEEDED");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 8 — Lineage trace correctness
  //
  // 3-hop chain: Human → A → B → C.
  // Authorization query returns chain_path matching expected lineage.
  // ──────────────────────────────────────────────────────────────────────────
  describe("lineage trace correctness", () => {
    const org = uid("org");
    const human = uid("human");
    const scope = uid("scope");
    const agentA = uid("lineage_a");
    const agentB = uid("lineage_b");
    const agentC = uid("lineage_c");
    const tool = uid("tool");
    const task = uid("task");
    let expires: string;

    beforeAll(async () => {
      expires = expiresIn(ONE_DAY);
      await setupRoot({ orgId: org, humanId: human, agentId: agentA, scopeId: scope, permissions: ["read"], expiresAt: expires });
      await setupInvocation({ orgId: org, parentId: agentA, childId: agentB, scopeId: scope, permissions: ["read"], expiresAt: expires });
      await setupInvocation({ orgId: org, parentId: agentB, childId: agentC, scopeId: scope, permissions: ["read"], expiresAt: expires });
      await registerTool({ orgId: org, agentId: agentC, toolId: tool, scopeId: scope });

      await waitForDecision(
        { orgId: org, taskId: task, agentId: agentC, toolId: tool, scopeId: scope, actionType: "read" },
        "ALLOW",
        "lineage trace readiness",
      );
    });

    it("returns deterministic chain path in authorization response", async () => {
      const result = await authorize({
        orgId: org, taskId: task, agentId: agentC,
        toolId: tool, scopeId: scope, actionType: "read",
      });

      expect(result.status).toBe(200);
      expect(result.body.decision).toBe("ALLOW");

      const chainPath = result.body.chain_summary?.chain_path as string[];
      expect(chainPath).toBeDefined();
      // Chain path should contain the agent IDs in order
      expect(chainPath).toContain(agentA);
      expect(chainPath).toContain(agentB);
      expect(chainPath).toContain(agentC);
    });

    it("graph confirms exact authority lineage", async () => {
      await assertAuthorityLineage(agentC, [human, agentA, agentB, agentC]);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 9 — Expired ancestor invalidates descendant
  //
  // Human → A (short expiry) → B
  // After A's edge expires, B loses executable authority.
  // ──────────────────────────────────────────────────────────────────────────
  describe("expired ancestor invalidates descendant", () => {
    const org = uid("org");
    const human = uid("human");
    const scope = uid("scope");
    const agentA = uid("ancestor");
    const agentB = uid("descendant");
    const tool = uid("tool");
    const task = uid("task");

    let shortExpiry: string;

    beforeAll(async () => {
      shortExpiry = expiresIn(10_000); // 10-second expiry window
      await setupRoot({ orgId: org, humanId: human, agentId: agentA, scopeId: scope, expiresAt: shortExpiry, permissions: ["read"] });
      // Child must have expiry <= parent's expiry
      await setupInvocation({ orgId: org, parentId: agentA, childId: agentB, scopeId: scope, permissions: ["read"], expiresAt: shortExpiry });
      await registerTool({ orgId: org, agentId: agentB, toolId: tool, scopeId: scope });

      // Confirm B works while A is valid
      await waitForDecision(
        { orgId: org, taskId: task, agentId: agentB, toolId: tool, scopeId: scope, actionType: "read" },
        "ALLOW",
        "descendant pre-expiry ALLOW",
      );

      // Wait for A's edge to expire
      await new Promise((r) => setTimeout(r, 11_000));
    });

    it("descendant authorization fails after ancestor expiry", async () => {
      const result = await authorize({
        orgId: org, taskId: uid("task"), agentId: agentB,
        toolId: tool, scopeId: scope, actionType: "read",
      });

      expect(result.status).toBe(200);
      expect(result.body.decision).toBe("BLOCK");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 10 — Revoked mid-chain ancestor invalidates descendants
  //
  // Human → Planner → Worker
  // Revoke Planner's incoming edge.
  // Worker authorization MUST fail.
  // ──────────────────────────────────────────────────────────────────────────
  describe("revoked mid-chain ancestor invalidates descendants", () => {
    const org = uid("org");
    const human = uid("human");
    const scope = uid("scope");
    const planner = uid("planner");
    const worker = uid("worker");
    const tool = uid("tool");
    const task = uid("task");
    let expires: string;

    let plannerEdgeId: string;

    beforeAll(async () => {
      expires = expiresIn(ONE_DAY);
      const root = await setupRoot({ orgId: org, humanId: human, agentId: planner, scopeId: scope, expiresAt: expires });
      plannerEdgeId = root.edgeId;
      await setupInvocation({ orgId: org, parentId: planner, childId: worker, scopeId: scope, permissions: ["read", "execute"], expiresAt: expires });
      await registerTool({ orgId: org, agentId: worker, toolId: tool, scopeId: scope });

      // Confirm worker ALLOW
      await waitForDecision(
        { orgId: org, taskId: task, agentId: worker, toolId: tool, scopeId: scope, actionType: "read" },
        "ALLOW",
        "worker pre-revocation ALLOW",
      );

      // Revoke planner's edge (mid-chain)
      const revoke = await emitEvent(org, "delegation.revoked", {
        delegation_edge_id: plannerEdgeId,
        human_id: human,
        agent_id: planner,
        revocation_reason: "mid-chain revocation test",
        cascade_affected_agents: [planner, worker],
      });
      expect(revoke.status).toBe(200);

      await waitForEdgeStatus(plannerEdgeId, "REVOKED");
      await waitForNoActiveEdges(worker);
    });

    it("worker authorization fails after mid-chain revocation", async () => {
      const result = await authorize({
        orgId: org, taskId: uid("task"), agentId: worker,
        toolId: tool, scopeId: scope, actionType: "read",
      });

      expect(result.status).toBe(200);
      expect(result.body.decision).toBe("BLOCK");
    });

    it("graph confirms subtree fully revoked", async () => {
      await assertSubtreeFullyRevoked(planner);
    });

    it("graph has no split-brain authorities", async () => {
      await assertNoSplitBrainAuthorities();
    });
  });
});
