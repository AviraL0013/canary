// Node type definitions for the Canary delegation graph

export type Framework =
  | "LANGGRAPH"
  | "CREWAI"
  | "OPENAI_SDK"
  | "AUTOGEN"
  | "CUSTOM";

export type AgentStatus = "ACTIVE" | "SUSPENDED" | "RETIRED";

export type RiskTier = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type ActionOutcome = "ALLOWED" | "BLOCKED" | "APPROVED" | "FAILED";

export interface HumanNode {
  id: string;
  email: string;
  org_id: string;
  created_at: string; // ISO 8601
}

export interface AgentNode {
  id: string;
  name: string;
  framework: Framework;
  version: string;
  org_id: string;
  deployed_by: string; // human ID
  deployed_at: string; // ISO 8601
  status: AgentStatus;
}

export interface ToolNode {
  id: string;
  name: string;
  mcp_server: string;
  resource_type: string;
  risk_tier: RiskTier;
}

export interface ActionNode {
  id: string;
  type: string;
  target_system: string;
  parameters_hash: string;
  outcome: ActionOutcome;
  executed_at: string; // ISO 8601
  reversible: boolean;
}

export interface DelegationScopeNode {
  id: string;
  permissions: string[];
  constraints: Record<string, unknown>;
  expires_at: string; // ISO 8601
  purpose: string;
  max_delegation_depth: number;
}
