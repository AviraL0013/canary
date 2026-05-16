// Query 2 — Compute authorization context for an agent
// Returns full delegation chain, effective permissions, accessible tools,
// and risk score inputs. This result is cached in Redis (TTL 30s).

import type { Driver, Session } from "neo4j-driver";
import type { AuthorizationContext } from "../types/results.js";
import type { RiskTier } from "@canary/event-schema";

const GET_AUTHORIZATION_CONTEXT_CYPHER = `
MATCH (human:Human {org_id: $org_id})-[d:DELEGATED_TO {status: 'ACTIVE'}]->(root:Agent {id: $agent_id})

// Walk the full chain from human to this agent (may pass through intermediaries)
OPTIONAL MATCH chain_path = (root)-[:INVOKED*0..]->(leaf:Agent {id: $agent_id})

// Get all delegation hops leading to this agent
MATCH full_path = (human)-[:DELEGATED_TO]->(root)-[:INVOKED*0..]->(target:Agent {id: $agent_id})

// Collect edges along the chain
WITH human, d, root, full_path,
  [rel IN relationships(full_path) | {
    from_id:               startNode(rel).id,
    to_id:                 endNode(rel).id,
    scope_id:              coalesce(rel.scope_id, ''),
    depth:                 coalesce(rel.depth, 0),
    granted_at:            coalesce(toString(rel.granted_at), toString(rel.invoked_at), ''),
    expires_at:            coalesce(toString(rel.expires_at), ''),
    status:                coalesce(rel.status, 'ACTIVE'),
    inherited_permissions: coalesce(rel.inherited_permissions, [])
  }] AS chain_hops

// Find all accessible tools through current scope
OPTIONAL MATCH (target:Agent {id: $agent_id})-[c:CALLED]->(tool:Tool)
WHERE c.scope_id = d.scope_id

WITH human, d, chain_hops,
  collect(DISTINCT {
    tool_id:    tool.id,
    tool_name:  tool.name,
    risk_tier:  tool.risk_tier,
    mcp_server: tool.mcp_server
  }) AS accessible_tools,
  d.expires_at AS scope_expires_at

RETURN
  $agent_id                    AS agent_id,
  $org_id                      AS org_id,
  human.id                     AS human_sponsor_id,
  chain_hops                   AS delegation_chain,
  d.inherited_permissions      AS effective_permissions,
  size(chain_hops)             AS delegation_depth,
  toString(scope_expires_at)   AS weakest_scope_expires_at,
  accessible_tools             AS accessible_tools,
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
