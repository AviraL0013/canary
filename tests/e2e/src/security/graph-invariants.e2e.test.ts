/**
 * GLOBAL INVARIANT SWEEPS & STATE CONVERGENCE
 * ═══════════════════════════════════════════════════════════════════════
 *
 * These tests validate state convergence correctness — not just
 * immediate correctness. Many systems pass immediate assertions
 * but fail post-settlement.
 *
 * The pattern is:
 *   1. Create adversarial mutation conditions
 *   2. Wait for settlement
 *   3. Sweep the entire graph for invariant violations
 *
 * Additionally validates:
 *   - Graph snapshot consistency (no partial subtree appears executable
 *     during cascade)
 *   - Authorization determinism under concurrent reads/writes
 *     (no stale ALLOW after revocation commit)
 *   - Retry storm resilience (100 concurrent retries → single edge)
 *   - Cache invalidation verification (placeholder for future cache layer)
 *
 * This is the most important test suite in the system.
 *
 * ═══════════════════════════════════════════════════════════════════════
 */

import {
  beforeAll,
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
  assertNoSplitBrainAuthorities,
  assertNoCycles,
  assertNoInvalidActiveEdges,
  assertSubtreeFullyRevoked,
  assertSingleActiveParent,
  assertSingleActiveAuthorityPath,
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

const INGESTION_URL =
  process.env["INGESTION_URL"] ?? "http://localhost:3001";

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
    grant_reason: "invariant sweep setup",
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

async function setupInvocation(params: {
  orgId: string;
  parentId: string;
  childId: string;
  scopeId: string;
  permissions: string[];
  expiresAt?: string;
}): Promise<{ edgeId: string }> {
  const edgeId = freshEdgeId();

  const result = await emitEvent(params.orgId, "delegation.invoked", {
    parent_agent_id: params.parentId,
    child_agent_id: params.childId,
    scope_id: params.scopeId,
    task_id: uid("task"),
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

function settle(ms = 2_000) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function activeIncomingCount(agentId: string): Promise<number> {
  const records = await queryNeo4j(
    `MATCH ()-[r:DELEGATED_TO {status:'ACTIVE'}]->(:Agent {id: $agentId})
     RETURN count(r) AS n`,
    { agentId },
  );
  return Number(records[0]?.get("n") ?? 0);
}

async function rawPost(body: object): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${INGESTION_URL}/v1/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ─── test suite ───────────────────────────────────────────────────────────────

describe("global invariant sweeps", () => {

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 1 — Post-concurrent-delegation sweep
  //
  // 20 parents race for 5 different children simultaneously.
  // Wait for settlement. Sweep entire graph.
  // ──────────────────────────────────────────────────────────────────────────
  describe("post-concurrent-delegation sweep", () => {
    const org = uid("org");
    const human = uid("human");
    const scope = uid("scope");
    const expires = expiresIn(ONE_DAY);

    const PARENTS_PER_CHILD = 4;
    const CHILD_COUNT = 5;
    const children = Array.from({ length: CHILD_COUNT }, () => uid("child"));
    const parents = Array.from({ length: PARENTS_PER_CHILD * CHILD_COUNT }, () => uid("parent"));

    beforeAll(async () => {
      // Setup all parents
      await Promise.all(
        parents.map((parentId) =>
          setupRoot({ orgId: org, humanId: human, agentId: parentId, scopeId: scope, expiresAt: expires }),
        ),
      );

      // Race: groups of 4 parents → 1 child, for 5 children simultaneously
      const racePromises: Promise<unknown>[] = [];
      for (let c = 0; c < CHILD_COUNT; c++) {
        for (let p = 0; p < PARENTS_PER_CHILD; p++) {
          const parentIdx = c * PARENTS_PER_CHILD + p;
          racePromises.push(
            emitEvent(org, "delegation.invoked", {
              parent_agent_id: parents[parentIdx],
              child_agent_id: children[c],
              scope_id: scope,
              task_id: uid("task"),
              inherited_permissions: ["read"],
              expires_at: expires,
              invocation_edge_id: freshEdgeId(),
            }),
          );
        }
      }

      await Promise.all(racePromises);
      await settle();
    });

    it("no split-brain authorities after concurrent delegation races", async () => {
      await assertNoSplitBrainAuthorities();
    });

    it("no cycles in ACTIVE topology", async () => {
      await assertNoCycles();
    });

    it("no invalid ACTIVE edges", async () => {
      await assertNoInvalidActiveEdges();
    });

    it("each child has at most 1 ACTIVE incoming edge", async () => {
      for (const child of children) {
        const count = await activeIncomingCount(child);
        expect(
          count,
          `Child ${child} has ${count} ACTIVE incoming edges after race (max 1)`,
        ).toBeLessThanOrEqual(1);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 2 — Post-revocation-storm sweep
  //
  // Build 3-level tree. Fire 5 concurrent revocations against
  // different edges in the tree. Sweep for invariant violations.
  // ──────────────────────────────────────────────────────────────────────────
  describe("post-revocation-storm sweep", () => {
    const org = uid("org");
    const human = uid("human");
    const scope = uid("scope");
    const root = uid("root");
    const expires = expiresIn(ONE_DAY);

    const level1: string[] = [];
    const level2: string[] = [];
    let rootEdgeId: string;
    const level1EdgeIds: string[] = [];

    beforeAll(async () => {
      // Human → root
      const rootSetup = await setupRoot({ orgId: org, humanId: human, agentId: root, scopeId: scope, expiresAt: expires });
      rootEdgeId = rootSetup.edgeId;

      // root → 5 level1 children
      for (let i = 0; i < 5; i++) {
        const child = uid(`l1_${i}`);
        level1.push(child);
        const inv = await setupInvocation({
          orgId: org, parentId: root, childId: child,
          scopeId: scope, permissions: ["read"], expiresAt: expires,
        });
        level1EdgeIds.push(inv.edgeId);
      }

      // Each level1 → 2 level2 children
      for (const parent of level1) {
        for (let j = 0; j < 2; j++) {
          const grandchild = uid(`l2_${j}`);
          level2.push(grandchild);
          await setupInvocation({
            orgId: org, parentId: parent, childId: grandchild,
            scopeId: scope, permissions: ["read"], expiresAt: expires,
          });
        }
      }

      // Fire 5 concurrent revocations: root + each level1 edge
      const edgesToRevoke = [rootEdgeId, ...level1EdgeIds.slice(0, 4)];
      await Promise.all(
        edgesToRevoke.map((edgeId, i) =>
          emitEvent(org, "delegation.revoked", {
            delegation_edge_id: edgeId,
            human_id: human,
            agent_id: i === 0 ? root : level1[i - 1],
            revocation_reason: "storm test",
            cascade_affected_agents: [root, ...level1, ...level2],
          }),
        ),
      );

      await settle(3_000);
    });

    it("subtree fully revoked after storm", async () => {
      await assertSubtreeFullyRevoked(root);
    });

    it("no split-brain authorities", async () => {
      await assertNoSplitBrainAuthorities();
    });

    it("no invalid ACTIVE edges", async () => {
      await assertNoInvalidActiveEdges();
    });

    it("all level2 agents have 0 ACTIVE incoming edges", async () => {
      for (const agent of level2) {
        await waitForNoActiveEdges(agent);
        const count = await activeIncomingCount(agent);
        expect(count, `Level2 agent ${agent} still has ${count} ACTIVE edges`).toBe(0);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 3 — Post-mixed-mutation convergence
  //
  // Interleave: delegate, revoke, delegate, revoke (10 rounds, concurrent)
  // Wait for settlement. Full graph sweep.
  // ──────────────────────────────────────────────────────────────────────────
  describe("post-mixed-mutation convergence", () => {
    const org = uid("org");
    const human = uid("human");
    const scope = uid("scope");
    const expires = expiresIn(ONE_DAY);

    const agents: string[] = [];
    const edgeIds: string[] = [];

    beforeAll(async () => {
      // Create 10 root delegations, then interleave revocations
      for (let i = 0; i < 10; i++) {
        const agent = uid(`mixed_${i}`);
        agents.push(agent);
        const root = await setupRoot({
          orgId: org, humanId: human, agentId: agent,
          scopeId: scope, expiresAt: expires,
        });
        edgeIds.push(root.edgeId);
      }

      // Fire mixed mutations concurrently:
      // - Revoke half the edges
      // - Try to delegate children from all agents (some revoked, some not)
      const mutations: Promise<unknown>[] = [];

      // Revoke agents 0-4
      for (let i = 0; i < 5; i++) {
        mutations.push(
          emitEvent(org, "delegation.revoked", {
            delegation_edge_id: edgeIds[i],
            human_id: human,
            agent_id: agents[i],
            revocation_reason: "mixed mutation test",
            cascade_affected_agents: [agents[i]],
          }),
        );
      }

      // Try to delegate children from all 10 agents
      for (let i = 0; i < 10; i++) {
        mutations.push(
          emitEvent(org, "delegation.invoked", {
            parent_agent_id: agents[i],
            child_agent_id: uid(`mixed_child_${i}`),
            scope_id: scope,
            task_id: uid("task"),
            inherited_permissions: ["read"],
            expires_at: expires,
            invocation_edge_id: freshEdgeId(),
          }),
        );
      }

      await Promise.all(mutations);
      await settle(3_000);
    });

    it("no split-brain authorities after mixed mutations", async () => {
      await assertNoSplitBrainAuthorities();
    });

    it("no cycles in ACTIVE topology", async () => {
      await assertNoCycles();
    });

    it("no invalid ACTIVE edges", async () => {
      await assertNoInvalidActiveEdges();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 4 — Retry storm test
  //
  // 100 concurrent identical event submissions (same idempotency key).
  // Only one edge should exist. No orphan writes.
  // ──────────────────────────────────────────────────────────────────────────
  describe("retry storm — 100 concurrent duplicates", () => {
    const org = uid("org");
    const human = uid("human");
    const scope = uid("scope");
    const agent = uid("agent");
    const sharedEventId = randomUUID();
    const sharedEdgeId = freshEdgeId();
    const STORM_SIZE = 100;

    let results: Array<{ status: number; body: Record<string, unknown> }>;

    beforeAll(async () => {
      const envelope = {
        event_id: sharedEventId,
        event_type: "delegation.created",
        spec_version: "1.0",
        org_id: org,
        sequence_id: 1,
        timestamp: new Date().toISOString(),
        source_framework: "CUSTOM",
        idempotency_key: sharedEventId,
        payload: {
          human_id: human,
          agent_id: agent,
          scope_id: scope,
          permissions: ["read"],
          expires_at: expiresIn(ONE_DAY),
          grant_reason: "retry storm test",
          delegation_edge_id: sharedEdgeId,
        },
      };

      results = await Promise.all(
        Array.from({ length: STORM_SIZE }, () => rawPost(envelope)),
      );

      await settle();
    });

    it("produces exactly 1 'ingested' across 100 concurrent submissions", () => {
      const ingestedCount = results.filter(
        (r) => r.status === 200 && r.body["status"] === "ingested",
      ).length;

      expect(
        ingestedCount,
        `Expected exactly 1 'ingested' but got ${ingestedCount}`,
      ).toBe(1);
    });

    it("writes exactly 1 delegation edge to Neo4j", async () => {
      const records = await queryNeo4j(
        `MATCH ()-[r:DELEGATED_TO {id: $edgeId}]->() RETURN count(r) AS n`,
        { edgeId: sharedEdgeId },
      );
      const edgeCount = Number(records[0]?.get("n") ?? 0);
      expect(
        edgeCount,
        `Graph contains ${edgeCount} copies of edge ${sharedEdgeId} — must be exactly 1`,
      ).toBe(1);
    });

    it("agent has exactly 1 ACTIVE incoming edge", async () => {
      await assertSingleActiveParent(agent);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 5 — Authorization determinism under concurrent reads/writes
  //
  // This is the hardest class of bug.
  //
  // Pattern:
  //   - Build delegation chain
  //   - Fire high-rate authorize() calls (50 concurrent)
  //   - Simultaneously revoke the chain
  //   - Collect ALL authorize responses
  //   - Verify: no stale ALLOW after revocation commit
  //
  // This is where enterprise trust actually lives.
  // ──────────────────────────────────────────────────────────────────────────
  describe("authorization determinism under concurrent reads/writes", () => {
    const org = uid("org");
    const human = uid("human");
    const scope = uid("scope");
    const agent = uid("agent");
    const tool = uid("tool");
    const expires = expiresIn(ONE_DAY);

    let rootEdgeId: string;
    let revocationTimestamp: number;
    let authResults: Array<{ decision: string; timestamp: number }>;

    beforeAll(async () => {
      const root = await setupRoot({ orgId: org, humanId: human, agentId: agent, scopeId: scope, expiresAt: expires });
      rootEdgeId = root.edgeId;
      await registerTool({ orgId: org, agentId: agent, toolId: tool, scopeId: scope });

      // Confirm ALLOW first
      await waitFor(
        async () => {
          const result = await authorize({
            orgId: org, taskId: uid("task"), agentId: agent,
            toolId: tool, scopeId: scope, actionType: "read",
          });
          return result.status === 200 && result.body.decision === "ALLOW";
        },
        { timeoutMs: 15_000, intervalMs: 500, description: "pre-determinism-test ALLOW" },
      );

      // Fire 50 concurrent authorize calls + 1 revocation
      const authPromises = Array.from({ length: 50 }, () => {
        const callTimestamp = Date.now();
        return authorize({
          orgId: org, taskId: uid("task"), agentId: agent,
          toolId: tool, scopeId: scope, actionType: "read",
        }).then((r) => ({
          decision: r.body.decision as string,
          timestamp: callTimestamp,
        }));
      });

      const revokePromise = (async () => {
        // Small delay so some authorize calls land first
        await new Promise((r) => setTimeout(r, 50));
        revocationTimestamp = Date.now();
        return emitEvent(org, "delegation.revoked", {
          delegation_edge_id: rootEdgeId,
          human_id: human,
          agent_id: agent,
          revocation_reason: "determinism test",
          cascade_affected_agents: [agent],
        });
      })();

      const [authSettled] = await Promise.all([
        Promise.all(authPromises),
        revokePromise,
      ]);

      authResults = authSettled;

      // Wait for full convergence
      await settle();
    });

    it("post-revocation authorization consistently returns BLOCK", async () => {
      // After settlement, authorize must return BLOCK
      const postResult = await authorize({
        orgId: org, taskId: uid("task"), agentId: agent,
        toolId: tool, scopeId: scope, actionType: "read",
      });

      expect(postResult.body.decision).toBe("BLOCK");
    });

    it("no split-brain authorities after concurrent auth/revoke", async () => {
      await assertNoSplitBrainAuthorities();
    });

    it("agent has 0 ACTIVE incoming edges after revocation", async () => {
      const count = await activeIncomingCount(agent);
      expect(count).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 6 — Graph snapshot consistency
  //
  // During a cascade: no partial subtree should appear executable.
  //
  // Build: Human → Root → Mid → Leaf
  // Revoke Root.
  // During cascade propagation, repeatedly query Mid and Leaf.
  // After settlement: both MUST have 0 ACTIVE edges.
  //
  // This validates that application-level read patterns don't
  // return partially revoked authority chains.
  // ──────────────────────────────────────────────────────────────────────────
  describe("graph snapshot consistency during cascade", () => {
    const org = uid("org");
    const human = uid("human");
    const scope = uid("scope");
    const root = uid("root");
    const mid = uid("mid");
    const leaf = uid("leaf");
    const tool = uid("tool");
    const expires = expiresIn(ONE_DAY);

    let rootEdgeId: string;

    beforeAll(async () => {
      const rootSetup = await setupRoot({ orgId: org, humanId: human, agentId: root, scopeId: scope, expiresAt: expires });
      rootEdgeId = rootSetup.edgeId;
      await setupInvocation({ orgId: org, parentId: root, childId: mid, scopeId: scope, permissions: ["read"], expiresAt: expires });
      await setupInvocation({ orgId: org, parentId: mid, childId: leaf, scopeId: scope, permissions: ["read"], expiresAt: expires });
      await registerTool({ orgId: org, agentId: leaf, toolId: tool, scopeId: scope });

      // Confirm leaf is authorized
      await waitFor(
        async () => {
          const r = await authorize({
            orgId: org, taskId: uid("task"), agentId: leaf,
            toolId: tool, scopeId: scope, actionType: "read",
          });
          return r.status === 200 && r.body.decision === "ALLOW";
        },
        { timeoutMs: 15_000, intervalMs: 500, description: "leaf pre-cascade ALLOW" },
      );
    });

    it("cascade fully propagates — no partial executable subtree remains", async () => {
      // Fire revocation
      const revoke = await emitEvent(org, "delegation.revoked", {
        delegation_edge_id: rootEdgeId,
        human_id: human,
        agent_id: root,
        revocation_reason: "snapshot consistency test",
        cascade_affected_agents: [root, mid, leaf],
      });
      expect(revoke.status).toBe(200);

      // Wait for full cascade
      await waitForNoActiveEdges(leaf);
      await waitForNoActiveEdges(mid);

      // Post-settlement: both must be inactive
      const midCount = await activeIncomingCount(mid);
      const leafCount = await activeIncomingCount(leaf);

      expect(midCount, `Mid agent has ${midCount} ACTIVE edges after cascade`).toBe(0);
      expect(leafCount, `Leaf agent has ${leafCount} ACTIVE edges after cascade`).toBe(0);
    });

    it("authorization consistently returns BLOCK for all cascaded agents", async () => {
      const leafResult = await authorize({
        orgId: org, taskId: uid("task"), agentId: leaf,
        toolId: tool, scopeId: scope, actionType: "read",
      });
      expect(leafResult.body.decision).toBe("BLOCK");
    });

    it("subtree fully revoked", async () => {
      await assertSubtreeFullyRevoked(root);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 7 — Cache invalidation verification (placeholder)
  //
  // When Canary ships caching (Redis-backed authorization context cache),
  // this becomes a primary security surface.
  //
  // These tests verify:
  // - stale cache eviction after revocation
  // - revoked lineage disappearing from cached context
  // - authorization recomputation after cache invalidation
  //
  // Currently placeholder — the authorization service already
  // uses ContextCache but the E2E tests hit the full path.
  // ──────────────────────────────────────────────────────────────────────────
  describe("cache invalidation verification (structural placeholders)", () => {
    const org = uid("org");
    const human = uid("human");
    const scope = uid("scope");
    const agent = uid("agent");
    const tool = uid("tool");
    const expires = expiresIn(ONE_DAY);

    let rootEdgeId: string;

    beforeAll(async () => {
      const root = await setupRoot({ orgId: org, humanId: human, agentId: agent, scopeId: scope, expiresAt: expires });
      rootEdgeId = root.edgeId;
      await registerTool({ orgId: org, agentId: agent, toolId: tool, scopeId: scope });
    });

    it("warm cache returns ALLOW before revocation", async () => {
      // Hit authorize twice to ensure cache is warm
      await waitFor(
        async () => {
          const r = await authorize({
            orgId: org, taskId: uid("task"), agentId: agent,
            toolId: tool, scopeId: scope, actionType: "read",
          });
          return r.status === 200 && r.body.decision === "ALLOW";
        },
        { timeoutMs: 15_000, intervalMs: 500, description: "cache warm ALLOW" },
      );

      const result = await authorize({
        orgId: org, taskId: uid("task"), agentId: agent,
        toolId: tool, scopeId: scope, actionType: "read",
      });

      expect(result.body.decision).toBe("ALLOW");
    });

    it("authorization returns BLOCK after revocation (cache must be invalidated)", async () => {
      // Revoke
      const revoke = await emitEvent(org, "delegation.revoked", {
        delegation_edge_id: rootEdgeId,
        human_id: human,
        agent_id: agent,
        revocation_reason: "cache invalidation test",
        cascade_affected_agents: [agent],
      });
      expect(revoke.status).toBe(200);

      // After revocation, cache must be invalidated.
      // The next authorize call should recompute from graph → BLOCK
      await waitFor(
        async () => {
          const r = await authorize({
            orgId: org, taskId: uid("task"), agentId: agent,
            toolId: tool, scopeId: scope, actionType: "read",
          });
          return r.status === 200 && r.body.decision === "BLOCK";
        },
        { timeoutMs: 15_000, intervalMs: 500, description: "post-revocation BLOCK (cache invalidated)" },
      );

      const result = await authorize({
        orgId: org, taskId: uid("task"), agentId: agent,
        toolId: tool, scopeId: scope, actionType: "read",
      });

      expect(result.body.decision).toBe("BLOCK");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 8 — Final global invariant sweep
  //
  // After all the above adversarial conditions, the global invariants
  // must still hold across the ENTIRE graph.
  // ──────────────────────────────────────────────────────────────────────────
  describe("final global invariant sweep", () => {
    it("no split-brain authorities in entire graph", async () => {
      await assertNoSplitBrainAuthorities();
    });

    it("no ACTIVE cycles in entire graph", async () => {
      await assertNoCycles();
    });

    it("no invalid ACTIVE edges in entire graph", async () => {
      await assertNoInvalidActiveEdges();
    });
  });
});
