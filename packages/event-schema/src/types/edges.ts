// Edge type definitions for the Canary delegation graph

export type DelegationEdgeStatus = "ACTIVE" | "REVOKED" | "EXPIRED";

export interface DelegatedToEdge {
  scope_id: string;
  granted_at: string;
  expires_at: string;
  grant_reason: string;
  status: DelegationEdgeStatus;
}

export interface InvokedEdge {
  scope_id: string;
  invoked_at: string;
  task_id: string;
  inherited_permissions: string[]; // explicit subset of parent
}

export interface CalledEdge {
  scope_id: string;
  called_at: string;
  parameters_hash: string;
  authorization_decision_id: string;
}

export interface ExecutedEdge {
  action_id: string;
  executed_at: string;
}

export interface ApprovedEdge {
  action_id: string;
  approved_at: string;
  approval_reason: string;
  approval_request_id: string;
}

export interface RevokedEdge {
  delegation_edge_id: string;
  revoked_at: string;
  revocation_reason: string;
  cascade_affected_agents: string[];
}
