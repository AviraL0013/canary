// CanarySDK — primary interface for agent frameworks
// Wraps tool calls with authorization, event emission, and fail modes.

import { randomUUID } from "node:crypto";
import type { AuthorizationDecision } from "@canary/authorization-engine";
import { CanaryBlockedError, CanaryUnavailableError, CanaryTimeoutError } from "./errors.js";

export interface CanarySDKConfig {
  org_id: string;
  agent_id: string;
  api_key: string;
  ingestion_url: string;     // e.g. http://localhost:3001
  authorization_url: string; // e.g. http://localhost:3002
  fail_mode: "CLOSED" | "OPEN"; // default: CLOSED
  timeout_ms: number;           // default: 100ms
}

interface AuthorizeAndExecuteParams<T> {
  tool_id: string;
  action_type: string;
  scope_id: string;
  task_id: string;
  parameters_hash: string;
  execute: () => Promise<T>;
}

export class CanarySDK {
  private readonly config: CanarySDKConfig;
  private sequence_id: number = 0;

  constructor(config: Partial<CanarySDKConfig> & { org_id: string; agent_id: string }) {
    this.config = {
      api_key: config.api_key ?? "",
      ingestion_url: config.ingestion_url ?? "http://localhost:3001",
      authorization_url: config.authorization_url ?? "http://localhost:3002",
      fail_mode: config.fail_mode ?? "CLOSED",
      timeout_ms: config.timeout_ms ?? 100,
      org_id: config.org_id,
      agent_id: config.agent_id,
    };
  }

  /**
   * Primary interface — authorize and execute a tool call.
   *
   * 1. POST /v1/authorize
   * 2. ALLOW → execute(), emit tool.called + action.executed
   * 3. BLOCK → throw CanaryBlockedError
   * 4. REQUIRE_APPROVAL → throw CanaryApprovalPendingError
   * 5. Unavailable + CLOSED → throw CanaryUnavailableError
   * 6. Unavailable + OPEN → execute() with degraded_mode logged
   */
  async authorizeAndExecute<T>(
    params: AuthorizeAndExecuteParams<T>
  ): Promise<T> {
    const requestId = randomUUID();

    let decision: AuthorizationDecision;
    try {
      decision = await this.authorize({
        request_id: requestId,
        requesting_agent_id: this.config.agent_id,
        tool_id: params.tool_id,
        action_type: params.action_type,
        scope_id: params.scope_id,
        task_id: params.task_id,
        org_id: this.config.org_id,
        timestamp: new Date().toISOString(),
        parameters_hash: params.parameters_hash,
      });
    } catch (err) {
      // Authorization service unavailable
      if (this.config.fail_mode === "CLOSED") {
        throw new CanaryUnavailableError(this.config.agent_id);
      }

      // Fail-open: execute with degraded mode
      await this.emitEvent("tool.called", {
        agent_id: this.config.agent_id,
        tool_id: params.tool_id,
        scope_id: params.scope_id,
        parameters_hash: params.parameters_hash,
        authorization_decision_id: "DEGRADED_MODE",
        called_edge_id: `call_degraded_${requestId}`,
      });

      const result = await params.execute();

      await this.emitEvent("action.executed", {
        tool_id: params.tool_id,
        action_id: `action_${requestId}`,
        action_type: params.action_type,
        target_system: params.tool_id,
        parameters_hash: params.parameters_hash,
        outcome: "ALLOWED",
        reversible: true,
        executed_edge_id: `exec_degraded_${requestId}`,
      });

      return result;
    }

    // Handle decision
    switch (decision.decision) {
      case "ALLOW": {
        // Emit tool.called
        await this.emitEvent("tool.called", {
          agent_id: this.config.agent_id,
          tool_id: params.tool_id,
          scope_id: params.scope_id,
          parameters_hash: params.parameters_hash,
          authorization_decision_id: decision.decision_id,
          called_edge_id: `call_${requestId}`,
        });

        // Execute the action
        const result = await params.execute();

        // Emit action.executed
        await this.emitEvent("action.executed", {
          tool_id: params.tool_id,
          action_id: `action_${requestId}`,
          action_type: params.action_type,
          target_system: params.tool_id,
          parameters_hash: params.parameters_hash,
          outcome: "ALLOWED",
          reversible: true,
          executed_edge_id: `exec_${requestId}`,
        });

        return result;
      }

      case "BLOCK":
        throw new CanaryBlockedError(decision);

      case "REQUIRE_APPROVAL": {
        // Emit approval.requested event
        const approvalRequestId = `apr_${requestId}`;
        await this.emitEvent("approval.requested", {
          approval_request_id: approvalRequestId,
          decision_id: decision.decision_id,
          agent_id: this.config.agent_id,
          tool_id: params.tool_id,
          action_type: params.action_type,
          required_approvers: decision.approval_required_from ?? [],
          scope_id: params.scope_id,
          task_id: params.task_id,
        });

        // Return the decision with approval info for caller to handle
        const blockedDecision: AuthorizationDecision = {
          ...decision,
          approval_request_id: approvalRequestId,
        };
        throw new CanaryBlockedError(blockedDecision);
      }

      default: {
        // Exhaustive check — should never reach here
        const _exhaustive: never = decision.decision;
        throw new Error(`Unexpected decision: ${_exhaustive}`);
      }
    }
  }

  // ─── Event emission ─────────────────────────────────────────────────

  async emitEvent(
    event_type: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    this.sequence_id++;
    const eventId = randomUUID();

    const event = {
      event_id: eventId,
      event_type,
      spec_version: "1.0",
      org_id: this.config.org_id,
      sequence_id: this.sequence_id,
      timestamp: new Date().toISOString(),
      source_framework: "CUSTOM",
      idempotency_key: eventId,
      payload,
    };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.config.timeout_ms * 2 // Give ingestion more time than auth
      );

      await fetch(`${this.config.ingestion_url}/v1/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.api_key
            ? { Authorization: `Bearer ${this.config.api_key}` }
            : {}),
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });

      clearTimeout(timeout);
    } catch {
      // Event emission failure is logged but doesn't block execution
      // Events can be retried or reconciled
    }
  }

  // ─── Authorization request ──────────────────────────────────────────

  private async authorize(
    request: Record<string, unknown>
  ): Promise<AuthorizationDecision> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeout_ms
    );

    try {
      const response = await fetch(
        `${this.config.authorization_url}/v1/authorize`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.config.api_key
              ? { Authorization: `Bearer ${this.config.api_key}` }
              : {}),
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        }
      );

      clearTimeout(timeout);

      if (!response.ok) {
        throw new CanaryUnavailableError(this.config.agent_id);
      }

      return (await response.json()) as AuthorizationDecision;
    } catch (err: unknown) {
      clearTimeout(timeout);
      if (err instanceof CanaryUnavailableError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new CanaryTimeoutError(this.config.timeout_ms);
      }
      throw new CanaryUnavailableError(this.config.agent_id);
    }
  }

  // ─── Delegation event helpers ──────────────────────────────────────

  async createDelegation(params: {
    human_id: string;
    agent_id: string;
    scope_id: string;
    permissions: string[];
    expires_at: string;
    grant_reason: string;
  }): Promise<void> {
    const delegationEdgeId = `del_${randomUUID()}`;
    await this.emitEvent("delegation.created", {
      human_id: params.human_id,
      agent_id: params.agent_id,
      scope_id: params.scope_id,
      permissions: params.permissions,
      expires_at: params.expires_at,
      grant_reason: params.grant_reason,
      delegation_edge_id: delegationEdgeId,
    });
  }

  async invokeAgent(params: {
    parent_agent_id: string;
    child_agent_id: string;
    scope_id: string;
    task_id: string;
    depth: number;
    inherited_permissions: string[];
  }): Promise<void> {
    const invocationEdgeId = `inv_${randomUUID()}`;
    await this.emitEvent("delegation.invoked", {
      parent_agent_id: params.parent_agent_id,
      child_agent_id: params.child_agent_id,
      scope_id: params.scope_id,
      task_id: params.task_id,
      depth: params.depth,
      inherited_permissions: params.inherited_permissions,
      invocation_edge_id: invocationEdgeId,
    });
  }

  async revokeDelegation(params: {
    delegation_edge_id: string;
    human_id: string;
    agent_id: string;
    revocation_reason: string;
  }): Promise<void> {
    await this.emitEvent("delegation.revoked", {
      delegation_edge_id: params.delegation_edge_id,
      human_id: params.human_id,
      agent_id: params.agent_id,
      revocation_reason: params.revocation_reason,
      cascade_affected_agents: [],
    });
  }
}
