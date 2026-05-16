// PolicyEvaluator — evaluates 7 built-in policies against authorization context
// First BLOCK wins. All REQUIRE_APPROVAL accumulate.
// Policies are org-scoped and evaluated in priority order.

import type { AuthorizationContext } from "@canary/graph-core";
import type { RiskScoreBreakdown } from "./RiskScorer.js";
import type { RiskTier } from "@canary/event-schema";

export interface PolicyConfig {
  policy_id: string;
  policy_type: string;
  config_json: Record<string, unknown>;
  enabled: boolean;
}

export interface PolicyEvaluationResult {
  policy_id: string;
  policy_name: string;
  matched: boolean;
  outcome: "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL" | "SKIP";
  reason: string;
  evaluated_inputs: Record<string, unknown>;
}

export interface PolicyEvaluationInput {
  context: AuthorizationContext;
  risk_score: RiskScoreBreakdown;
  action_type: string;
  tool_id: string;
  tool_risk_tier: RiskTier;
  tool_org_id: string;
  scope_id: string;
}

export class PolicyEvaluator {
  private policies: PolicyConfig[] = [];

  loadPolicies(policies: PolicyConfig[]): void {
    this.policies = policies.sort((a, b) =>
      a.policy_id.localeCompare(b.policy_id)
    );
  }

  evaluate(input: PolicyEvaluationInput): PolicyEvaluationResult[] {
    const results: PolicyEvaluationResult[] = [];

    for (const policy of this.policies) {
      if (!policy.enabled) {
        results.push({
          policy_id: policy.policy_id,
          policy_name: policy.policy_type,
          matched: false,
          outcome: "SKIP",
          reason: "Policy disabled",
          evaluated_inputs: {},
        });
        continue;
      }

      const result = this.evaluatePolicy(policy, input);
      results.push(result);
    }

    return results;
  }

  private evaluatePolicy(
    policy: PolicyConfig,
    input: PolicyEvaluationInput
  ): PolicyEvaluationResult {
    switch (policy.policy_type) {
      case "MAX_DELEGATION_DEPTH":
        return this.evalMaxDepth(policy, input);
      case "SCOPE_ATTENUATION_REQUIRED":
        return this.evalScopeAttenuation(policy, input);
      case "EXPIRED_DELEGATION_BLOCK":
        return this.evalExpiredDelegation(policy, input);
      case "REVOKED_DELEGATION_BLOCK":
        return this.evalRevokedDelegation(policy, input);
      case "CRITICAL_TOOL_REQUIRE_APPROVAL":
        return this.evalCriticalTool(policy, input);
      case "HIGH_RISK_SCORE_ESCALATION":
        return this.evalHighRiskScore(policy, input);
      case "CROSS_ORG_BLOCK":
        return this.evalCrossOrg(policy, input);
      default:
        return {
          policy_id: policy.policy_id,
          policy_name: policy.policy_type,
          matched: false,
          outcome: "SKIP",
          reason: `Unknown policy type: ${policy.policy_type}`,
          evaluated_inputs: {},
        };
    }
  }

  // POLICY_001: MAX_DELEGATION_DEPTH
  private evalMaxDepth(
    policy: PolicyConfig,
    input: PolicyEvaluationInput
  ): PolicyEvaluationResult {
    const threshold = (policy.config_json["threshold"] as number) ?? 5;
    const depth = input.context.delegation_depth;
    const matched = depth > threshold;
    return {
      policy_id: policy.policy_id,
      policy_name: "MAX_DELEGATION_DEPTH",
      matched,
      outcome: matched ? "BLOCK" : "ALLOW",
      reason: matched
        ? `Delegation depth ${depth} exceeds maximum ${threshold}`
        : `Delegation depth ${depth} within limit ${threshold}`,
      evaluated_inputs: { depth, threshold },
    };
  }

  // POLICY_002: SCOPE_ATTENUATION_REQUIRED
  private evalScopeAttenuation(
    policy: PolicyConfig,
    input: PolicyEvaluationInput
  ): PolicyEvaluationResult {
    // Check each hop's permissions are subset of parent
    const chain = input.context.delegation_chain;
    let attenuationViolation = false;
    let violationDetail = "";

    for (let i = 1; i < chain.length; i++) {
      const parentPerms = new Set(chain[i - 1]?.inherited_permissions ?? []);
      const childPerms = chain[i]?.inherited_permissions ?? [];
      const overInherited = childPerms.filter((p) => !parentPerms.has(p));
      if (overInherited.length > 0) {
        attenuationViolation = true;
        violationDetail = `Hop ${i}: permissions [${overInherited.join(", ")}] not in parent scope`;
        break;
      }
    }

    // Escalation: scope_attenuation_detected AND critical_tool → BLOCK
    if (attenuationViolation && input.tool_risk_tier === "CRITICAL") {
      return {
        policy_id: policy.policy_id,
        policy_name: "SCOPE_ATTENUATION_REQUIRED",
        matched: true,
        outcome: "BLOCK",
        reason: `Privilege escalation detected with critical tool: ${violationDetail}`,
        evaluated_inputs: { violation: violationDetail, tool_risk_tier: input.tool_risk_tier },
      };
    }

    return {
      policy_id: policy.policy_id,
      policy_name: "SCOPE_ATTENUATION_REQUIRED",
      matched: attenuationViolation,
      outcome: attenuationViolation ? "BLOCK" : "ALLOW",
      reason: attenuationViolation
        ? `Scope attenuation violation: ${violationDetail}`
        : "Scope correctly attenuated at all hops",
      evaluated_inputs: { chain_length: chain.length },
    };
  }

  // POLICY_003: EXPIRED_DELEGATION_BLOCK
  private evalExpiredDelegation(
    policy: PolicyConfig,
    input: PolicyEvaluationInput
  ): PolicyEvaluationResult {
    const now = new Date();
    const expiredHop = input.context.delegation_chain.find(
      (hop) => hop.expires_at && new Date(hop.expires_at) < now
    );
    const matched = !!expiredHop;
    return {
      policy_id: policy.policy_id,
      policy_name: "EXPIRED_DELEGATION_BLOCK",
      matched,
      outcome: matched ? "BLOCK" : "ALLOW",
      reason: matched
        ? `Expired delegation in chain: ${expiredHop?.from_id} → ${expiredHop?.to_id}`
        : "No expired delegations in chain",
      evaluated_inputs: { checked_at: now.toISOString() },
    };
  }

  // POLICY_004: REVOKED_DELEGATION_BLOCK
  private evalRevokedDelegation(
    policy: PolicyConfig,
    input: PolicyEvaluationInput
  ): PolicyEvaluationResult {
    const revokedHop = input.context.delegation_chain.find(
      (hop) => hop.status === "REVOKED"
    );
    const matched = !!revokedHop;
    return {
      policy_id: policy.policy_id,
      policy_name: "REVOKED_DELEGATION_BLOCK",
      matched,
      outcome: matched ? "BLOCK" : "ALLOW",
      reason: matched
        ? `Revoked delegation in chain: ${revokedHop?.from_id} → ${revokedHop?.to_id}`
        : "No revoked delegations in chain",
      evaluated_inputs: {},
    };
  }

  // POLICY_005: CRITICAL_TOOL_REQUIRE_APPROVAL
  private evalCriticalTool(
    policy: PolicyConfig,
    input: PolicyEvaluationInput
  ): PolicyEvaluationResult {
    const matched = input.tool_risk_tier === "CRITICAL";
    return {
      policy_id: policy.policy_id,
      policy_name: "CRITICAL_TOOL_REQUIRE_APPROVAL",
      matched,
      outcome: matched ? "REQUIRE_APPROVAL" : "ALLOW",
      reason: matched
        ? `Tool ${input.tool_id} has CRITICAL risk tier — requires human approval`
        : `Tool risk tier ${input.tool_risk_tier} does not require approval`,
      evaluated_inputs: { tool_id: input.tool_id, risk_tier: input.tool_risk_tier },
    };
  }

  // POLICY_006: HIGH_RISK_SCORE_ESCALATION
  private evalHighRiskScore(
    policy: PolicyConfig,
    input: PolicyEvaluationInput
  ): PolicyEvaluationResult {
    const threshold = (policy.config_json["threshold"] as number) ?? 750;
    const score = input.risk_score.total;

    // risk_score > 900 → BLOCK pending manual security review
    if (score > 900) {
      return {
        policy_id: policy.policy_id,
        policy_name: "HIGH_RISK_SCORE_ESCALATION",
        matched: true,
        outcome: "BLOCK",
        reason: `Risk score ${score} exceeds 900 — blocked pending manual security review`,
        evaluated_inputs: { score, threshold: 900, escalation: "block" },
      };
    }

    const matched = score > threshold;
    return {
      policy_id: policy.policy_id,
      policy_name: "HIGH_RISK_SCORE_ESCALATION",
      matched,
      outcome: matched ? "REQUIRE_APPROVAL" : "ALLOW",
      reason: matched
        ? `Risk score ${score} exceeds threshold ${threshold}`
        : `Risk score ${score} within threshold ${threshold}`,
      evaluated_inputs: { score, threshold },
    };
  }

  // POLICY_007: CROSS_ORG_BLOCK
  private evalCrossOrg(
    policy: PolicyConfig,
    input: PolicyEvaluationInput
  ): PolicyEvaluationResult {
    const agentOrg = input.context.org_id;
    const toolOrg = input.tool_org_id;
    // If tool_org_id is empty, treat as same org (tool may not have org_id)
    const matched = toolOrg.length > 0 && agentOrg !== toolOrg;
    return {
      policy_id: policy.policy_id,
      policy_name: "CROSS_ORG_BLOCK",
      matched,
      outcome: matched ? "BLOCK" : "ALLOW",
      reason: matched
        ? `Cross-org execution blocked: agent org ${agentOrg} ≠ tool org ${toolOrg}`
        : "Same org execution",
      evaluated_inputs: { agent_org: agentOrg, tool_org: toolOrg },
    };
  }
}
