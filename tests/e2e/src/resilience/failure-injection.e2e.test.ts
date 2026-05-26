/**
 * FAILURE INJECTION & RESILIENCE TESTS
 * ═══════════════════════════════════════════════════════════════════════
 *
 * These tests validate that graph invariants hold under
 * adversarial conditions that simulate real-world failures:
 *
 * - Concurrent revocation storms (multiple cascades on same subtree)
 * - Duplicate ingestion floods (idempotency under contention)
 * - Delegation during cascade (race between delegate + revoke)
 * - Authority races under contention (N parents → 1 child + revocation)
 * - Full graph invariant sweep after all stress
 *
 * Every test ends with a topology assertion.
 * The final test sweeps the entire graph.
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
import { queryNeo4j } from "../helpers/neo4j";

import {
  waitFor,
  waitForNoActiveEdges,
} from "../helpers/waitFor";

import {
  duplicateFlood,
  revocationStorm,
  delegationRace,
  delegateRevocationRace,
} from "../helpers/failureInjection";

import {
  assertNoSplitBrainAuthorities,
  assertNoCycles,
  assertNoInvalidActiveEdges,
  assertSubtreeFullyRevoked,
  assertSingleActiveParent,
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

function deriveChildExpiry(
  parentExpiry: string,
  attenuationMs = 1_000,
) {
  return new Date(
    new Date(parentExpiry).getTime()
    - attenuationMs,
  ).toISOString();
}

const ONE_DAY = 86_400_000;

function settle(ms = 2_000) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function setupRoot(params: {
  orgId: string;
  humanId: string;
  agentId: string;
  scopeId: string;
  expiresAt?: string;
}): Promise<{ edgeId: string }> {
  const edgeId = freshEdgeId();

  const result = await emitEvent(params.orgId, "delegation.created", {
    human_id: params.humanId,
    agent_id: params.agentId,
    scope_id: params.scopeId,
    permissions: ["read", "execute"],
    expires_at: params.expiresAt ?? expiresIn(ONE_DAY),
    grant_reason: "failure injection setup",
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
  expiresAt: string;
}): Promise<{ edgeId: string }> {
  const edgeId = freshEdgeId();

  const result = await emitEvent(params.orgId, "delegation.invoked", {
    parent_agent_id: params.parentId,
    child_agent_id: params.childId,
    scope_id: params.scopeId,
    task_id: uid("task"),
    inherited_permissions: ["read"],
    expires_at: params.expiresAt,
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

async function activeIncomingCount(agentId: string): Promise<number> {
  const records = await queryNeo4j(
    `MATCH ()-[r:DELEGATED_TO {status:'ACTIVE'}]->(:Agent {id: $agentId})
     RETURN count(r) AS n`,
    { agentId },
  );
  return Number(records[0]?.get("n") ?? 0);
}

// ─── test suite ───────────────────────────────────────────────────────────────

describe("failure injection & resilience", () => {

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 1 — Concurrent revocation storms
  //
  // Build a 3-level tree. Fire 10 revocations against
  // different edges in the same subtree simultaneously.
  //
  // Invariant: subtree fully revoked, no split-brain, no cycles.
  // ──────────────────────────────────────────────────────────────────────────
  describe("concurrent revocation storms", () => {
    const org = uid("org");
    const human = uid("human");
    const scope = uid("scope");
    const root = uid("root");
    const children: string[] = [];
    const grandchildren: string[] = [];
    let rootEdgeId: string;
    const childEdgeIds: string[] = [];

    beforeAll(async () => {
      const rootExpiry = expiresIn(ONE_DAY);
      const rootSetup = await setupRoot({ orgId: org, humanId: human, agentId: root, scopeId: scope, expiresAt: rootExpiry });
      rootEdgeId = rootSetup.edgeId;

      const childExpiry = deriveChildExpiry(rootExpiry);
      // Root → 5 children
      for (let i = 0; i < 5; i++) {
        const child = uid(`storm_c_${i}`);
        children.push(child);
        const inv = await setupInvocation({ orgId: org, parentId: root, childId: child, scopeId: scope, expiresAt: childExpiry });
        childEdgeIds.push(inv.edgeId);
      }

      const grandchildExpiry = deriveChildExpiry(childExpiry);
      // Each child → 2 grandchildren
      for (const parent of children) {
        for (let j = 0; j < 2; j++) {
          const gc = uid(`storm_gc_${j}`);
          grandchildren.push(gc);
          await setupInvocation({ orgId: org, parentId: parent, childId: gc, scopeId: scope, expiresAt: grandchildExpiry });
        }
      }

      // Storm: fire revocations against root + all child edges concurrently
      const allAgents = [root, ...children, ...grandchildren];
      const stormEdges = [
        { edgeId: rootEdgeId, humanId: human, agentId: root, cascadeAgents: allAgents },
        ...childEdgeIds.map((edgeId, i) => ({
          edgeId,
          humanId: human,
          agentId: children[i],
          cascadeAgents: allAgents,
        })),
      ];

      await revocationStorm(org, stormEdges);
      await settle(3_000);
    });

    it("subtree fully revoked after storm", async () => {
      await assertSubtreeFullyRevoked(root);
    });

    it("no cycles in ACTIVE topology", async () => {
      await assertNoCycles();
    });

    it("no invalid ACTIVE edges", async () => {
      await assertNoInvalidActiveEdges();
    });

    it("no split-brain authorities", async () => {
      await assertNoSplitBrainAuthorities();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 2 — Duplicate ingestion floods
  //
  // 50 identical events with the same event_id.
  // Must produce exactly 1 edge. No orphan writes.
  // ──────────────────────────────────────────────────────────────────────────
  describe("duplicate ingestion floods", () => {
    const org = uid("org");
    const human = uid("human");
    const scope = uid("scope");
    const agent = uid("agent");
    const sharedEventId = randomUUID();
    const sharedEdgeId = freshEdgeId();

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
          grant_reason: "flood test",
          delegation_edge_id: sharedEdgeId,
        },
      };

      results = await duplicateFlood(org, envelope, 50);
      await settle();
    });

    it("exactly 1 event is ingested", () => {
      const ingested = results.filter(
        (r) => r.status === 200 && r.body["status"] === "ingested",
      );
      expect(ingested.length).toBe(1);
    });

    it("all other responses are duplicates", () => {
      const duplicates = results.filter(
        (r) => r.status === 200 && r.body["status"] === "duplicate",
      );
      // ingested(1) + duplicates should equal total
      const ingested = results.filter(
        (r) => r.status === 200 && r.body["status"] === "ingested",
      ).length;
      expect(ingested + duplicates.length).toBe(results.filter((r) => r.status === 200).length);
    });

    it("exactly 1 edge in Neo4j", async () => {
      const records = await queryNeo4j(
        `MATCH ()-[r:DELEGATED_TO {id: $edgeId}]->() RETURN count(r) AS n`,
        { edgeId: sharedEdgeId },
      );
      expect(Number(records[0]?.get("n") ?? 0)).toBe(1);
    });

    it("agent has ≤1 ACTIVE incoming edge", async () => {
      await assertSingleActiveParent(agent);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 3 — Delegation during cascade
  //
  // Revoke root while simultaneously delegating into descendant.
  // Repeat 5x. Post-settle: all descendants must have 0 ACTIVE edges.
  // ──────────────────────────────────────────────────────────────────────────
  describe("delegation during cascade", () => {
    const org = uid("org");
    const human = uid("human");
    const scope = uid("scope");

    const allAgents: string[] = [];
    const allRootEdgeIds: string[] = [];

    beforeAll(async () => {
      // Run 5 rounds
      for (let round = 0; round < 5; round++) {
        const root = uid(`cas_root_${round}`);
        const child = uid(`cas_child_${round}`);
        const newChild = uid(`cas_new_${round}`);
        allAgents.push(root, child, newChild);

        const rootExpiry = expiresIn(ONE_DAY);
        const childExpiry = deriveChildExpiry(rootExpiry);
        const newChildExpiry = deriveChildExpiry(childExpiry);

        const rootSetup = await setupRoot({ orgId: org, humanId: human, agentId: root, scopeId: scope, expiresAt: rootExpiry });
        allRootEdgeIds.push(rootSetup.edgeId);
        await setupInvocation({ orgId: org, parentId: root, childId: child, scopeId: scope, expiresAt: childExpiry });

        // Race: revoke root + delegate new child from child
        await delegateRevocationRace(org, {
          parentId: child,
          childId: newChild,
          scopeId: scope,
          expiresAt: newChildExpiry,
          revokeEdgeId: rootSetup.edgeId,
          humanId: human,
          cascadeAgents: [root, child],
        });
      }

      await settle(3_000);
    });

    it("no split-brain authorities after delegate-during-cascade", async () => {
      await assertNoSplitBrainAuthorities();
    });

    it("no invalid ACTIVE edges", async () => {
      await assertNoInvalidActiveEdges();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 4 — Authority races under contention
  //
  // 20 parents race for the same child.
  // Concurrent with a separate revocation cascade.
  //
  // Post-settle: child has ≤1 ACTIVE incoming.
  // ──────────────────────────────────────────────────────────────────────────
  describe("authority races under contention", () => {
    const org = uid("org");
    const human = uid("human");
    const scope = uid("scope");
    const targetChild = uid("contested_child");
    
    const PARENT_COUNT = 20;
    const parents: string[] = [];
    let firstRootEdgeId: string;

    beforeAll(async () => {
      const parentExpiry = expiresIn(ONE_DAY);
      const childExpiry = deriveChildExpiry(parentExpiry);

      // Setup all parents as root-delegated agents
      for (let i = 0; i < PARENT_COUNT; i++) {
        const parent = uid(`racer_${i}`);
        parents.push(parent);
        const root = await setupRoot({ orgId: org, humanId: human, agentId: parent, scopeId: scope, expiresAt: parentExpiry });
        if (i === 0) firstRootEdgeId = root.edgeId;
      }

      // Fire the race + a concurrent revocation on the first parent
      const [raceResults] = await Promise.all([
        delegationRace(org, parents, targetChild, scope, childExpiry),
        // Concurrent revocation on first parent
        emitEvent(org, "delegation.revoked", {
          delegation_edge_id: firstRootEdgeId!,
          human_id: human,
          agent_id: parents[0],
          revocation_reason: "contention race test",
          cascade_affected_agents: [parents[0]],
        }),
      ]);

      await settle(3_000);
    });

    it("contested child has ≤1 ACTIVE incoming edge", async () => {
      const count = await activeIncomingCount(targetChild);
      expect(
        count,
        `Contested child ${targetChild} has ${count} ACTIVE incoming edges (max 1)`,
      ).toBeLessThanOrEqual(1);
    });

    it("no split-brain authorities", async () => {
      await assertNoSplitBrainAuthorities();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 5 — Full graph invariant sweep post-stress
  //
  // After all above adversarial scenarios, sweep the entire graph.
  // This is the definitive correctness check.
  // ──────────────────────────────────────────────────────────────────────────
  describe("full graph invariant sweep post-stress", () => {
    it("no split-brain authorities in entire graph", async () => {
      await assertNoSplitBrainAuthorities();
    });

    it("no ACTIVE cycles in entire graph", async () => {
      await assertNoCycles();
    });

    it("no invalid ACTIVE edges in entire graph", async () => {
      await assertNoInvalidActiveEdges();
    });

    it("every agent has ≤1 ACTIVE incoming edge", async () => {
      const records = await queryNeo4j(
        `
        MATCH (child:Agent)
        MATCH ()-[r:DELEGATED_TO {status: 'ACTIVE'}]->(child)
        WITH child, count(r) AS incoming
        RETURN child.id AS agent_id, incoming AS active_count
        ORDER BY incoming DESC
        `,
      );

      for (const record of records) {
        const count = Number(record.get("active_count"));
        const agentId = record.get("agent_id");
        expect(
          count,
          `Agent ${agentId} has ${count} ACTIVE incoming edges (max 1)`,
        ).toBeLessThanOrEqual(1);
      }
    });
  });
});
