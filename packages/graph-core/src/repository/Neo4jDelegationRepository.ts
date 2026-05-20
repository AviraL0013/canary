// Neo4jDelegationRepository — corrected canonical delegation graph model
// SINGLE AUTHORITY EDGE MODEL:
//
// (Human)-[:DELEGATED_TO]->(Agent)
// (Agent)-[:DELEGATED_TO]->(Agent)
// (Agent)-[:CALLED]->(Tool)
// (Tool)-[:EXECUTED]->(Action)

import neo4j, { type Driver, type Session } from "neo4j-driver";

import type {
  DelegationGraphRepository,
  CreateDelegationParams,
  CreateInvocationParams,
  RecordToolCallParams,
  RecordActionParams,
  AuditQueryParams,
} from "./DelegationGraphRepository.js";

import type {
  ActionTraceResult,
  AuthorizationContext,
  AuthorizationEvaluationResult,
  AuditQueryResult,
  RevocationCascadeResult,
  AgentInventoryRecord,
  DelegationTreeRecord,
} from "../types/results.js";

import { traceAction } from "../queries/traceAction.js";
import { getAuthorizationContext } from "../queries/getAuthorizationContext.js";
import { evaluateAuthorization } from "../queries/evaluateAuthorization.js";
import { auditQuery } from "../queries/auditQuery.js";
import { revocationCascade } from "../queries/revocationCascade.js";

export class Neo4jDelegationRepository
  implements DelegationGraphRepository
{
  private readonly driver: Driver;

  constructor(uri: string, user: string, password: string) {
    this.driver = neo4j.driver(
      uri,
      neo4j.auth.basic(user, password)
    );
  }

  // ─────────────────────────────────────────────────────────────
  // ROOT HUMAN → AGENT DELEGATION
  // ─────────────────────────────────────────────────────────────

  async createDelegation(
    params: CreateDelegationParams
  ): Promise<void> {
    const session: Session = this.driver.session({
      defaultAccessMode: "WRITE",
    });

    try {
      await session.run(
        `
        MERGE (h:Human {
          id: $human_id,
          org_id: $org_id
        })

        ON CREATE SET
          h.created_at = datetime()

        MERGE (a:Agent {
          id: $agent_id,
          org_id: $org_id
        })

        ON CREATE SET
          a.status = 'ACTIVE',
          a.deployed_at = datetime()

        MERGE (s:DelegationScope {
          id: $scope_id
        })

        ON CREATE SET
          s.permissions = $permissions,
          s.expires_at = datetime($expires_at),
          s.purpose = $grant_reason,
          s.max_delegation_depth = 5,
          s.created_at = datetime()

        CREATE (h)-[:DELEGATED_TO {
          id: $delegation_edge_id,

          delegation_type: 'HUMAN_GRANT',

          scope_id: $scope_id,

          delegated_at: datetime(),

          expires_at: datetime($expires_at),

          grant_reason: $grant_reason,

          depth: 0,

          status: 'ACTIVE',

          inherited_permissions: $permissions
        }]->(a)
        `,
        {
          human_id: params.human_id,
          agent_id: params.agent_id,
          scope_id: params.scope_id,
          permissions: params.permissions,
          expires_at: params.expires_at,
          grant_reason: params.grant_reason,
          delegation_edge_id: params.delegation_edge_id,
          org_id: params.org_id,
        }
      );
    } finally {
      await session.close();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // AGENT → AGENT DELEGATION
  // ─────────────────────────────────────────────────────────────

  async createInvocation(
    params: CreateInvocationParams
  ): Promise<void> {
    const session: Session = this.driver.session({
      defaultAccessMode: "WRITE",
    });

    try {
      await session.run(
        `
        MATCH (parent:Agent {
          id: $parent_agent_id
        })

        MERGE (child:Agent {
          id: $child_agent_id,
          org_id: parent.org_id
        })

        ON CREATE SET
          child.status = 'ACTIVE',
          child.deployed_at = datetime()

        CREATE (parent)-[:DELEGATED_TO {
          id: $invocation_edge_id,

          delegation_type: 'AGENT_INVOCATION',

          scope_id: $scope_id,

          delegated_at: datetime(),

          task_id: $task_id,

          depth: $depth,

          status: 'ACTIVE',

          inherited_permissions: $inherited_permissions
        }]->(child)
        `,
        {
          parent_agent_id: params.parent_agent_id,
          child_agent_id: params.child_agent_id,
          scope_id: params.scope_id,
          task_id: params.task_id,
          depth: neo4j.int(params.depth),
          inherited_permissions: params.inherited_permissions,
          invocation_edge_id: params.invocation_edge_id,
        }
      );
    } finally {
      await session.close();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // AGENT → TOOL
  // ─────────────────────────────────────────────────────────────

  async recordToolCall(
    params: RecordToolCallParams
  ): Promise<void> {
    const session: Session = this.driver.session({
      defaultAccessMode: "WRITE",
    });

    try {
      await session.run(
        `
        MATCH (a:Agent {
          id: $agent_id
        })

        MERGE (t:Tool {
          id: $tool_id
        })

        ON CREATE SET
          t.created_at = datetime(),
          t.risk_tier = $tool_risk_tier

        ON MATCH SET
          t.risk_tier =
            CASE
              WHEN t.risk_tier IS NULL
              THEN $tool_risk_tier
              ELSE t.risk_tier
            END

        CREATE (a)-[:CALLED {
          id: $called_edge_id,

          scope_id: $scope_id,

          called_at: datetime(),

          parameters_hash: $parameters_hash,

          authorization_decision_id:
            $authorization_decision_id
        }]->(t)
        `,
        {
          agent_id: params.agent_id,
          tool_id: params.tool_id,
          scope_id: params.scope_id,
          parameters_hash: params.parameters_hash,
          authorization_decision_id:
            params.authorization_decision_id,
          called_edge_id: params.called_edge_id,
          tool_risk_tier:
            params.tool_risk_tier ?? "LOW",
        }
      );
    } finally {
      await session.close();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // TOOL → ACTION
  // ─────────────────────────────────────────────────────────────

  async recordAction(
    params: RecordActionParams
  ): Promise<void> {
    const session: Session = this.driver.session({
      defaultAccessMode: "WRITE",
    });

    try {
      await session.run(
        `
        MATCH (t:Tool {
          id: $tool_id
        })

        CREATE (action:Action {
          id: $action_id,

          type: $action_type,

          target_system: $target_system,

          parameters_hash: $parameters_hash,

          outcome: $outcome,

          reversible: $reversible,

          executed_at: datetime($executed_at)
        })

        CREATE (t)-[:EXECUTED {
          action_id: $action_id,

          executed_at: datetime($executed_at)
        }]->(action)
        `,
        {
          tool_id: params.tool_id,
          action_id: params.action_id,
          action_type: params.action_type,
          target_system: params.target_system,
          parameters_hash: params.parameters_hash,
          outcome: params.outcome,
          reversible: params.reversible,
          executed_at: params.executed_at,
        }
      );
    } finally {
      await session.close();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // TRACE
  // ─────────────────────────────────────────────────────────────

  async traceAction(
    action_id: string
  ): Promise<ActionTraceResult | null> {
    return traceAction(this.driver, action_id);
  }

  // ─────────────────────────────────────────────────────────────
  // AUTH CONTEXT
  // ─────────────────────────────────────────────────────────────

  async getAuthorizationContext(
    agent_id: string,
    org_id: string
  ): Promise<AuthorizationContext | null> {
    return getAuthorizationContext(
      this.driver,
      agent_id,
      org_id
    );
  }

  // ─────────────────────────────────────────────────────────────
  // AUTH EVALUATION
  // ─────────────────────────────────────────────────────────────

  async evaluateAuthorization(params: {
    agent_id: string;
    tool_id: string;
    action_type: string;
    scope_id: string;
    org_id: string;
  }): Promise<AuthorizationEvaluationResult> {
    return evaluateAuthorization(this.driver, params);
  }

  // ─────────────────────────────────────────────────────────────
  // AUDIT
  // ─────────────────────────────────────────────────────────────

  async auditQuery(
    params: AuditQueryParams
  ): Promise<AuditQueryResult> {
    return auditQuery(this.driver, params);
  }

  // ─────────────────────────────────────────────────────────────
  // REVOCATION
  // ─────────────────────────────────────────────────────────────

  async revocationCascade(
    delegation_edge_id: string
  ): Promise<RevocationCascadeResult> {
    return revocationCascade(
      this.driver,
      delegation_edge_id
    );
  }

  // ─────────────────────────────────────────────────────────────
  // AGENT INVENTORY
  // ─────────────────────────────────────────────────────────────

  async listAgents(params: {
    org_id: string;
    framework?: string;
    status?: string;
  }): Promise<AgentInventoryRecord[]> {
    const session: Session = this.driver.session({
      defaultAccessMode: "READ",
    });

    try {
      const result = await session.run(
        `
        MATCH (a:Agent {
          org_id: $org_id
        })

        WHERE
          ($framework = '' OR a.framework = $framework)
          AND
          ($status = '' OR a.status = $status)

        OPTIONAL MATCH
          chain =
            (h:Human)-[:DELEGATED_TO*]->(a)

        OPTIONAL MATCH
          (a)-[:CALLED]->(t:Tool)

        OPTIONAL MATCH
          (a)-[:CALLED]->(ct:Tool {
            risk_tier: 'CRITICAL'
          })

        RETURN
          a AS agent,

          coalesce(length(chain), 0)
            AS delegation_depth,

          coalesce(h.id, '')
            AS human_sponsor_id,

          count(DISTINCT t)
            AS active_tool_count,

          count(DISTINCT ct)
            AS critical_tool_count
        `,
        {
          org_id: params.org_id,
          framework: params.framework ?? "",
          status: params.status ?? "",
        }
      );

      return result.records.map((r) => {
        const agentNode = r.get("agent");

        return {
  agent: agentNode.properties as AgentInventoryRecord["agent"],

  delegation_depth: Number(
    r.get("delegation_depth")
  ),

  human_sponsor_id:
    r.get("human_sponsor_id") as string,

  active_tool_count: Number(
    r.get("active_tool_count")
  ),

  critical_tool_count: Number(
    r.get("critical_tool_count")
  ),
};
      });
    } finally {
      await session.close();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // DELEGATION TREES
  // ─────────────────────────────────────────────────────────────

  async listDelegations(params: {
    org_id: string;
    status?: string;
  }): Promise<DelegationTreeRecord[]> {
    const session: Session = this.driver.session({
      defaultAccessMode: "READ",
    });

    try {
      const result = await session.run(
        `
        MATCH
          (h:Human {
            org_id: $org_id
          })
          -[d:DELEGATED_TO]->
          (root:Agent)

        WHERE
          d.delegation_type = 'HUMAN_GRANT'
          AND
          ($status = '' OR d.status = $status)

        OPTIONAL MATCH
          p = (root)-[:DELEGATED_TO*0..]->(desc:Agent)

        RETURN
          h.id AS root_human_id,

          root.id AS root_agent_id,

          d.scope_id AS scope_id,

          toString(d.expires_at)
            AS scope_expires_at,

          d.status AS scope_status,

          collect(DISTINCT desc.id)
            AS subtree_agent_ids,

          max(length(p))
            AS total_depth
        `,
        {
          org_id: params.org_id,
          status: params.status ?? "",
        }
      );

      return result.records.map((r) => ({
        root_human_id:
          r.get("root_human_id") as string,

        root_agent_id:
          r.get("root_agent_id") as string,

        scope_id:
          r.get("scope_id") as string,

        scope_expires_at:
          r.get("scope_expires_at") as string,

        scope_status:
          r.get("scope_status") as string,

        subtree_agent_ids:
          r.get("subtree_agent_ids") as string[],

        total_depth: Number(
  r.get("total_depth") ?? 0
),
      }));
    } finally {
      await session.close();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ─────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    await this.driver.close();
  }

  async verifyConnectivity(): Promise<boolean> {
    try {
      await this.driver.verifyConnectivity();
      return true;
    } catch {
      return false;
    }
  }
}