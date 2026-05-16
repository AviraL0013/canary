// RiskScorer — deterministic, reproducible risk scoring
// Four factors, 0-1000 total. Every score is auditable.

export interface RiskScoreBreakdown {
  total: number; // 0-1000

  delegation_depth_factor: {
    raw_value: number;
    max_policy_depth: number;
    score: number; // (depth / max_depth) * 300, max 300
  };

  permission_breadth_factor: {
    unique_permissions: number;
    total_possible_permissions: number;
    score: number; // (unique / total) * 250, max 250
  };

  critical_tool_factor: {
    critical_tools_count: number;
    score: number; // critical_tools_count * 50, max 150
  };

  anomaly_factor: {
    baseline_deviation: number; // 0.0 - 1.0
    score: number; // deviation * 300, max 300
  };

  computed_at: string;
  inputs_snapshot: RiskScoreInputs;
}

export interface RiskScoreInputs {
  delegation_depth: number;
  max_policy_depth: number;
  unique_permissions: number;
  total_possible_permissions: number;
  critical_tools_count: number;
  baseline_deviation: number;
  agent_created_at: string;
}

/**
 * Deterministic risk scoring engine.
 *
 * All four factors are explicit, weighted, and auditable.
 * An enterprise security auditor must be able to reproduce
 * any risk score from the inputs logged at decision time.
 *
 * Anomaly baseline: rolling 7-day average of actions per agent.
 * Deviation = abs(current_rate - baseline_rate) / baseline_rate.
 * New agents with < 24h history: anomaly_factor = 0 (no baseline).
 */
export class RiskScorer {
  computeRiskScore(inputs: RiskScoreInputs): RiskScoreBreakdown {
    const now = new Date().toISOString();

    // Factor 1: Delegation depth (max 300)
    const depthScore = Math.min(
      300,
      inputs.max_policy_depth > 0
        ? (inputs.delegation_depth / inputs.max_policy_depth) * 300
        : 0
    );

    // Factor 2: Permission breadth (max 250)
    const breadthScore = Math.min(
      250,
      inputs.total_possible_permissions > 0
        ? (inputs.unique_permissions / inputs.total_possible_permissions) * 250
        : 0
    );

    // Factor 3: Critical tool access (max 150)
    const criticalToolScore = Math.min(150, inputs.critical_tools_count * 50);

    // Factor 4: Anomaly deviation (max 300)
    // New agents (< 24h): anomaly_factor = 0
    const agentAge = inputs.agent_created_at
      ? Date.now() - new Date(inputs.agent_created_at).getTime()
      : 0;
    const isNewAgent = agentAge < 24 * 60 * 60 * 1000;
    const anomalyScore = isNewAgent
      ? 0
      : Math.min(300, inputs.baseline_deviation * 300);

    const total = Math.round(
      depthScore + breadthScore + criticalToolScore + anomalyScore
    );

    return {
      total,
      delegation_depth_factor: {
        raw_value: inputs.delegation_depth,
        max_policy_depth: inputs.max_policy_depth,
        score: Math.round(depthScore),
      },
      permission_breadth_factor: {
        unique_permissions: inputs.unique_permissions,
        total_possible_permissions: inputs.total_possible_permissions,
        score: Math.round(breadthScore),
      },
      critical_tool_factor: {
        critical_tools_count: inputs.critical_tools_count,
        score: Math.round(criticalToolScore),
      },
      anomaly_factor: {
        baseline_deviation: isNewAgent ? 0 : inputs.baseline_deviation,
        score: Math.round(anomalyScore),
      },
      computed_at: now,
      inputs_snapshot: { ...inputs },
    };
  }
}
