/**
 * Canary E2E Integration Test — The Product Demo
 *
 * This test IS the product demo. It runs against live docker-compose services.
 * It must pass on a clean `docker compose up`.
 *
 * 11-step scenario:
 *  1.  Create delegation: Human → Agent
 *  2.  Agent invokes Sub-Agent (depth=2)
 *  2b. Register CRITICAL tool node via sub-agent tool.called event
 *  3.  Sub-Agent calls a CRITICAL tool
 *  4.  Authorization returns REQUIRE_APPROVAL (POLICY_005)
 *  5.  Approval granted via audit service
 *  6.  Action executes successfully
 *  7.  Audit query returns data for org
 *  8.  Human revokes original delegation
 *  9.  Subsequent authorization returns BLOCK (POLICY_004)
 * 10.  Verify cache was invalidated (evaluation_source = "graph")
 * 11.  Health check verifies all 3 data stores
 */

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "crypto";

// ─── Config ──────────────────────────────────────────────────────────────

const INGESTION_URL      = process.env["INGESTION_URL"]      ?? "http://localhost:3001";
const AUTHORIZATION_URL  = process.env["AUTHORIZATION_URL"]  ?? "http://localhost:3002";
const AUDIT_URL          = process.env["AUDIT_URL"]          ?? "http://localhost:3003";

const TIMEOUT_MS = 120_000; // 2 min per test — Neo4j can be slow on first run

// ─── Test IDs ────────────────────────────────────────────────────────────

const ORG_ID             = `org_e2e_${randomUUID().slice(0, 8)}`;
const HUMAN_ID           = `human_${randomUUID().slice(0, 8)}`;
const AGENT_ID           = `agent_${randomUUID().slice(0, 8)}`;
const SUB_AGENT_ID       = `sub_${randomUUID().slice(0, 8)}`;
const TOOL_ID            = `tool_crit_${randomUUID().slice(0, 8)}`;
const SCOPE_ID           = `scope_${randomUUID().slice(0, 8)}`;
const TASK_ID            = `task_${randomUUID().slice(0, 8)}`;
const DELEGATION_EDGE_ID = `del_${randomUUID()}`;

let sequence = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────

async function emitEvent(
  eventType: string,
  payload: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown>; event_id: string }> {
  sequence++;
  const eventId = randomUUID();

  const event = {
    event_id:        eventId,
    event_type:      eventType,
    spec_version:    "1.0",
    org_id:          ORG_ID,
    sequence_id:     sequence,
    timestamp:       new Date().toISOString(),
    source_framework: "CUSTOM",
    idempotency_key: eventId,
    payload,
  };

  const res = await fetch(`${INGESTION_URL}/v1/events`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(event),
  });

  const body = await res.json() as Record<string, unknown>;
  return { status: res.status, body, event_id: eventId };
}

async function authorize(params: {
  agent_id:    string;
  tool_id:     string;
  action_type: string;
  scope_id:    string;
}): Promise<{ status: number; body: Record<string, unknown>; request_id: string }> {
  const requestId = randomUUID();

  const res = await fetch(`${AUTHORIZATION_URL}/v1/authorize`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id:           requestId,
      requesting_agent_id:  params.agent_id,
      tool_id:              params.tool_id,
      action_type:          params.action_type,
      scope_id:             params.scope_id,
      task_id:              TASK_ID,
      org_id:               ORG_ID,
      timestamp:            new Date().toISOString(),
      parameters_hash:      "e2e_test_hash",
    }),
  });

  return { status: res.status, body: await res.json() as Record<string, unknown>, request_id: requestId };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("Canary E2E — Full Authorization Lifecycle", { timeout: TIMEOUT_MS }, () => {

  // Wait for all services to be healthy before running any test
  beforeAll(async () => {
    let attempts = 0;
    while (attempts < 60) {
      try {
        const res = await fetch(`${AUTHORIZATION_URL}/v1/health`);
        if (res.ok) {
          const body = await res.json() as Record<string, unknown>;
          if (body["status"] === "healthy") break;
        }
      } catch {
        // not ready yet
      }
      attempts++;
      await sleep(2000);
    }

    if (attempts >= 60) {
      throw new Error("Services did not become healthy within 120 seconds");
    }
  }, TIMEOUT_MS);

  // ─── Step 11: Health ────────────────────────────────────────────────

  it("Step 11: Health check verifies all 3 data stores", async () => {
    const res  = await fetch(`${AUTHORIZATION_URL}/v1/health`);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body["status"]).toBe("healthy");
    expect(body["neo4j_ok"]).toBe(true);
    expect(body["redis_ok"]).toBe(true);
    expect(body["postgres_ok"]).toBe(true);
  });

  // ─── Step 1: Human → Agent delegation ──────────────────────────────

  it("Step 1: Create delegation Human → Agent", async () => {
    const result = await emitEvent("delegation.created", {
      human_id:            HUMAN_ID,
      agent_id:            AGENT_ID,
      scope_id:            SCOPE_ID,
      permissions:         ["read", "write", "execute", "admin"],
      expires_at:          new Date(Date.now() + 86_400_000).toISOString(),
      grant_reason:        "E2E test delegation",
      delegation_edge_id:  DELEGATION_EDGE_ID,
    });

    expect(result.status).toBe(200);
    expect(result.body["status"]).toBe("ingested");
  });

  // ─── Step 2: Agent → Sub-Agent invocation ──────────────────────────

  it("Step 2: Agent invokes Sub-Agent (depth=2)", async () => {
    await sleep(300);

    const result = await emitEvent("delegation.invoked", {
      parent_agent_id:      AGENT_ID,
      child_agent_id:       SUB_AGENT_ID,
      scope_id:             SCOPE_ID,
      task_id:              TASK_ID,
      depth:                2,
      inherited_permissions: ["read", "write", "execute"],
      invocation_edge_id:   `inv_${randomUUID()}`,
    });

    expect(result.status).toBe(200);
    expect(result.body["status"]).toBe("ingested");
  });

  // Step 2b: Register the CRITICAL tool node in the graph.
  // The tool.called event creates the Tool node via MERGE with risk_tier=CRITICAL.
  // This must happen BEFORE the authorization check so the evaluateAuthorization
  // query returns tool_risk_tier=CRITICAL, triggering POLICY_005.

  it("Step 2b: Register CRITICAL tool node via sub-agent", async () => {
    await sleep(300);

    const result = await emitEvent("tool.called", {
      agent_id:                    SUB_AGENT_ID,
      tool_id:                     TOOL_ID,
      scope_id:                    SCOPE_ID,
      parameters_hash:             "register_hash",
      authorization_decision_id:   "bootstrap",
      called_edge_id:              `call_${randomUUID()}`,
      tool_risk_tier:              "CRITICAL",   // ← sets Tool.risk_tier in graph
    });

    expect(result.status).toBe(200);
    expect(result.body["status"]).toBe("ingested");
  });

  // ─── Step 3-4: Authorize → REQUIRE_APPROVAL ────────────────────────

  it("Step 3-4: Sub-Agent calls CRITICAL tool → REQUIRE_APPROVAL (POLICY_005)", async () => {
    await sleep(500); // let graph settle

    const result = await authorize({
      agent_id:    SUB_AGENT_ID,
      tool_id:     TOOL_ID,
      action_type: "execute",
      scope_id:    SCOPE_ID,
    });

    expect(result.status).toBe(200);
    // POLICY_005: CRITICAL_TOOL_REQUIRE_APPROVAL
    // Chain is valid (depth=2, not revoked, not expired), so the only trigger
    // should be the CRITICAL tool → REQUIRE_APPROVAL
    expect(result.body["decision"]).toBe("REQUIRE_APPROVAL");

    const reasoning = result.body["reasoning"] as Record<string, unknown>;
    expect(reasoning).toBeDefined();
    expect(reasoning["chain_found"]).toBe(true);
    expect(reasoning["chain_unrevoked"]).toBe(true);

    const policyEvals = reasoning["policy_evaluations"] as Array<Record<string, unknown>>;
    expect(Array.isArray(policyEvals)).toBe(true);
    const policy005 = policyEvals.find(p => p["policy_id"] === "POLICY_005");
    if (policy005) {
      expect(policy005["outcome"]).toBe("REQUIRE_APPROVAL");
    }
  });

  // ─── Step 5-6: Approve and execute ─────────────────────────────────

  it("Step 5-6: Approval granted → action executes successfully", async () => {
    const approvalRequestId = `apr_${randomUUID()}`;
    const decisionId        = `dec_${randomUUID()}`;
    const actionId          = `action_${randomUUID()}`;

    // Emit approval.requested
    const reqResult = await emitEvent("approval.requested", {
      approval_request_id: approvalRequestId,
      decision_id:         decisionId,
      agent_id:            SUB_AGENT_ID,
      tool_id:             TOOL_ID,
      action_type:         "execute",
      required_approvers:  [HUMAN_ID],
      scope_id:            SCOPE_ID,
      task_id:             TASK_ID,
    });
    expect(reqResult.status).toBe(200);

    // Emit approval.granted
    const grantResult = await emitEvent("approval.granted", {
      approval_request_id: approvalRequestId,
      decision_id:         decisionId,
      approved_by:         HUMAN_ID,
      approval_reason:     "E2E test approval",
      approved_at:         new Date().toISOString(),
    });
    expect(grantResult.status).toBe(200);
    expect(grantResult.body["status"]).toBe("ingested");

    // Emit action.executed (simulating execution after approval)
    const actionResult = await emitEvent("action.executed", {
      tool_id:         TOOL_ID,
      action_id:       actionId,
      action_type:     "execute",
      target_system:   "e2e-test-system",
      parameters_hash: "e2e_action_hash",
      outcome:         "APPROVED",
      reversible:      true,
      executed_edge_id: `exec_${randomUUID()}`,
    });
    expect(actionResult.status).toBe(200);
    expect(actionResult.body["status"]).toBe("ingested");
  });

  // ─── Step 7: Audit query ────────────────────────────────────────────

  it("Step 7: Audit query returns data for org", async () => {
    await sleep(300);

    const params = new URLSearchParams({
      org_id:     ORG_ID,
      start_time: new Date(Date.now() - 3_600_000).toISOString(),
      end_time:   new Date(Date.now() + 3_600_000).toISOString(),
      page:       "1",
      limit:      "20",
    });

    const res  = await fetch(`${AUDIT_URL}/v1/audit?${params}`);
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toBeDefined();
    // Should have at least the audit events we emitted
    const total = body["total"] as number | undefined;
    if (total !== undefined) {
      expect(total).toBeGreaterThan(0);
    }
  });

  // ─── Step 8: Revoke delegation ──────────────────────────────────────

  it("Step 8: Human revokes original delegation", async () => {
    const result = await emitEvent("delegation.revoked", {
      delegation_edge_id:       DELEGATION_EDGE_ID,
      human_id:                 HUMAN_ID,
      agent_id:                 AGENT_ID,
      revocation_reason:        "E2E test revocation",
      cascade_affected_agents:  [AGENT_ID, SUB_AGENT_ID],
    });

    expect(result.status).toBe(200);
    expect(result.body["status"]).toBe("ingested");
  });

  // ─── Step 9-10: Post-revocation → BLOCK ────────────────────────────

  it("Step 9-10: Post-revocation authorization returns BLOCK (POLICY_004)", async () => {
    // Give the transitive revocation cascade time to complete
    // and for Redis cache to be invalidated
    await sleep(1000);

    const result = await authorize({
      agent_id:    SUB_AGENT_ID,
      tool_id:     TOOL_ID,
      action_type: "execute",
      scope_id:    SCOPE_ID,
    });

    expect(result.status).toBe(200);
    // After revocation POLICY_004 (REVOKED_DELEGATION_BLOCK) fires
    expect(result.body["decision"]).toBe("BLOCK");

    // Step 10: cache was invalidated — this request must have hit the graph
    // (cache was cleared by revocation cascade, so evaluation_source = "graph")
    expect(result.body["evaluation_source"]).toBe("graph");
  });

  // ─── Bonus: Idempotency ─────────────────────────────────────────────

  it("Idempotency: duplicate event returns status=duplicate", async () => {
    const eventId = randomUUID();
    const payload = {
      human_id:           `human_idem_${randomUUID().slice(0, 6)}`,
      agent_id:           `agent_idem_${randomUUID().slice(0, 6)}`,
      scope_id:           `scope_idem_${randomUUID().slice(0, 6)}`,
      permissions:        ["read"],
      expires_at:         new Date(Date.now() + 86_400_000).toISOString(),
      grant_reason:       "Idempotency test",
      delegation_edge_id: `del_idem_${randomUUID()}`,
    };

    const event = {
      event_id:         eventId,
      event_type:       "delegation.created",
      spec_version:     "1.0",
      org_id:           ORG_ID,
      sequence_id:      ++sequence,
      timestamp:        new Date().toISOString(),
      source_framework: "CUSTOM",
      idempotency_key:  eventId,
      payload,
    };

    const post = (body: unknown) =>
      fetch(`${INGESTION_URL}/v1/events`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });

    const res1 = await post(event);
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as Record<string, unknown>;
    expect(body1["status"]).toBe("ingested");

    const res2 = await post(event);
    expect(res2.status).toBe(200);
    const body2 = await res2.json() as Record<string, unknown>;
    expect(body2["status"]).toBe("duplicate");
  });

  // ─── Bonus: Validation ──────────────────────────────────────────────

  it("Validation: invalid event returns 400 with VALIDATION_ERROR", async () => {
    const res = await fetch(`${INGESTION_URL}/v1/events`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ event_id: "not-a-uuid", event_type: "bad.type", payload: {} }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body["error"]).toBe("VALIDATION_ERROR");
  });

  // ─── Bonus: Inventory ───────────────────────────────────────────────

  it("Inventory: lists agents for org", async () => {
    const params = new URLSearchParams({ org_id: ORG_ID });
    const res    = await fetch(`${AUDIT_URL}/v1/inventory/agents?${params}`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["agents"]).toBeDefined();
    expect(Array.isArray(body["agents"])).toBe(true);
  });

  it("Inventory: lists delegations for org", async () => {
    const params = new URLSearchParams({ org_id: ORG_ID });
    const res    = await fetch(`${AUDIT_URL}/v1/inventory/delegations?${params}`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["delegations"]).toBeDefined();
  });
});