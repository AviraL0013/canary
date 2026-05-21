// Shared event envelope and discriminated union types

import type { Framework } from "./nodes.js";

export type DelegationEventType =
  | "delegation.created"
  | "delegation.invoked"
  | "tool.called"
  | "action.executed"
  | "delegation.expired"
  | "delegation.revoked"
  | "approval.requested"
  | "approval.granted"
  | "approval.denied";

// ─── Event Payloads ────────────────────────────────────────────────────────

export interface DelegationCreatedPayload {
  human_id: string;
  agent_id: string;
  scope_id: string;
  permissions: string[];
  expires_at: string;
  grant_reason: string;
  delegation_edge_id: string;
}

export interface DelegationInvokedPayload {
  parent_agent_id: string;
  child_agent_id: string;
  scope_id: string;
  task_id: string;
  expires_at: string;
  inherited_permissions: string[];
  invocation_edge_id: string;
}

export interface ToolCalledPayload {
  agent_id: string;
  tool_id: string;
  scope_id: string;
  parameters_hash: string;
  authorization_decision_id: string;
  called_edge_id: string;
}

export interface ActionExecutedPayload {
  tool_id: string;
  action_id: string;
  action_type: string;
  target_system: string;
  parameters_hash: string;
  outcome: "ALLOWED" | "BLOCKED" | "APPROVED" | "FAILED";
  reversible: boolean;
  executed_edge_id: string;
}

export interface DelegationExpiredPayload {
  delegation_edge_id: string;
  human_id: string;
  agent_id: string;
  scope_id: string;
  expired_at: string;
}

export interface DelegationRevokedPayload {
  delegation_edge_id: string;
  human_id: string;
  agent_id: string;
  revocation_reason: string;
  cascade_affected_agents: string[];
}

export interface ApprovalRequestedPayload {
  approval_request_id: string;
  decision_id: string;
  agent_id: string;
  tool_id: string;
  action_type: string;
  required_approvers: string[];
  scope_id: string;
  task_id: string;
}

export interface ApprovalGrantedPayload {
  approval_request_id: string;
  decision_id: string;
  approved_by: string;
  approval_reason: string;
  approved_at: string;
}

export interface ApprovalDeniedPayload {
  approval_request_id: string;
  decision_id: string;
  denied_by: string;
  denial_reason: string;
  denied_at: string;
}

export type EventPayload =
  | DelegationCreatedPayload
  | DelegationInvokedPayload
  | ToolCalledPayload
  | ActionExecutedPayload
  | DelegationExpiredPayload
  | DelegationRevokedPayload
  | ApprovalRequestedPayload
  | ApprovalGrantedPayload
  | ApprovalDeniedPayload;

// ─── Event Envelope ────────────────────────────────────────────────────────

export interface DelegationEvent {
  event_id: string;           // UUID v7 (time-ordered)
  event_type: DelegationEventType;
  spec_version: "1.0";
  org_id: string;
  sequence_id: number;        // monotonic per org
  timestamp: string;          // ISO 8601
  source_framework: Framework;
  idempotency_key: string;    // event_id for natural idempotency
  payload: EventPayload;
}

// ─── Typed event variants (discriminated union) ────────────────────────────

export interface DelegationCreatedEvent extends Omit<DelegationEvent, "event_type" | "payload"> {
  event_type: "delegation.created";
  payload: DelegationCreatedPayload;
}

export interface DelegationInvokedEvent extends Omit<DelegationEvent, "event_type" | "payload"> {
  event_type: "delegation.invoked";
  payload: DelegationInvokedPayload;
}

export interface ToolCalledEvent extends Omit<DelegationEvent, "event_type" | "payload"> {
  event_type: "tool.called";
  payload: ToolCalledPayload;
}

export interface ActionExecutedEvent extends Omit<DelegationEvent, "event_type" | "payload"> {
  event_type: "action.executed";
  payload: ActionExecutedPayload;
}

export interface DelegationExpiredEvent extends Omit<DelegationEvent, "event_type" | "payload"> {
  event_type: "delegation.expired";
  payload: DelegationExpiredPayload;
}

export interface DelegationRevokedEvent extends Omit<DelegationEvent, "event_type" | "payload"> {
  event_type: "delegation.revoked";
  payload: DelegationRevokedPayload;
}

export interface ApprovalRequestedEvent extends Omit<DelegationEvent, "event_type" | "payload"> {
  event_type: "approval.requested";
  payload: ApprovalRequestedPayload;
}

export interface ApprovalGrantedEvent extends Omit<DelegationEvent, "event_type" | "payload"> {
  event_type: "approval.granted";
  payload: ApprovalGrantedPayload;
}

export interface ApprovalDeniedEvent extends Omit<DelegationEvent, "event_type" | "payload"> {
  event_type: "approval.denied";
  payload: ApprovalDeniedPayload;
}

export type TypedDelegationEvent =
  | DelegationCreatedEvent
  | DelegationInvokedEvent
  | ToolCalledEvent
  | ActionExecutedEvent
  | DelegationExpiredEvent
  | DelegationRevokedEvent
  | ApprovalRequestedEvent
  | ApprovalGrantedEvent
  | ApprovalDeniedEvent;
