# Canary 🐤

**Graph-aware authorization engine for AI agents and autonomous systems.**

Canary tracks delegation chains (Human → Agent → Sub-Agent → Tool → Action) and makes deterministic, auditable authorization decisions with full reasoning traces.

## Why Canary

AI agents act on behalf of humans. Today, there's no standard way to answer:

- *"Which human approved this action?"*
- *"Did this agent have permission to call that tool?"*
- *"When we revoke access, does every sub-agent lose access immediately?"*

Canary answers all three with a graph-aware authorization layer that sits between your agent framework and the tools it calls.

## Architecture

```
Agent Framework (LangGraph / CrewAI / OpenAI)
       │
       ▼
   ┌────────┐     ┌──────────────┐     ┌─────────────┐
   │  SDK   │────▶│  Ingestion   │────▶│   Neo4j     │
   │        │     │  (port 3001) │     │  (graph)    │
   │        │     └──────────────┘     └─────────────┘
   │        │                                │
   │        │     ┌──────────────┐     ┌─────────────┐
   │        │────▶│Authorization │◀───▶│   Redis     │
   │        │     │  (port 3002) │     │  (cache)    │
   └────────┘     └──────────────┘     └─────────────┘
                         │
                  ┌──────────────┐     ┌─────────────┐
                  │    Audit     │◀───▶│ PostgreSQL  │
                  │  (port 3003) │     │ (audit log) │
                  └──────────────┘     └─────────────┘
```

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/AviraL0013/canary.git
cd canary
pnpm install

# 2. Build all packages
pnpm --filter @canary/event-schema run build
pnpm --filter @canary/graph-core run build
pnpm --filter @canary/authorization-engine run build
pnpm --filter @canary/sdk run build

# 3. Start infrastructure
docker compose -f infrastructure/docker-compose.yml up -d

# 4. Start services
pnpm --filter @canary/ingestion run dev
pnpm --filter @canary/authorization run dev
pnpm --filter @canary/audit run dev
```

## SDK Usage

```typescript
import { CanarySDK, CanaryBlockedError } from "@canary/sdk";

const canary = new CanarySDK({
  org_id: "org_acme",
  agent_id: "agent_researcher",
});

// Wrap any tool call with authorization
try {
  const result = await canary.authorizeAndExecute({
    tool_id: "tool_web_search",
    action_type: "search",
    scope_id: "scope_research",
    task_id: "task_quarterly_report",
    parameters_hash: "abc123",
    execute: () => webSearchTool.search("Q2 revenue"),
  });
} catch (err) {
  if (err instanceof CanaryBlockedError) {
    console.log("Blocked:", err.decision.block_reason);
    console.log("Chain:", err.decision.chain_summary);
  }
}
```

### Framework Wrappers

```typescript
import { wrapLangGraphTool } from "@canary/sdk";

// LangGraph — zero changes to agent code
const authorizedTool = wrapLangGraphTool(canary, searchTool, {
  tool_id: "tool_search",
  action_type: "search",
  scope_id: "scope_research",
  task_id: "task_123",
});
```

Also ships with `wrapOpenAIFunction()` and `wrapCrewAITool()`.

## Core Concepts

### Delegation Graph

Every authorization decision walks a graph path:

```
Human ──DELEGATED_TO──▶ Agent ──INVOKED──▶ Sub-Agent ──CALLED──▶ Tool ──EXECUTED──▶ Action
```

Each edge carries: permissions, expiry, scope, and status (ACTIVE/REVOKED).

### Risk Scoring

Deterministic 4-factor scoring (0–1000):

| Factor | Max | Formula |
|--------|-----|---------|
| Delegation depth | 300 | (depth / max) × 300 |
| Permission breadth | 250 | (unique / total) × 250 |
| Critical tool access | 150 | count × 50 |
| Anomaly deviation | 300 | deviation × 300 |

### Built-in Policies

| Policy | Action |
|--------|--------|
| MAX_DELEGATION_DEPTH | BLOCK if depth > 5 |
| SCOPE_ATTENUATION_REQUIRED | BLOCK if child has more permissions than parent |
| EXPIRED_DELEGATION_BLOCK | BLOCK if any edge expired |
| REVOKED_DELEGATION_BLOCK | BLOCK if any edge revoked |
| CRITICAL_TOOL_REQUIRE_APPROVAL | REQUIRE_APPROVAL for CRITICAL tools |
| HIGH_RISK_SCORE_ESCALATION | REQUIRE_APPROVAL > 750, BLOCK > 900 |
| CROSS_ORG_BLOCK | BLOCK if agent org ≠ tool org |

### Transitive Revocation

When a delegation is revoked, Canary atomically:
1. Marks all downstream edges as REVOKED in Neo4j
2. Invalidates Redis cache for all affected agents
3. Auto-denies pending approval requests
4. Flags post-revocation actions as security alerts

## API Endpoints

### Ingestion Service (`:3001`)
- `POST /v1/events` — Ingest delegation events (Zod-validated, idempotent)

### Authorization Service (`:3002`)
- `POST /v1/authorize` — Evaluate authorization (p99 < 50ms cache hit)
- `GET /v1/health` — Verify Neo4j + Redis + PostgreSQL connectivity

### Audit Service (`:3003`)
- `GET /v1/trace/:action_id` — Full delegation chain trace
- `GET /v1/audit` — Paginated compliance query
- `GET /v1/inventory/agents` — Agent inventory
- `GET /v1/inventory/delegations` — Delegation inventory
- `GET /v1/risk/:agent_id` — Risk score breakdown

## Project Structure

```
canary/
├── packages/
│   ├── event-schema/         # Domain model + Zod validators
│   ├── graph-core/           # Repository interface + Neo4j implementation
│   ├── authorization-engine/ # RiskScorer, PolicyEvaluator, DecisionEngine
│   └── sdk/                  # Client SDK + framework wrappers
├── services/
│   ├── ingestion/            # Event ingestion + revocation cascades
│   ├── authorization/        # Authorization decisions
│   └── audit/                # Compliance queries + tracing
├── infrastructure/
│   ├── docker-compose.yml    # Neo4j + PostgreSQL + Redis
│   ├── neo4j/init.cypher     # Graph schema
│   └── postgres/migrations/  # 5 migration scripts
├── tests/e2e/                # 11-step integration test
└── docs/architecture.md      # Design decisions + consistency model
```

## Design Principles

- **Fail-closed by default** — unknown state → BLOCK
- **No ORM** — raw Cypher, raw SQL, raw Redis commands
- **Append-only audit** — every decision persisted to PostgreSQL
- **Strongly consistent revocation** — cascades complete before response
- **Deterministic scoring** — every risk score reproducible from inputs

## License

MIT
