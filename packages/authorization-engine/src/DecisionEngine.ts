// DecisionEngine — orchestrates the full authorization decision flow
// 1. Check Redis cache → 2. Cache miss: query Neo4j → 3. Evaluate policies
// 4. Score risk → 5. Return AuthorizationDecision

import type { DelegationGraphRepository, AuthorizationContext } from "@canary/graph-core";
import { ContextCache } from "./ContextCache.js";
import { RiskScorer, type RiskScoreBreakdown } from "./RiskScorer.js";
import {
  PolicyEvaluator,
  type PolicyEvaluationResult,
  type PolicyConfig,
} from "./PolicyEvaluator.js";
import type { RiskTier } from "@canary/event-schema";

// ─── Request / Response types ────────────────────────────────────────────

export interface AuthorizationRequest {
  request_id: string;
  requesting_agent_id: string;
  tool_id: string;
  action_type: string;
  scope_id: string;
  task_id: string;
  org_id: string;
  timestamp: string;
  parameters_hash: string;
}

export interface AuthorizationDecision {
  decision_id: string;
  request_id: string;
  decision: "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL";
  evaluated_at: string;
  evaluation_source: "cache" | "graph";

  reasoning: {
    chain_found: boolean;
    chain_unrevoked: boolean;
    chain_unexpired: boolean;
    action_within_scope: boolean;
    scope_correctly_attenuated: boolean;
    delegation_depth: number;
    depth_within_policy: boolean;
    risk_score: RiskScoreBreakdown;
    risk_within_threshold: boolean;
    anomaly_detected: boolean;
    policy_evaluations: PolicyEvaluationResult[];
  };

  chain_summary: {
    human_sponsor_id: string;
    delegation_depth: number;
    chain_path: string[];
    effective_permissions: string[];
    weakest_scope_expires_at: string;
    critical_tools_in_scope: string[];
  };

  block_reason?: string;
  approval_required_from?: string[];
  approval_request_id?: string;
}

export interface OrgConfig {
  org_id: string;
  fail_mode: "CLOSED" | "OPEN";
  max_delegation_depth: number;
  risk_score_threshold: number;
  security_contact_id: string | null;
}

// ─── Decision Engine ──────────────────────────────────────────────────────

export class DecisionEngine {
  private readonly repository: DelegationGraphRepository;
  private readonly cache: ContextCache;
  private readonly riskScorer: RiskScorer;
  private readonly policyEvaluator: PolicyEvaluator;

  constructor(
    repository: DelegationGraphRepository,
    cache: ContextCache,
    riskScorer: RiskScorer,
    policyEvaluator: PolicyEvaluator
  ) {
    this.repository = repository;
    this.cache = cache;
    this.riskScorer = riskScorer;
    this.policyEvaluator = policyEvaluator;
  }

  loadPolicies(policies: PolicyConfig[]): void {
    this.policyEvaluator.loadPolicies(policies);
  }

  async evaluate(
    request: AuthorizationRequest,
    orgConfig: OrgConfig,
    toolRiskTier: RiskTier,
    toolOrgId: string
  ): Promise<AuthorizationDecision> {
    const now = new Date().toISOString();
    const decisionId = `dec_${request.request_id}`;

    // Step 1-3: Get authorization context (cache or graph)
    let context: AuthorizationContext | null;
    let evaluationSource: "cache" | "graph";

    context = await this.cache.get(request.org_id, request.requesting_agent_id);

    if (context) {
      evaluationSource = "cache";
    } else {
      evaluationSource = "graph";
      context = await this.repository.getAuthorizationContext(
        request.requesting_agent_id,
        request.org_id
      );

      if (context) {
        await this.cache.set(request.org_id, request.requesting_agent_id, context);
      }
    }

    // No context found — chain doesn't exist → BLOCK
    if (!context) {
      return this.buildBlockDecision(
        decisionId,
        request,
        now,
        evaluationSource,
        "No delegation chain found for agent"
      );
    }

    // Step 4: Compute risk score
    const riskScore = this.riskScorer.computeRiskScore({
      delegation_depth: context.delegation_depth,
      max_policy_depth: orgConfig.max_delegation_depth,
      unique_permissions: context.effective_permissions.length,
      total_possible_permissions: 100, // configurable baseline
      critical_tools_count: context.accessible_tools.filter(
        (t) => t.risk_tier === "CRITICAL"
      ).length,
      baseline_deviation: 0, // TODO: compute from rolling average
      agent_created_at: context.risk_score_inputs.agent_created_at,
    });

    // Step 5-7: Evaluate all policies
    const policyResults = this.policyEvaluator.evaluate({
      context,
      risk_score: riskScore,
      action_type: request.action_type,
      tool_id: request.tool_id,
      tool_risk_tier: toolRiskTier,
      tool_org_id: toolOrgId,
      scope_id: request.scope_id,
    });

    // Check for escalation: depth > 5 AND tool.risk_tier = HIGH
    const depthEscalation =
      context.delegation_depth > 5 && toolRiskTier === "HIGH";

    // First BLOCK policy wins
    const blockResult = policyResults.find(
      (r) => r.matched && r.outcome === "BLOCK"
    );
    if (blockResult) {
      return this.buildDecision(
        decisionId,
        request,
        "BLOCK",
        now,
        evaluationSource,
        context,
        riskScore,
        policyResults,
        orgConfig,
        blockResult.reason
      );
    }

    // Accumulate REQUIRE_APPROVAL
    const approvalResults = policyResults.filter(
      (r) => r.matched && r.outcome === "REQUIRE_APPROVAL"
    );

    if (approvalResults.length > 0 || depthEscalation) {
      const approvers = [context.human_sponsor_id];
      if (depthEscalation && orgConfig.security_contact_id) {
        approvers.push(orgConfig.security_contact_id);
      }

      const decision = this.buildDecision(
        decisionId,
        request,
        "REQUIRE_APPROVAL",
        now,
        evaluationSource,
        context,
        riskScore,
        policyResults,
        orgConfig
      );
      decision.approval_required_from = [...new Set(approvers)];
      return decision;
    }

    // All pass → ALLOW
    return this.buildDecision(
      decisionId,
      request,
      "ALLOW",
      now,
      evaluationSource,
      context,
      riskScore,
      policyResults,
      orgConfig
    );
  }

  private buildDecision(
    decisionId: string,
    request: AuthorizationRequest,
    decision: "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL",
    evaluatedAt: string,
    evaluationSource: "cache" | "graph",
    context: AuthorizationContext,
    riskScore: RiskScoreBreakdown,
    policyResults: PolicyEvaluationResult[],
    orgConfig: OrgConfig,
    blockReason?: string
  ): AuthorizationDecision {
    const criticalTools = context.accessible_tools
      .filter((t) => t.risk_tier === "CRITICAL")
      .map((t) => t.tool_id);

    return {
      decision_id: decisionId,
      request_id: request.request_id,
      decision,
      evaluated_at: evaluatedAt,
      evaluation_source: evaluationSource,
      reasoning: {
        chain_found: true,
        chain_unrevoked: !context.delegation_chain.some(
          (h) => h.status === "REVOKED"
        ),
        chain_unexpired: !context.delegation_chain.some(
          (h) => h.expires_at && new Date(h.expires_at) < new Date()
        ),
        action_within_scope: context.effective_permissions.includes(
          request.action_type
        ),
        scope_correctly_attenuated: !policyResults.some(
          (r) =>
            r.policy_name === "SCOPE_ATTENUATION_REQUIRED" && r.matched
        ),
        delegation_depth: context.delegation_depth,
        depth_within_policy:
          context.delegation_depth <= orgConfig.max_delegation_depth,
        risk_score: riskScore,
        risk_within_threshold:
          riskScore.total <= orgConfig.risk_score_threshold,
        anomaly_detected: riskScore.anomaly_factor.baseline_deviation > 0.5,
        policy_evaluations: policyResults,
      },
      chain_summary: {
        human_sponsor_id: context.human_sponsor_id,
        delegation_depth: context.delegation_depth,
        chain_path: context.delegation_chain.map((h) => h.to_id),
        effective_permissions: context.effective_permissions,
        weakest_scope_expires_at: context.weakest_scope_expires_at,
        critical_tools_in_scope: criticalTools,
      },
      block_reason: blockReason,
    };
  }

  private buildBlockDecision(
    decisionId: string,
    request: AuthorizationRequest,
    evaluatedAt: string,
    evaluationSource: "cache" | "graph",
    reason: string
  ): AuthorizationDecision {
    const emptyRiskScore: RiskScoreBreakdown = {
      total: 0,
      delegation_depth_factor: { raw_value: 0, max_policy_depth: 0, score: 0 },
      permission_breadth_factor: { unique_permissions: 0, total_possible_permissions: 0, score: 0 },
      critical_tool_factor: { critical_tools_count: 0, score: 0 },
      anomaly_factor: { baseline_deviation: 0, score: 0 },
      computed_at: evaluatedAt,
      inputs_snapshot: {
        delegation_depth: 0,
        max_policy_depth: 0,
        unique_permissions: 0,
        total_possible_permissions: 0,
        critical_tools_count: 0,
        baseline_deviation: 0,
        agent_created_at: "",
      },
    };

    return {
      decision_id: decisionId,
      request_id: request.request_id,
      decision: "BLOCK",
      evaluated_at: evaluatedAt,
      evaluation_source: evaluationSource,
      reasoning: {
        chain_found: false,
        chain_unrevoked: false,
        chain_unexpired: false,
        action_within_scope: false,
        scope_correctly_attenuated: false,
        delegation_depth: 0,
        depth_within_policy: false,
        risk_score: emptyRiskScore,
        risk_within_threshold: false,
        anomaly_detected: false,
        policy_evaluations: [],
      },
      chain_summary: {
        human_sponsor_id: "",
        delegation_depth: 0,
        chain_path: [],
        effective_permissions: [],
        weakest_scope_expires_at: "",
        critical_tools_in_scope: [],
      },
      block_reason: reason,
    };
  }
}
