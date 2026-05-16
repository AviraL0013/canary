// DelegationGraphRepository — abstract interface
// All graph operations go through this interface.
// Neo4j is the V1 implementation. The interface outlives any specific backend.

import type {
  ActionTraceResult,
  AuthorizationContext,
  AuthorizationEvaluationResult,
  AuditQueryResult,
  RevocationCascadeResult,
  AgentInventoryRecord,
  DelegationTreeRecord,
} from "../types/results.js";

export interface CreateDelegationParams {
  human_id: string;
  agent_id: string;
  scope_id: string;
  permissions: string[];
  expires_at: string;
  grant_reason: string;
  delegation_edge_id: string;
  org_id: string;
}

export interface CreateInvocationParams {
  parent_agent_id: string;
  child_agent_id: string;
  scope_id: string;
  task_id: string;
  depth: number;
  inherited_permissions: string[];
  invocation_edge_id: string;
}

export interface RecordToolCallParams {
  agent_id: string;
  tool_id: string;
  scope_id: string;
  parameters_hash: string;
  authorization_decision_id: string;
  called_edge_id: string;
}

export interface RecordActionParams {
  tool_id: string;
  action_id: string;
  action_type: string;
  target_system: string;
  parameters_hash: string;
  outcome: string;
  reversible: boolean;
  executed_at: string;
}

export interface AuditQueryParams {
  org_id: string;
  human_id?: string;
  start_time: string;
  end_time: string;
  page: number;
  limit: number;
}

export interface DelegationGraphRepository {
  // ─── Graph mutations ─────────────────────────────────────────────────────

  /** Create Human→Agent delegation edge */
  createDelegation(params: CreateDelegationParams): Promise<void>;

  /** Create Agent→Agent invocation edge */
  createInvocation(params: CreateInvocationParams): Promise<void>;

  /** Record Agent→Tool call edge */
  recordToolCall(params: RecordToolCallParams): Promise<void>;

  /** Record Tool→Action execution edge */
  recordAction(params: RecordActionParams): Promise<void>;

  // ─── Queries ─────────────────────────────────────────────────────────────

  /** QUERY 1: Trace action back to human sponsor with full chain */
  traceAction(action_id: string): Promise<ActionTraceResult | null>;

  /** QUERY 2: Compute full authorization context for an agent */
  getAuthorizationContext(
    agent_id: string,
    org_id: string
  ): Promise<AuthorizationContext | null>;

  /** QUERY 3: Evaluate authorization request against delegation graph */
  evaluateAuthorization(params: {
    agent_id: string;
    tool_id: string;
    action_type: string;
    scope_id: string;
    org_id: string;
  }): Promise<AuthorizationEvaluationResult>;

  /** QUERY 4: Compliance audit query (EU AI Act Article 12) */
  auditQuery(params: AuditQueryParams): Promise<AuditQueryResult>;

  /** QUERY 5: Transitive revocation cascade — atomic write transaction */
  revocationCascade(
    delegation_edge_id: string
  ): Promise<RevocationCascadeResult>;

  // ─── Inventory ────────────────────────────────────────────────────────────

  listAgents(params: {
    org_id: string;
    framework?: string;
    status?: string;
  }): Promise<AgentInventoryRecord[]>;

  listDelegations(params: {
    org_id: string;
    status?: string;
  }): Promise<DelegationTreeRecord[]>;

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  close(): Promise<void>;
  verifyConnectivity(): Promise<boolean>;
}
