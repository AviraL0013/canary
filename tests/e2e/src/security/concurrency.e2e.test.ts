/**
 * CONCURRENCY / RACE CONDITION TESTS
 * ====================================
 * These tests verify the "single active authority source" invariant
 * holds under concurrent load — something sequential tests cannot catch.
 *
 * The core risk is a TOCTOU (Time-Of-Check, Time-Of-Use) race in
 * createInvocation():
 *
 *   Tx1: reads activeIncoming = 0  ✓
 *   Tx2: reads activeIncoming = 0  ✓   ← both pass the guard
 *   Tx1: CREATE edge, commits
 *   Tx2: CREATE edge, commits          ← child now has 2 ACTIVE edges — BUG
 *
 * Neo4j READ_COMMITTED isolation does NOT prevent this pattern.
 * Only a uniqueness constraint or an explicit write lock can.
 *
 * Tests in this file:
 *   1. Two parents race to claim the same child
 *   2. Fan-in pressure: 10 parents race for same child
 *   3. Same parent, N simultaneous invocations to same child
 *   4. Same event_id submitted concurrently (idempotency race)
 *   5. Concurrent revoke + delegation through the same parent
 *   6. Delegation into an already-being-revoked subtree
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
import { waitFor } from "../helpers/waitFor";

// ─── helpers ──────────────────────────────────────────────────────────────────

const INGESTION_URL =
  process.env["INGESTION_URL"] ?? "http://localhost:3001";

function uid(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function freshEdgeId() {
  return `edge_${randomUUID()}`;
}

function expiresInOneDay() {
  return new Date(Date.now() + 86_400_000).toISOString();
}

/**
 * Count ACTIVE incoming DELEGATED_TO edges for a given agent.
 * This is the ground-truth check for the single-authority invariant.
 */
async function activeIncomingCount(agentId: string): Promise<number> {
  const records = await queryNeo4j(
    `MATCH ()-[r:DELEGATED_TO {status:'ACTIVE'}]->(:Agent {id: $agentId})
     RETURN count(r) AS n`,
    { agentId },
  );
  return Number(records[0]?.get("n") ?? 0);
}

/**
 * Count total (any status) incoming DELEGATED_TO edges for an agent.
 * Useful to confirm rejected attempts were not persisted at all.
 */
async function totalIncomingCount(agentId: string): Promise<number> {
  const records = await queryNeo4j(
    `MATCH ()-[r:DELEGATED_TO]->(:Agent {id: $agentId})
     RETURN count(r) AS n`,
    { agentId },
  );
  return Number(records[0]?.get("n") ?? 0);
}

/**
 * Post a raw event envelope directly — bypasses the emitEvent() counter
 * so we can fire the exact same body N times (idempotency race tests).
 */
async function rawPost(
  body: object,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${INGESTION_URL}/v1/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/**
 * Establish a root Human→Agent delegation edge and wait until the
 * agent is reachable in the graph before returning.
 * This is setup scaffolding shared across test groups.
 */
async function setupRootDelegation(params: {
  orgId: string;
  humanId: string;
  agentId: string;
  scopeId: string;
  permissions?: string[];
  expiresAt?: string;
}): Promise<{ edgeId: string }> {
  const delegationEdgeId = freshEdgeId();
  const result = await emitEvent(params.orgId, "delegation.created", {
    human_id: params.humanId,
    agent_id: params.agentId,
    scope_id: params.scopeId,
    permissions: params.permissions ?? ["read", "write"],
    expires_at: params.expiresAt ?? expiresInOneDay(),
    grant_reason: "concurrency test setup",
    delegation_edge_id: delegationEdgeId,
  });

  expect(result.status, `root delegation setup failed: ${JSON.stringify(result.body)}`).toBe(200);

  // Wait for the agent node to appear in Neo4j before proceeding.
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

  return { edgeId: delegationEdgeId };
}

/**
 * Small settle pause after firing concurrent requests.
 * Since HTTP responses are only returned after Neo4j commits,
 * this is mostly belt-and-suspenders — but avoids rare timing edges
 * where responses arrived but replication lag hasn't fully settled.
 */
function settle(ms = 300) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ─── test suite ───────────────────────────────────────────────────────────────

describe("concurrency / race conditions", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 1 — Two parents race to claim the same child
  //
  // ParentA and ParentB are both valid, separately-delegated agents.
  // They both simultaneously invoke → the same ChildAgent.
  //
  // Expected (single-authority invariant):
  //   - Exactly ONE succeeds with HTTP 200
  //   - The other gets HTTP 400 MULTIPLE_ACTIVE_AUTHORITIES
  //   - Neo4j graph: child has exactly 1 ACTIVE incoming edge
  // ──────────────────────────────────────────────────────────────────────────
  describe("two parents race to claim the same child", () => {
    const org   = uid("org");
    const human = uid("human");
    const scope = uid("scope");
    const parentA = uid("parentA");
    const parentB = uid("parentB");
    const child   = uid("child");
    const expires = expiresInOneDay();

    beforeAll(async () => {
      // Give each parent their own root delegation from the same human.
      await setupRootDelegation({ orgId: org, humanId: human, agentId: parentA, scopeId: scope, expiresAt: expires });
      await setupRootDelegation({ orgId: org, humanId: human, agentId: parentB, scopeId: scope, expiresAt: expires });
    });

    it("allows exactly one delegation and rejects the other", async () => {
      // Fire both simultaneously.
      const [resultA, resultB] = await Promise.all([
        emitEvent(org, "delegation.invoked", {
          parent_agent_id: parentA,
          child_agent_id: child,
          scope_id: scope,
          task_id: uid("task"),
          inherited_permissions: ["read"],
          expires_at: expires,
          invocation_edge_id: freshEdgeId(),
        }),
        emitEvent(org, "delegation.invoked", {
          parent_agent_id: parentB,
          child_agent_id: child,
          scope_id: scope,
          task_id: uid("task"),
          inherited_permissions: ["read"],
          expires_at: expires,
          invocation_edge_id: freshEdgeId(),
        }),
      ]);

      await settle();

      const statuses = [resultA.status, resultB.status];
      const successCount = statuses.filter((s) => s === 200).length;
      const rejectedCount = statuses.filter((s) => s === 400).length;

      // Exactly one HTTP-level winner.
      expect(
        successCount,
        `Expected exactly 1 success but got: ${JSON.stringify(statuses)}`,
      ).toBe(1);

      expect(
        rejectedCount,
        `Expected exactly 1 rejection but got: ${JSON.stringify(statuses)}`,
      ).toBe(1);

      // The rejected response must carry the correct error code.
      const rejected = [resultA, resultB].find((r) => r.status === 400)!;
      expect(
        (rejected.body as Record<string, unknown>)["error"],
        "Rejection must be MULTIPLE_ACTIVE_AUTHORITIES",
      ).toBe("MULTIPLE_ACTIVE_AUTHORITIES");
    });

    it("leaves the child with exactly 1 ACTIVE incoming edge in Neo4j", async () => {
      const active = await activeIncomingCount(child);
      expect(
        active,
        `Graph invariant violated: child has ${active} ACTIVE incoming edges, expected 1`,
      ).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 2 — Fan-in pressure: 10 parents race for the same child
  //
  // A higher-concurrency version of scenario 1. This is the load that is
  // most likely to expose the TOCTOU gap in createInvocation().
  //
  // Expected:
  //   - Exactly 1 HTTP 200 across all 10 requests
  //   - Neo4j: child has exactly 1 ACTIVE incoming edge
  // ──────────────────────────────────────────────────────────────────────────
  describe("fan-in pressure: 10 parents race for the same child", () => {
    const PARENT_COUNT = 10;
    const org     = uid("org");
    const human   = uid("human");
    const scope   = uid("scope");
    const child   = uid("child");
    const expires = expiresInOneDay();
    const parents = Array.from({ length: PARENT_COUNT }, () => uid("p"));

    let results: Array<{ status: number; body: unknown }>;

    beforeAll(async () => {
      // Set up all parents in parallel — each is independently valid.
      await Promise.all(
        parents.map((agentId) =>
          setupRootDelegation({ orgId: org, humanId: human, agentId, scopeId: scope, expiresAt: expires }),
        ),
      );

      // Race all 10 parents to claim the same child.
      results = await Promise.all(
        parents.map((parentId) =>
          emitEvent(org, "delegation.invoked", {
            parent_agent_id: parentId,
            child_agent_id: child,
            scope_id: scope,
            task_id: uid("task"),
            inherited_permissions: ["read"],
            expires_at: expires,
            invocation_edge_id: freshEdgeId(),
          }),
        ),
      );

      await settle();
    });

    it("produces exactly 1 HTTP 200 across all concurrent requests", () => {
      const successCount = results.filter((r) => r.status === 200).length;
      expect(
        successCount,
        `Expected exactly 1 success across ${PARENT_COUNT} concurrent requests, got ${successCount}. ` +
        `Statuses: ${results.map((r) => r.status).join(", ")}`,
      ).toBe(1);
    });

    it("produces exactly N-1 HTTP 400 rejections", () => {
      const rejectedCount = results.filter((r) => r.status === 400).length;
      expect(rejectedCount).toBe(PARENT_COUNT - 1);
    });

    it("all rejections carry MULTIPLE_ACTIVE_AUTHORITIES error code", () => {
      const rejections = results.filter((r) => r.status === 400);
      for (const rej of rejections) {
        expect(
          (rej.body as Record<string, unknown>)["error"],
        ).toBe("MULTIPLE_ACTIVE_AUTHORITIES");
      }
    });

    it("leaves child with exactly 1 ACTIVE incoming edge in Neo4j", async () => {
      const active = await activeIncomingCount(child);
      expect(
        active,
        `Graph invariant violated after ${PARENT_COUNT}-way race: ` +
        `child has ${active} ACTIVE edges`,
      ).toBe(1);
    });

    it("does not persist rejected edges in the graph at all", async () => {
      const total = await totalIncomingCount(child);
      expect(
        total,
        `Rejected delegation edges must not be written to Neo4j — found ${total} total edges`,
      ).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 3 — Same parent, N simultaneous invocations to same child
  //
  // A single parent fires the same logical delegation multiple times at once
  // (e.g. network retry storm / duplicate event burst).  Each request carries
  // a different edge ID so the idempotency key does not help.
  //
  // Expected:
  //   - Exactly 1 ACTIVE edge on the child
  //   - Subsequent attempts fail (child already has an active incoming edge)
  // ──────────────────────────────────────────────────────────────────────────
  describe("same parent, N simultaneous invocations to same child", () => {
    const BURST_SIZE = 8;
    const org    = uid("org");
    const human  = uid("human");
    const scope  = uid("scope");
    const parent = uid("parent");
    const child  = uid("child");
    const expires = expiresInOneDay();

    let results: Array<{ status: number; body: unknown }>;

    beforeAll(async () => {
      await setupRootDelegation({ orgId: org, humanId: human, agentId: parent, scopeId: scope, expiresAt: expires });

      // Same parent → same child, BURST_SIZE times simultaneously.
      // Different edge IDs → NOT idempotent duplicates, genuinely concurrent.
      results = await Promise.all(
        Array.from({ length: BURST_SIZE }, () =>
          emitEvent(org, "delegation.invoked", {
            parent_agent_id: parent,
            child_agent_id: child,
            scope_id: scope,
            task_id: uid("task"),
            inherited_permissions: ["read"],
            expires_at: expires,
            invocation_edge_id: freshEdgeId(), // unique each time
          }),
        ),
      );

      await settle();
    });

    it("produces at most 1 HTTP 200 across the burst", () => {
      const successCount = results.filter((r) => r.status === 200).length;
      expect(
        successCount,
        `Burst of ${BURST_SIZE} produced ${successCount} successes — expected at most 1. ` +
        `Statuses: ${results.map((r) => r.status).join(", ")}`,
      ).toBeLessThanOrEqual(1);
    });

    it("leaves child with at most 1 ACTIVE incoming edge", async () => {
      const active = await activeIncomingCount(child);
      expect(
        active,
        `After ${BURST_SIZE}-way burst from same parent, child has ${active} ACTIVE edges`,
      ).toBeLessThanOrEqual(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 4 — Idempotency under concurrent submission
  //
  // The same event envelope (same event_id / idempotency_key) is submitted
  // N times simultaneously.  The ingestion layer must deduplicate such that
  // the underlying graph write executes at most once.
  //
  // Risk: the idempotency check is SELECT-then-INSERT in Postgres with no
  // advisory lock — two threads can both read "not exists" before either
  // commits, causing the delegation to be processed twice.
  //
  // Expected:
  //   - Exactly 1 response with status "ingested"
  //   - All others return status "duplicate"
  //   - The Neo4j graph reflects only one edge for the delegation
  // ──────────────────────────────────────────────────────────────────────────
  describe("idempotency under concurrent submission of the same event", () => {
    const CONCURRENT_COPIES = 10;
    const org    = uid("org");
    const human  = uid("human");
    const scope  = uid("scope");
    const agent  = uid("agent");
    const expires = expiresInOneDay();

    const sharedEventId  = randomUUID(); // same ID for all copies
    const sharedEdgeId   = freshEdgeId();

    let results: Array<{ status: number; body: Record<string, unknown> }>;

    beforeAll(async () => {
      // Build the envelope once — fire exact same bytes N times.
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
          expires_at: expires,
          grant_reason: "idempotency race test",
          delegation_edge_id: sharedEdgeId,
        },
      };

      results = await Promise.all(
        Array.from({ length: CONCURRENT_COPIES }, () => rawPost(envelope)),
      );

      await settle();
    });

    it("returns exactly 1 'ingested' across concurrent submissions", () => {
      const ingestedCount = results.filter(
        (r) => r.status === 200 && r.body["status"] === "ingested",
      ).length;
      expect(
        ingestedCount,
        `Expected exactly 1 'ingested' but got ${ingestedCount}. ` +
        `Statuses: ${results.map((r) => `${r.status}/${r.body["status"]}`).join(", ")}`,
      ).toBe(1);
    });

    it("returns the rest as 'duplicate'", () => {
      const duplicateCount = results.filter(
        (r) => r.status === 200 && r.body["status"] === "duplicate",
      ).length;
      expect(duplicateCount).toBe(CONCURRENT_COPIES - 1);
    });

    it("writes exactly 1 delegation edge to Neo4j", async () => {
      // Even if multiple HTTP requests sneaked past the idempotency guard,
      // the graph must not have duplicate edges.
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
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 5 — Concurrent revocation and delegation through the same parent
  //
  // While a revocation is being processed (and cascading), a new delegation
  // attempt is made through the target being-revoked parent.
  //
  // Two possible correct outcomes:
  //   A) Revocation wins → delegation fails with PARENT_AUTHORITY_INVALID
  //   B) Delegation wins → new child gets a valid edge, but the subsequent
  //      revocation cascade MUST reach it (no ghost authority)
  //
  // In both cases, after the dust settles:
  //   - newChild must have 0 ACTIVE incoming edges
  // ──────────────────────────────────────────────────────────────────────────
  describe("concurrent revoke + delegation through the same parent", () => {
    const org      = uid("org");
    const human    = uid("human");
    const scope    = uid("scope");
    const parent   = uid("parent");
    const newChild = uid("newChild");
    const expires  = expiresInOneDay();

    let rootEdgeId: string;

    beforeAll(async () => {
      // Establish: Human → Parent
      const setup = await setupRootDelegation({
        orgId: org, humanId: human, agentId: parent,
        scopeId: scope, expiresAt: expires,
      });
      rootEdgeId = setup.edgeId;
    });

    it("leaves newChild with 0 ACTIVE incoming edges after the race settles", async () => {
      // Fire revocation and new-child delegation at the same time.
      const [revokeResult, delegateResult] = await Promise.all([
        emitEvent(org, "delegation.revoked", {
          delegation_edge_id: rootEdgeId,
          human_id: human,
          agent_id: parent,
          revocation_reason: "concurrent-revoke-test",
          cascade_affected_agents: [parent],
        }),
        emitEvent(org, "delegation.invoked", {
          parent_agent_id: parent,
          child_agent_id: newChild,
          scope_id: scope,
          task_id: uid("task"),
          inherited_permissions: ["read"],
          expires_at: expires,
          invocation_edge_id: freshEdgeId(),
        }),
      ]);

      // Wait for convergence — the graph must settle to a consistent state.
      // If delegation succeeded but revocation hasn't cascaded yet, wait.
      await waitFor(
        async () => (await activeIncomingCount(newChild)) === 0,
        {
          timeoutMs: 15_000,
          intervalMs: 300,
          description: `newChild has 0 ACTIVE edges after revoke/delegate race`,
        },
      ).catch(() => {
        // Will be caught by the assertion below with a useful message.
      });

      const active = await activeIncomingCount(newChild);

      // Log the race outcome for debugging if test fails.
      const raceOutcome = {
        revokeStatus: revokeResult.status,
        delegateStatus: delegateResult.status,
        delegateError: (delegateResult.body as Record<string, unknown>)["error"],
        finalActiveEdges: active,
      };

      expect(
        active,
        `Ghost authority detected! newChild has ${active} ACTIVE edges after race. ` +
        `Race outcome: ${JSON.stringify(raceOutcome)}`,
      ).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SCENARIO 6 — Delegation into a subtree that is simultaneously being revoked
  //
  // A multi-hop chain: Human → Root → Mid → [concurrent race begins here]
  // The race fires simultaneously:
  //   - Revoke the Root edge (triggers cascade: Root, Mid both revoked)
  //   - Delegate Mid → Leaf (new invocation into the being-revoked subtree)
  //
  // Expected: after full convergence, Leaf has 0 ACTIVE incoming edges.
  // Either the delegation was rejected (Mid already revoked) OR the cascade
  // reached Leaf after it was briefly created.
  // ──────────────────────────────────────────────────────────────────────────
  describe("delegation into a subtree being concurrently revoked (cascade race)", () => {
    const org    = uid("org");
    const human  = uid("human");
    const scope  = uid("scope");
    const root   = uid("root");
    const mid    = uid("mid");
    const leaf   = uid("leaf");
    const expires = expiresInOneDay();

    let rootEdgeId: string;

    beforeAll(async () => {
      // Build: Human → Root
      const rootSetup = await setupRootDelegation({
        orgId: org, humanId: human, agentId: root,
        scopeId: scope, expiresAt: expires,
      });
      rootEdgeId = rootSetup.edgeId;

      // Then Root → Mid (sequential, must succeed before the race)
      const midResult = await emitEvent(org, "delegation.invoked", {
        parent_agent_id: root,
        child_agent_id: mid,
        scope_id: scope,
        task_id: uid("task"),
        inherited_permissions: ["read"],
        expires_at: expires,
        invocation_edge_id: freshEdgeId(),
      });
      expect(midResult.status, "mid-chain setup failed").toBe(200);

      // Confirm mid is reachable before starting the race.
      await waitFor(
        async () => (await activeIncomingCount(mid)) === 1,
        { timeoutMs: 10_000, intervalMs: 200, description: "mid has 1 ACTIVE edge before race" },
      );
    });

    it("leaf has 0 ACTIVE incoming edges after cascade race settles", async () => {
      // Trigger both simultaneously.
      await Promise.all([
        emitEvent(org, "delegation.revoked", {
          delegation_edge_id: rootEdgeId,
          human_id: human,
          agent_id: root,
          revocation_reason: "cascade-race-test",
          cascade_affected_agents: [root, mid],
        }),
        emitEvent(org, "delegation.invoked", {
          parent_agent_id: mid,
          child_agent_id: leaf,
          scope_id: scope,
          task_id: uid("task"),
          inherited_permissions: ["read"],
          expires_at: expires,
          invocation_edge_id: freshEdgeId(),
        }),
      ]);

      // Allow the cascade to propagate fully.
      await waitFor(
        async () => (await activeIncomingCount(leaf)) === 0,
        {
          timeoutMs: 20_000,
          intervalMs: 300,
          description: "leaf has 0 ACTIVE edges after cascade/delegation race",
        },
      ).catch(() => {
        // Caught by assertion below.
      });

      const active = await activeIncomingCount(leaf);
      expect(
        active,
        `Leaf retains ${active} ACTIVE incoming edge(s) after root revocation cascade. ` +
        `This is a ghost-authority violation — the cascade did not reach the leaf.`,
      ).toBe(0);
    });

    it("mid also has 0 ACTIVE incoming edges after cascade", async () => {
      const active = await activeIncomingCount(mid);
      expect(
        active,
        `Mid retains ${active} ACTIVE edge(s) after cascade — cascade did not fully propagate`,
      ).toBe(0);
    });
  });
});