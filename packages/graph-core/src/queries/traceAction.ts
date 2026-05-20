// Query 1 — Trace action to human sponsor
// Returns complete path: Human → ... → Tool → Action
// with depth, scope, and approval nodes at each hop.

import type { Driver, Session } from "neo4j-driver";
import type { ActionTraceResult, ChainHop } from "../types/results.js";
import type { HumanNode, AgentNode, ToolNode, ActionNode } from "@canary/event-schema";

const TRACE_ACTION_CYPHER = `
MATCH (action:Action {id: $action_id})
MATCH path = (human:Human)-[:DELEGATED_TO*0..]->(agent:Agent)
             -[:DELEGATED_TO*0..]->(leaf:Agent)
             -[:CALLED]->(tool:Tool)
             -[:EXECUTED]->(action)

// Collect approval nodes if present
OPTIONAL MATCH (approver:Human)-[approval:APPROVED]->(action)

WITH human, agent, leaf, tool, action, path, approver, approval
ORDER BY length(path) ASC
LIMIT 1

WITH human, agent, leaf, tool, action, path,
  CASE WHEN approver IS NOT NULL
    THEN [{
      approved_by_id:       approver.id,
      approved_by_email:    approver.email,
      approved_by_org:      approver.org_id,
      approved_at:          toString(approval.approved_at),
      approval_reason:      approval.approval_reason,
      approval_request_id:  approval.approval_request_id
    }]
    ELSE []
  END AS approval_nodes

RETURN
  action.id                          AS action_id,
  human.id                           AS human_id,
  human.email                        AS human_email,
  human.org_id                       AS human_org_id,
  toString(human.created_at)         AS human_created_at,
  [node IN nodes(path) | {
    labels:       labels(node),
    id:           node.id,
    name:         coalesce(node.name, node.email, node.id),
    org_id:       coalesce(node.org_id, ''),
    status:       coalesce(node.status, node.outcome, ''),
    framework:    coalesce(node.framework, ''),
    risk_tier:    coalesce(node.risk_tier, ''),
    executed_at:  coalesce(toString(node.executed_at), ''),
    reversible:   coalesce(node.reversible, false)
  }]                                 AS chain_nodes,
  [rel IN relationships(path) | {
    type:         type(rel),
    scope_id:     coalesce(rel.scope_id, ''),
    depth:        coalesce(rel.depth, 0),
    status:       coalesce(rel.status, ''),
    granted_at:   coalesce(toString(rel.granted_at), ''),
    expires_at:   coalesce(toString(rel.expires_at), ''),
    called_at:    coalesce(toString(rel.called_at), ''),
    executed_at:  coalesce(toString(rel.executed_at), ''),
    authorization_decision_id: coalesce(rel.authorization_decision_id, '')
  }]                                 AS chain_edges,
  length(path)                       AS total_depth,
  approval_nodes                     AS approval_nodes
`;

export async function traceAction(
  driver: Driver,
  action_id: string
): Promise<ActionTraceResult | null> {
  const session: Session = driver.session({ defaultAccessMode: "READ" });
  try {
    const result = await session.run(TRACE_ACTION_CYPHER, { action_id });
    if (result.records.length === 0) return null;

    const record = result.records[0];
    if (!record) return null;

    const chainNodes = record.get("chain_nodes") as Array<Record<string, unknown>>;
    const chainEdges = record.get("chain_edges") as Array<Record<string, unknown>>;

    const chain: ChainHop[] = chainNodes.map((node, i) => {
      const labels = node["labels"] as string[];
      const nodeType = labels.includes("Human")
        ? "Human"
        : labels.includes("Agent")
        ? "Agent"
        : labels.includes("Tool")
        ? "Tool"
        : "Action";

      const edge = chainEdges[i] as Record<string, unknown> | undefined;

      return {
        node_type: nodeType,
        node_id: node["id"] as string,
        node_data: node as unknown as HumanNode | AgentNode | ToolNode | ActionNode,
        edge_type: edge ? (edge["type"] as ChainHop["edge_type"]) : "DELEGATED_TO",
        edge_data: edge ?? {},
        depth: (edge?.["depth"] as number) ?? 0,
        scope_id: (edge?.["scope_id"] as string) || null,
      };
    });

    const approvalRaw = record.get("approval_nodes") as Array<Record<string, unknown>>;
    const approvalNodes = approvalRaw.map((a) => ({
      approved_by: {
        id: a["approved_by_id"] as string,
        email: a["approved_by_email"] as string,
        org_id: a["approved_by_org"] as string,
        created_at: "",
      } satisfies HumanNode,
      approved_at: a["approved_at"] as string,
      approval_reason: a["approval_reason"] as string,
      approval_request_id: a["approval_request_id"] as string,
    }));

    return {
      action_id,
      human_sponsor: {
        id: record.get("human_id") as string,
        email: record.get("human_email") as string,
        org_id: record.get("human_org_id") as string,
        created_at: record.get("human_created_at") as string,
      },
      chain,
      approval_nodes: approvalNodes,
      total_depth: (record.get("total_depth") as number) ?? 0,
    };
  } finally {
    await session.close();
  }
}
