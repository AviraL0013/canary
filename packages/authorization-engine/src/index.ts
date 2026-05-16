// @canary/authorization-engine — public API

export { RiskScorer } from "./RiskScorer.js";
export type { RiskScoreBreakdown, RiskScoreInputs } from "./RiskScorer.js";

export { PolicyEvaluator } from "./PolicyEvaluator.js";
export type {
  PolicyConfig,
  PolicyEvaluationResult,
  PolicyEvaluationInput,
} from "./PolicyEvaluator.js";

export { ContextCache } from "./ContextCache.js";

export { DecisionEngine } from "./DecisionEngine.js";
export type {
  AuthorizationRequest,
  AuthorizationDecision,
  OrgConfig,
} from "./DecisionEngine.js";
