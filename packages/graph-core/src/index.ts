// @canary/graph-core — public API

export type {
  DelegationGraphRepository,
  CreateDelegationParams,
  CreateInvocationParams,
  RecordToolCallParams,
  RecordActionParams,
  AuditQueryParams,
} from "./repository/DelegationGraphRepository.js";

export { Neo4jDelegationRepository } from "./repository/Neo4jDelegationRepository.js";

export {
  CanaryDelegationCycleError,
  CanaryDepthExceededError,
  CanaryMultipleAuthoritySourcesError,
  CanaryScopeAttenuationError,
  CanaryTemporalAttenuationError,
  CanaryParentAuthorityInvalidError,
} from "./repository/DelegationGraphRepository.js";

export type {
  ChainHop,
  ActionTraceResult,
  AuthorizationContext,
  AuthorizationEvaluationResult,
  AuditQueryResult,
  AuditActionRecord,
  RevocationCascadeResult,
  AgentInventoryRecord,
  DelegationTreeRecord,
} from "./types/results.js";

export { CanaryRevocationError } from "./queries/revocationCascade.js";