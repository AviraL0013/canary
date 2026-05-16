// Canary SDK error types — explicit, never plain strings

import type { AuthorizationDecision } from "@canary/authorization-engine";

export class CanaryBlockedError extends Error {
  readonly decision: AuthorizationDecision;

  constructor(decision: AuthorizationDecision) {
    super(
      `Action blocked by Canary: ${decision.block_reason ?? "Policy violation"}`
    );
    this.name = "CanaryBlockedError";
    this.decision = decision;
  }
}

export class CanaryUnavailableError extends Error {
  readonly agent_id: string;
  readonly timestamp: string;

  constructor(agent_id: string) {
    super("Canary authorization service unavailable — fail-closed mode active");
    this.name = "CanaryUnavailableError";
    this.agent_id = agent_id;
    this.timestamp = new Date().toISOString();
  }
}

export class CanaryTimeoutError extends Error {
  readonly timeout_ms: number;

  constructor(timeout_ms: number) {
    super(`Canary authorization timed out after ${timeout_ms}ms`);
    this.name = "CanaryTimeoutError";
    this.timeout_ms = timeout_ms;
  }
}

export class CanaryApprovalPendingError extends Error {
  readonly approval_request_id: string;
  readonly required_approvers: string[];

  constructor(approval_request_id: string, required_approvers: string[]) {
    super(`Action requires approval: ${approval_request_id}`);
    this.name = "CanaryApprovalPendingError";
    this.approval_request_id = approval_request_id;
    this.required_approvers = required_approvers;
  }
}
