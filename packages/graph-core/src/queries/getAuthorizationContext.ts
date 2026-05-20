// Query 2 — Compute authorization context for an agent
// Returns full delegation chain, effective permissions, accessible tools,
// and risk score inputs. This result is cached in Redis (TTL 30s).

import type { Driver, Session } from "neo4j-driver";
import type { AuthorizationContext } from "../types/results.js";
import type { RiskTier } from "@canary/event-schema";

const GET_AUTHORIZATION_CONTEXT_CYPHER = `
// Find an active delegation from human in the org to the target agent
// Case 1: agent IS the root agent (depth 0)
// Case 2: agent is a descendant via DELEGATED_TO chain
MATCH (human:Human {org_id: $org_id})-[d:DELEGATED_TO {status: 'ACTIVE'}]->(root:Agent)
MATCH full_path = (root)-[:DELEGATED_TO*0..]->(target:Agent {id: $agent_id})

// Collect edges along the chain (DELEGATED_TO hops)
WITH human, d, root, target, full_path,
  [{
    from_id:               human.id,
    to_id:                 root.id,
    scope_id:              coalesce(d.scope_id, ''),
    depth:                 0,
    granted_at:            coalesce(toString(d.granted_at), ''),
    expires_at:            coalesce(toString(d.expires_at), ''),
    status:                coalesce(d.status, 'ACTIVE'),
    inherited_permissions: coalesce(d.inherited_permissions, [])
  }] + [rel IN relationships(full_path) | {
    from_id:               startNode(rel).id,
    to_id:                 endNode(rel).id,
    scope_id:              coalesce(rel.scope_id, ''),
    depth:                 coalesce(rel.depth, 0),
    granted_at:            coalesce(toString(rel.delegated_at), coalesce(toString(rel.granted_at), '')),
    expires_at:            '',
    status:                coalesce(rel.status, 'ACTIVE'),
    inherited_permissions: coalesce(rel.inherited_permissions, [])
  }] AS chain_hops

// Find all accessible tools this agent has previously called
OPTIONAL MATCH (target)-[:CALLED]->(tool:Tool)

WITH human, d, target, chain_hops,
  collect(DISTINCT {
    tool_id:    coalesce(tool.id, ''),
    tool_name:  coalesce(tool.name, ''),
    risk_tier:  coalesce(tool.risk_tier, 'LOW'),
    mcp_server: coalesce(tool.mcp_server, '')
  }) AS accessible_tools,
  d.expires_at AS scope_expires_at,
  // Effective permissions = leaf hop's permissions (most attenuated)
  CASE WHEN size(chain_hops) > 0
    THEN chain_hops[size(chain_hops)-1].inherited_permissions
    ELSE coalesce(d.inherited_permissions, [])
  END AS effective_permissions

RETURN
  $agent_id                    AS agent_id,
  $org_id                      AS org_id,
  human.id                     AS human_sponsor_id,
  chain_hops                   AS delegation_chain,
  effective_permissions        AS effective_permissions,
  size(chain_hops)             AS delegation_depth,
  toString(scope_expires_at)   AS weakest_scope_expires_at,
  [t IN accessible_tools WHERE t.tool_id <> ''] AS accessible_tools,
  toString(datetime())         AS computed_at
`;

export async function getAuthorizationContext(
  driver: Driver,
  agent_id: string,
  org_id: string
): Promise<AuthorizationContext | null> {
  const session: Session = driver.session({ defaultAccessMode: "READ" });
  try {
    const result = await session.run(GET_AUTHORIZATION_CONTEXT_CYPHER, {
      agent_id,
      org_id,
    });

    if (result.records.length === 0) return null;
    const record = result.records[0];
    if (!record) return null;

    type ChainHopRaw = {
      from_id: string;
      to_id: string;
      scope_id: string;
      depth: number;
      granted_at: string;
      expires_at: string;
      status: string;
      inherited_permissions: string[];
    };

    type ToolRaw = {
      tool_id: string;
      tool_name: string;
      risk_tier: RiskTier;
      mcp_server: string;
    };

    const chainHops = record.get("delegation_chain") as ChainHopRaw[];
    const accessibleTools = record.get("accessible_tools") as ToolRaw[];
    const effectivePermissions = (record.get("effective_permissions") as string[] | null) ?? [];

    // Find critical tool count for risk scoring
    const criticalToolCount = accessibleTools.filter(
      (t) => t.risk_tier === "CRITICAL"
    ).length;

    return {
      agent_id,
      org_id,
      human_sponsor_id: record.get("human_sponsor_id") as string,
      delegation_chain: chainHops,
      effective_permissions: effectivePermissions,
      delegation_depth: Number(record.get("delegation_depth")),
      weakest_scope_expires_at: record.get("weakest_scope_expires_at") as string,
      accessible_tools: accessibleTools.map((t) => ({
        tool_id: t.tool_id,
        tool_name: t.tool_name,
        risk_tier: t.risk_tier,
        mcp_server: t.mcp_server,
      })),
      risk_score_inputs: {
        delegation_depth: Number(record.get("delegation_depth")),
        unique_permissions: effectivePermissions.length,
        critical_tools_count: criticalToolCount,
        agent_created_at: "", // enriched separately
      },
      computed_at: record.get("computed_at") as string,
    };
  } finally {
    await session.close();
  }
}