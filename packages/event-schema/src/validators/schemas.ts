import { z } from "zod";

// ─── Shared base schemas ─────────────────────────────────────────────────────

export const FrameworkSchema = z.enum([
  "LANGGRAPH",
  "CREWAI",
  "OPENAI_SDK",
  "AUTOGEN",
  "CUSTOM",
]);

export const RiskTierSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

export const ActionOutcomeSchema = z.enum([
  "ALLOWED",
  "BLOCKED",
  "APPROVED",
  "FAILED",
]);

export const DelegationEdgeStatusSchema = z.enum([
  "ACTIVE",
  "REVOKED",
  "EXPIRED",
]);

export const IsoDateSchema = z.string().datetime({ offset: true });

// ─── Payload schemas ─────────────────────────────────────────────────────────

export const DelegationCreatedPayloadSchema = z.object({
  human_id: z.string().min(1),
  agent_id: z.string().min(1),
  scope_id: z.string().min(1),
  permissions: z.array(z.string()),
  expires_at: IsoDateSchema,
  grant_reason: z.string().min(1),
  delegation_edge_id: z.string().min(1),
});

export const DelegationInvokedPayloadSchema = z.object({
  parent_agent_id: z.string().min(1),
  child_agent_id: z.string().min(1),
  scope_id: z.string().min(1),
  task_id: z.string().min(1),
  depth: z.number().int().nonnegative(),
  inherited_permissions: z.array(z.string()),
  invocation_edge_id: z.string().min(1),
});

export const ToolCalledPayloadSchema = z.object({
  agent_id: z.string().min(1),
  tool_id: z.string().min(1),
  scope_id: z.string().min(1),
  parameters_hash: z.string().min(1),
  authorization_decision_id: z.string().min(1),
  called_edge_id: z.string().min(1),
});

export const ActionExecutedPayloadSchema = z.object({
  tool_id: z.string().min(1),
  action_id: z.string().min(1),
  action_type: z.string().min(1),
  target_system: z.string().min(1),
  parameters_hash: z.string().min(1),
  outcome: ActionOutcomeSchema,
  reversible: z.boolean(),
  executed_edge_id: z.string().min(1),
});

export const DelegationExpiredPayloadSchema = z.object({
  delegation_edge_id: z.string().min(1),
  human_id: z.string().min(1),
  agent_id: z.string().min(1),
  scope_id: z.string().min(1),
  expired_at: IsoDateSchema,
});

export const DelegationRevokedPayloadSchema = z.object({
  delegation_edge_id: z.string().min(1),
  human_id: z.string().min(1),
  agent_id: z.string().min(1),
  revocation_reason: z.string().min(1),
  cascade_affected_agents: z.array(z.string()),
});

export const ApprovalRequestedPayloadSchema = z.object({
  approval_request_id: z.string().min(1),
  decision_id: z.string().min(1),
  agent_id: z.string().min(1),
  tool_id: z.string().min(1),
  action_type: z.string().min(1),
  required_approvers: z.array(z.string()).min(1),
  scope_id: z.string().min(1),
  task_id: z.string().min(1),
});

export const ApprovalGrantedPayloadSchema = z.object({
  approval_request_id: z.string().min(1),
  decision_id: z.string().min(1),
  approved_by: z.string().min(1),
  approval_reason: z.string().min(1),
  approved_at: IsoDateSchema,
});

export const ApprovalDeniedPayloadSchema = z.object({
  approval_request_id: z.string().min(1),
  decision_id: z.string().min(1),
  denied_by: z.string().min(1),
  denial_reason: z.string().min(1),
  denied_at: IsoDateSchema,
});

// ─── Event envelope base ──────────────────────────────────────────────────────

const EventEnvelopeBaseSchema = z.object({
  event_id: z.string().uuid(),
  spec_version: z.literal("1.0"),
  org_id: z.string().min(1),
  sequence_id: z.number().int().nonnegative(),
  timestamp: IsoDateSchema,
  source_framework: FrameworkSchema,
  idempotency_key: z.string().min(1),
});

// ─── Typed event schemas (discriminated union members) ────────────────────────

export const DelegationCreatedEventSchema = EventEnvelopeBaseSchema.extend({
  event_type: z.literal("delegation.created"),
  payload: DelegationCreatedPayloadSchema,
});

export const DelegationInvokedEventSchema = EventEnvelopeBaseSchema.extend({
  event_type: z.literal("delegation.invoked"),
  payload: DelegationInvokedPayloadSchema,
});

export const ToolCalledEventSchema = EventEnvelopeBaseSchema.extend({
  event_type: z.literal("tool.called"),
  payload: ToolCalledPayloadSchema,
});

export const ActionExecutedEventSchema = EventEnvelopeBaseSchema.extend({
  event_type: z.literal("action.executed"),
  payload: ActionExecutedPayloadSchema,
});

export const DelegationExpiredEventSchema = EventEnvelopeBaseSchema.extend({
  event_type: z.literal("delegation.expired"),
  payload: DelegationExpiredPayloadSchema,
});

export const DelegationRevokedEventSchema = EventEnvelopeBaseSchema.extend({
  event_type: z.literal("delegation.revoked"),
  payload: DelegationRevokedPayloadSchema,
});

export const ApprovalRequestedEventSchema = EventEnvelopeBaseSchema.extend({
  event_type: z.literal("approval.requested"),
  payload: ApprovalRequestedPayloadSchema,
});

export const ApprovalGrantedEventSchema = EventEnvelopeBaseSchema.extend({
  event_type: z.literal("approval.granted"),
  payload: ApprovalGrantedPayloadSchema,
});

export const ApprovalDeniedEventSchema = EventEnvelopeBaseSchema.extend({
  event_type: z.literal("approval.denied"),
  payload: ApprovalDeniedPayloadSchema,
});

// ─── Master discriminated union ────────────────────────────────────────────

export const DelegationEventSchema = z.discriminatedUnion("event_type", [
  DelegationCreatedEventSchema,
  DelegationInvokedEventSchema,
  ToolCalledEventSchema,
  ActionExecutedEventSchema,
  DelegationExpiredEventSchema,
  DelegationRevokedEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalGrantedEventSchema,
  ApprovalDeniedEventSchema,
]);

export type ValidatedDelegationEvent = z.infer<typeof DelegationEventSchema>;
export type ValidatedDelegationCreatedEvent = z.infer<typeof DelegationCreatedEventSchema>;
export type ValidatedDelegationRevokedEvent = z.infer<typeof DelegationRevokedEventSchema>;
export type ValidatedApprovalGrantedEvent = z.infer<typeof ApprovalGrantedEventSchema>;
export type ValidatedApprovalDeniedEvent = z.infer<typeof ApprovalDeniedEventSchema>;
