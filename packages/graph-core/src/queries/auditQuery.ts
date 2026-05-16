// Query 4 — Compliance audit query (EU AI Act Article 12)
// Returns all actions attributable to a human, with full delegation chain.
// Paginated, ordered by executed_at DESC.

import type { Driver, Session } from "neo4j-driver";
import type { AuditQueryResult, AuditActionRecord, ChainHop } from "../types/results.js";
import type { HumanNode, AgentNode, ToolNode, ActionNode } from "@canary/event-schema";
import neo4j from "neo4j-driver";

const AUDIT_QUERY_CYPHER = `
MATCH (human:Human {org_id: $org_id})
  -[:DELEGATED_TO*1..]->(agent:Agent)
  -[:INVOKED*0..]->(leaf:Agent)
  -[:CALLED {authorization_decision_id: ''}]->(tool:Tool)
  -[:EXECUTED]->(action:Action)
WHERE ($human_id = '' OR human.id = $human_id)
  AND action.executed_at >= datetime($start_time)
  AND action.executed_at <= datetime($end_time)

MATCH full_path = (human)-[:DELEGATED_TO|INVOKED|CALLED|EXECUTED*]->(action)

// Collect call edge for decision ID
MATCH (leaf2:Agent)-[call:CALLED]->(tool2:Tool)-[:EXECUTED]->(action)

WITH human, action, tool2, call, full_path,
  [node IN nodes(full_path) | {
    labels:    labels(node),
    id:        node.id,
    name:      coalesce(node.name, node.email, node.id),
    org_id:    coalesce(node.org_id, ''),
    framework: coalesce(node.framework, ''),
    risk_tier: coalesce(node.risk_tier, ''),
    reversible: coalesce(node.reversible, false),
    executed_at: coalesce(toString(node.executed_at), ''),
    outcome:   coalesce(node.outcome, '')
  }] AS chain_nodes,
  [rel IN relationships(full_path) | {
    type:      type(rel),
    scope_id:  coalesce(rel.scope_id, ''),
    depth:     coalesce(rel.depth, 0),
    status:    coalesce(rel.status, ''),
    called_at: coalesce(toString(rel.called_at), '')
  }] AS chain_edges

ORDER BY action.executed_at DESC
SKIP toInteger($skip)
LIMIT toInteger($limit)

RETURN
  action.id                                AS action_id,
  action.type                              AS action_type,
  action.target_system                     AS target_system,
  action.outcome                           AS outcome,
  toString(action.executed_at)             AS executed_at,
  action.reversible                        AS reversible,
  coalesce(call.authorization_decision_id, '') AS authorization_decision_id,
  human.id                                 AS human_sponsor_id,
  human.email                              AS human_email,
  human.org_id                             AS human_org_id,
  chain_nodes                              AS chain_nodes,
  chain_edges                              AS chain_edges
`;

const COUNT_QUERY_CYPHER = `
MATCH (human:Human {org_id: $org_id})
  -[:DELEGATED_TO*1..]->(agent:Agent)
  -[:INVOKED*0..]->(leaf:Agent)
  -[:CALLED]->(tool:Tool)
  -[:EXECUTED]->(action:Action)
WHERE ($human_id = '' OR human.id = $human_id)
  AND action.executed_at >= datetime($start_time)
  AND action.executed_at <= datetime($end_time)
RETURN count(DISTINCT action.id) AS total_count
`;

export async function auditQuery(
  driver: Driver,
  params: {
    org_id: string;
    human_id?: string;
    start_time: string;
    end_time: string;
    page: number;
    limit: number;
  }
): Promise<AuditQueryResult> {
  const session: Session = driver.session({ defaultAccessMode: "READ" });
  try {
    const skip = (params.page - 1) * params.limit;
    const queryParams = {
      org_id: params.org_id,
      human_id: params.human_id ?? "",
      start_time: params.start_time,
      end_time: params.end_time,
      skip: neo4j.int(skip),
      limit: neo4j.int(params.limit),
    };

    const [dataResult, countResult] = await Promise.all([
      session.run(AUDIT_QUERY_CYPHER, queryParams),
      session.run(COUNT_QUERY_CYPHER, queryParams),
    ]);

    const totalCount = Number(
      (countResult.records[0]?.get("total_count") as number | undefined) ?? 0
    );

    type NodeRaw = {
      labels: string[];
      id: string;
      name: string;
      org_id: string;
      framework: string;
      risk_tier: string;
      reversible: boolean;
      executed_at: string;
      outcome: string;
    };

    type EdgeRaw = {
      type: string;
      scope_id: string;
      depth: number;
      status: string;
      called_at: string;
    };

    const records: AuditActionRecord[] = dataResult.records.map((record) => {
      const chainNodes = record.get("chain_nodes") as NodeRaw[];
      const chainEdges = record.get("chain_edges") as EdgeRaw[];

      const chain: ChainHop[] = chainNodes.map((node, i) => {
        const nodeType = node.labels.includes("Human")
          ? "Human"
          : node.labels.includes("Agent")
          ? "Agent"
          : node.labels.includes("Tool")
          ? "Tool"
          : "Action";

        const edge = chainEdges[i] as EdgeRaw | undefined;
        return {
          node_type: nodeType,
          node_id: node.id,
          node_data: node as unknown as HumanNode | AgentNode | ToolNode | ActionNode,
          edge_type: (edge?.type ?? "DELEGATED_TO") as ChainHop["edge_type"],
          edge_data: edge as unknown as Record<string, unknown>,
          depth: edge?.depth ?? 0,
          scope_id: edge?.scope_id ?? null,
        };
      });

      return {
        action_id: record.get("action_id") as string,
        action_type: record.get("action_type") as string,
        target_system: record.get("target_system") as string,
        outcome: record.get("outcome") as string,
        executed_at: record.get("executed_at") as string,
        reversible: record.get("reversible") as boolean,
        authorization_decision_id: record.get("authorization_decision_id") as string,
        delegation_chain: chain,
        human_sponsor: {
          id: record.get("human_sponsor_id") as string,
          email: record.get("human_email") as string,
          org_id: record.get("human_org_id") as string,
          created_at: "",
        },
      };
    });

    return {
      records,
      total_count: totalCount,
      page: params.page,
      limit: params.limit,
    };
  } finally {
    await session.close();
  }
}
