// Graph query result types — returned by the 5 core Cypher queries

import type {
  HumanNode,
  AgentNode,
  ToolNode,
  ActionNode,
  DelegationScopeNode,
  RiskTier,
} from "@canary/event-schema";

// ─── Query 1: Trace action to human sponsor ───────────────────────────────

export interface ChainHop {
  node_type: "Human" | "Agent" | "Tool" | "Action";
  node_id: string;
  node_data: HumanNode | AgentNode | ToolNode | ActionNode;
  edge_type: "DELEGATED_TO" | "CALLED" | "EXECUTED";
  edge_data: Record<string, unknown>;
  depth: number;
  scope_id: string | null;
}

export interface ActionTraceResult {
  action_id: string;
  human_sponsor: HumanNode;
  chain: ChainHop[];
  approval_nodes: Array<{
    approved_by: HumanNode;
    approved_at: string;
    approval_reason: string;
    approval_request_id: string;
  }>;
  total_depth: number;
}

// ─── Query 2: Authorization context (cached in Redis) ─────────────────────

export interface AuthorizationContext {
  agent_id: string;
  org_id: string;
  human_sponsor_id: string;
  delegation_chain: Array<{
    from_id: string;
    to_id: string;
    scope_id: string;
    depth: number;
    granted_at: string;
    expires_at: string;
    status: string;
    inherited_permissions: string[];
  }>;
  effective_permissions: string[];
  delegation_depth: number;
  weakest_scope_expires_at: string;
  accessible_tools: Array<{
    tool_id: string;
    tool_name: string;
    risk_tier: RiskTier;
    mcp_server: string;
  }>;
  risk_score_inputs: {
    delegation_depth: number;
    unique_permissions: number;
    critical_tools_count: number;
    agent_created_at: string;
  };
  computed_at: string;
}

// ─── Query 3: Authorization decision query ────────────────────────────────

export interface AuthorizationEvaluationResult {
  chain_found: boolean;
  chain_unrevoked: boolean;
  chain_unexpired: boolean;
  action_within_scope: boolean;
  scope_correctly_attenuated: boolean;
  delegation_depth: number;
  human_sponsor_id: string;
  chain_path: string[];
  effective_permissions: string[];
  weakest_scope_expires_at: string;
  critical_tools_in_scope: string[];
  agent_org_id: string;
  tool_org_id: string;
  tool_risk_tier: RiskTier;
}

// ─── Query 4: Audit query ─────────────────────────────────────────────────

export interface AuditActionRecord {
  action_id: string;
  action_type: string;
  target_system: string;
  outcome: string;
  executed_at: string;
  reversible: boolean;
  authorization_decision_id: string;
  delegation_chain: ChainHop[];
  human_sponsor: HumanNode;
}

export interface AuditQueryResult {
  records: AuditActionRecord[];
  total_count: number;
  page: number;
  limit: number;
}

// ─── Query 5: Revocation cascade ─────────────────────────────────────────

export interface RevocationCascadeResult {
  revoked_edge_id: string;
  affected_agent_ids: string[];
  edges_marked_revoked: number;
}

// ─── Additional repository result types ───────────────────────────────────

export interface AgentInventoryRecord {
  agent: AgentNode;
  delegation_depth: number;
  human_sponsor_id: string;
  active_tool_count: number;
  critical_tool_count: number;
}

export interface DelegationTreeRecord {
  root_human_id: string;
  root_agent_id: string;
  scope_id: string;
  scope_expires_at: string;
  scope_status: string;
  subtree_agent_ids: string[];
  total_depth: number;
}
