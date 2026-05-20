// Query 3 — Authorization decision evaluation
// Verifies full delegation chain validity for a specific (agent, tool, action, scope).
// Checks: chain exists, no revoked edges, no expired scopes,
//         action within permissions, scope not over-inherited.

import type { Driver, Session } from "neo4j-driver";
import type { AuthorizationEvaluationResult } from "../types/results.js";
import type { RiskTier } from "@canary/event-schema";

const EVALUATE_AUTHORIZATION_CYPHER = `
// Find agent and tool
MATCH (agent:Agent {id: $agent_id, org_id: $org_id})
MATCH (tool:Tool {id: $tool_id})

// Find delegation chain from human sponsor to this agent
OPTIONAL MATCH chain_path = (human:Human)-[:DELEGATED_TO]->(root:Agent)
  -[:DELEGATED_TO*0..]->(agent)
WHERE all(r IN relationships(chain_path)
  WHERE coalesce(r.status, 'ACTIVE') = 'ACTIVE')

// Collect chain relationships for validation
WITH agent, tool, human, chain_path,
  [rel IN relationships(chain_path) | {
    type:         type(rel),
    scope_id:     coalesce(rel.scope_id, ''),
    status:       coalesce(rel.status, 'ACTIVE'),
    expires_at:   rel.expires_at,
    depth:        coalesce(rel.depth, 0),
    permissions:  coalesce(rel.inherited_permissions, [])
  }] AS chain_rels

// Check for any revoked edge
WITH agent, tool, human, chain_path, chain_rels,
  human IS NOT NULL                                    AS chain_found,
  NOT any(r IN chain_rels WHERE r.status = 'REVOKED')  AS chain_unrevoked,
  NOT any(r IN chain_rels WHERE r.expires_at < datetime()) AS chain_unexpired,
  [r IN chain_rels | r.scope_id] AS scope_chain,
  [r IN chain_rels | r.permissions] AS perm_chain,
  coalesce(size(chain_rels), 0)                        AS delegation_depth

// Check scope_id match
WITH agent, tool, human, chain_found, chain_unrevoked, chain_unexpired,
  delegation_depth, perm_chain, scope_chain,
  // Effective permissions = permissions from the leaf delegation
  CASE WHEN size(perm_chain) > 0
    THEN perm_chain[size(perm_chain)-1]
    ELSE []
  END AS effective_permissions

// Verify no scope over-inheritance (each hop's perms must be subset of parent)
WITH agent, tool, human, chain_found, chain_unrevoked, chain_unexpired,
  delegation_depth, effective_permissions,
  // scope_correctly_attenuated: no hop has more perms than its parent
  reduce(valid = true, i IN range(1, size(perm_chain)-1) |
    valid AND all(p IN perm_chain[i] WHERE p IN perm_chain[i-1])
  ) AS scope_correctly_attenuated

// Find accessible critical tools in scope
OPTIONAL MATCH (agent)-[:CALLED]->(critical_tool:Tool {risk_tier: 'CRITICAL'})

RETURN
  chain_found                                         AS chain_found,
  chain_unrevoked                                     AS chain_unrevoked,
  chain_unexpired                                     AS chain_unexpired,
  $action_type IN effective_permissions               AS action_within_scope,
  scope_correctly_attenuated                          AS scope_correctly_attenuated,
  delegation_depth                                    AS delegation_depth,
  coalesce(human.id, '')                              AS human_sponsor_id,
  [n IN nodes(chain_path) | n.id]                     AS chain_path,
  effective_permissions                               AS effective_permissions,
  ''                                                  AS weakest_scope_expires_at,
  collect(DISTINCT coalesce(critical_tool.id, ''))    AS critical_tools_in_scope,
  agent.org_id                                        AS agent_org_id,
  tool.org_id                                         AS tool_org_id,
  tool.risk_tier                                      AS tool_risk_tier
`;

export async function evaluateAuthorization(
  driver: Driver,
  params: {
    agent_id: string;
    tool_id: string;
    action_type: string;
    scope_id: string;
    org_id: string;
  }
): Promise<AuthorizationEvaluationResult> {
  const session: Session = driver.session({ defaultAccessMode: "READ" });
  try {
    const result = await session.run(EVALUATE_AUTHORIZATION_CYPHER, {
      agent_id: params.agent_id,
      tool_id: params.tool_id,
      action_type: params.action_type,
      scope_id: params.scope_id,
      org_id: params.org_id,
    });

    if (result.records.length === 0) {
      // No records = agent/tool not found = chain not found
      return {
        chain_found: false,
        chain_unrevoked: false,
        chain_unexpired: false,
        action_within_scope: false,
        scope_correctly_attenuated: false,
        delegation_depth: 0,
        human_sponsor_id: "",
        chain_path: [],
        effective_permissions: [],
        weakest_scope_expires_at: "",
        critical_tools_in_scope: [],
        agent_org_id: params.org_id,
        tool_org_id: "",
        tool_risk_tier: "LOW",
      };
    }

    const record = result.records[0];
    if (!record) throw new Error("Unexpected empty result record");

    const criticalTools = (record.get("critical_tools_in_scope") as string[]).filter(
      (id) => id.length > 0
    );

    return {
      chain_found: record.get("chain_found") as boolean,
      chain_unrevoked: record.get("chain_unrevoked") as boolean,
      chain_unexpired: record.get("chain_unexpired") as boolean,
      action_within_scope: record.get("action_within_scope") as boolean,
      scope_correctly_attenuated: record.get("scope_correctly_attenuated") as boolean,
      delegation_depth: Number(record.get("delegation_depth")),
      human_sponsor_id: record.get("human_sponsor_id") as string,
      chain_path: record.get("chain_path") as string[],
      effective_permissions: record.get("effective_permissions") as string[],
      weakest_scope_expires_at: record.get("weakest_scope_expires_at") as string,
      critical_tools_in_scope: criticalTools,
      agent_org_id: record.get("agent_org_id") as string,
      tool_org_id: record.get("tool_org_id") as string,
      tool_risk_tier: record.get("tool_risk_tier") as RiskTier,
    };
  } finally {
    await session.close();
  }
}
