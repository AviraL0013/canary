# Canary Architecture

## Overview

Canary is a graph-aware authorization engine for AI agents and autonomous systems. It tracks delegation chains (Human → Agent → Sub-Agent → Tool → Action) and evaluates authorization decisions with full reasoning traces.

The core insight: **authorization decisions should be aware of HOW authority was delegated — not just WHAT permissions exist.**

## System Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                        Agent Frameworks                        │
│         (LangGraph / CrewAI / OpenAI SDK / Custom)            │
└──────────────┬────────────────────────────┬───────────────────┘
               │ SDK                        │ SDK
               ▼                            ▼
┌──────────────────────┐    ┌──────────────────────────┐
│   Ingestion Service  │    │  Authorization Service   │
│      (port 3001)     │    │      (port 3002)         │
│                      │    │                          │
│  POST /v1/events     │    │  POST /v1/authorize      │
│                      │    │  GET  /v1/health         │
└───────┬──────────────┘    └───────┬──────────────────┘
        │                          │
        ▼                          ▼
┌───────────────┐  ┌────────┐  ┌──────────────────┐
│    Neo4j      │  │ Redis  │  │   PostgreSQL     │
│  (graph)      │  │(cache) │  │  (audit log)     │
└───────────────┘  └────────┘  └──────────────────┘
                                       │
                               ┌───────▼──────────┐
                               │  Audit Service   │
                               │   (port 3003)    │
                               │                  │
                               │ GET /v1/trace    │
                               │ GET /v1/audit    │
                               │ GET /v1/inventory│
                               │ GET /v1/risk     │
                               └──────────────────┘
```

## Key Design Decisions

### Why Neo4j for the Delegation Graph

The delegation graph is inherently a traversal-heavy workload. Authorization decisions require walking variable-length paths (Human → Agent → ... → Tool) with per-edge validation (scope, expiry, revocation status).

Neo4j provides:
- Native graph traversal with O(1) neighbor lookup
- Cypher for expressive path queries with inline filtering
- ACID transactions for atomic revocation cascades

**What would trigger migration**: If read latency at scale exceeds targets despite caching, or if the operational burden of Neo4j outweighs the query expressiveness. Candidate alternative: PostgreSQL with recursive CTEs + materialized adjacency lists.

### Why Redis for Authorization Context Cache

Every authorization request cannot traverse Neo4j live. The p99 target of <50ms on cache hit mandates an in-memory cache layer.

- TTL: 30 seconds (balances freshness vs performance)
- Key namespace: `authz:context:{org_id}:{agent_id}`
- Revocation events immediately invalidate affected cache keys
- Cache miss → fresh graph read → re-cache → evaluate

### Why PostgreSQL for Audit + Decisions

Authorization decisions are append-only audit records. PostgreSQL provides:
- Transactional writes with strong durability guarantees
- JSONB for flexible reasoning/chain storage
- SQL for compliance queries (EU AI Act Article 12)
- No graph traversal needed — queries are by org_id, time range, agent_id

### Why Fail-Closed is Default

Canary is in the critical path of every agent action. If Canary is unavailable:
- **CLOSED (default)**: Return `BLOCK`. Agent execution stops. No unauthorized actions.
- **OPEN (explicit opt-in)**: Execute with `degraded_mode=true`. Security alert emitted. Full local audit log. Synced when available.

Fail-open is an enterprise opt-in because some organizations prefer availability over consistency in their authorization layer. This is explicitly documented and requires security team acknowledgment.

## Consistency Model

Authorization decisions are evaluated against eventually-consistent graph state. Under normal conditions, graph state converges within <100ms of an event being ingested.

Revocations are treated as strongly consistent operations. Upon receiving a `delegation.revoked` event, the ingestion service completes the full transitive cascade (graph write + cache invalidation) before returning a response. Subsequent authorization requests for affected agents will see revoked state immediately.

When graph state is uncertain (cache miss during cascade, Neo4j temporarily unavailable), Canary defaults conservative: the system returns `REQUIRE_APPROVAL` rather than `ALLOW`. `BLOCK` decisions are always based on confirmed state.

This model provides strong revocation guarantees at the cost of occasional false-positive escalations during brief inconsistency windows. For authorization infrastructure, this tradeoff is correct.

## Authorization Decision Flow

```
1. AuthorizationRequest arrives
2. Check Redis cache for AuthorizationContext (agent_id key)
3. Cache HIT → skip to step 5
4. Cache MISS → run QUERY 2 against Neo4j → cache result (TTL 30s)
5. Compute deterministic risk score (4 factors, 0-1000)
6. Evaluate all applicable policies against context
7. First BLOCK policy → return BLOCK with reason
8. Any REQUIRE_APPROVAL → return REQUIRE_APPROVAL
9. All policies pass → return ALLOW
10. Write decision record to PostgreSQL (append-only)
11. Return AuthorizationDecision with full reasoning trace
```

**p99 targets:**
- Cache hit path: <50ms
- Cache miss path: <150ms

## Transitive Revocation Model

When a delegation is revoked:

1. **Graph write (atomic)**: Mark root edge + all descendant INVOKED edges as REVOKED
2. **Cache invalidation**: Delete Redis keys for ALL affected agents
3. **Approval cleanup**: Auto-deny all pending approval requests in subtree
4. **Security alerting**: Detect and flag any post-revocation actions (out-of-order)

This entire flow completes within the ingestion request. If Neo4j write fails, the event is rejected (500) — client retries. **A revocation never partially completes.**

## Risk Scoring

Deterministic, reproducible, auditable. Four factors:

| Factor | Weight | Max Score | Formula |
|--------|--------|-----------|---------|
| Delegation depth | 300 | 300 | (depth / max_depth) × 300 |
| Permission breadth | 250 | 250 | (unique / total) × 250 |
| Critical tool access | 150 | 150 | count × 50 |
| Anomaly deviation | 300 | 300 | deviation × 300 |

New agents (<24h history): anomaly_factor = 0 (no baseline).

## Built-in Policies

| ID | Policy | Action | Default |
|----|--------|--------|---------|
| POLICY_001 | MAX_DELEGATION_DEPTH | BLOCK if depth > threshold | threshold: 5 |
| POLICY_002 | SCOPE_ATTENUATION_REQUIRED | BLOCK if permissions not subset of parent | Always on |
| POLICY_003 | EXPIRED_DELEGATION_BLOCK | BLOCK if any edge expired | Always on |
| POLICY_004 | REVOKED_DELEGATION_BLOCK | BLOCK if any edge revoked | Always on |
| POLICY_005 | CRITICAL_TOOL_REQUIRE_APPROVAL | REQUIRE_APPROVAL if tool.risk_tier = CRITICAL | Always on |
| POLICY_006 | HIGH_RISK_SCORE_ESCALATION | REQUIRE_APPROVAL if score > 750, BLOCK if > 900 | threshold: 750 |
| POLICY_007 | CROSS_ORG_BLOCK | BLOCK if agent.org ≠ tool.org | Always on |

## Reference

The canonical reference for this problem space is [Zanzibar: Google's Consistent, Global Authorization System (2019)](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/).

Canary extends the Zanzibar relationship tuple model with:
- Temporal delegation (TTL on every edge)
- Depth-aware scope attenuation
- Chain-level risk scoring
- Transitive revocation propagation
