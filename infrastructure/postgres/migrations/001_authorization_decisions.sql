-- Migration 001: authorization_decisions (append-only)
CREATE TABLE IF NOT EXISTS authorization_decisions (
  decision_id         TEXT PRIMARY KEY,
  request_id          TEXT NOT NULL,
  org_id              TEXT NOT NULL,
  agent_id            TEXT NOT NULL,
  tool_id             TEXT NOT NULL,
  action_type         TEXT NOT NULL,
  decision            TEXT NOT NULL CHECK (decision IN ('ALLOW', 'BLOCK', 'REQUIRE_APPROVAL')),
  reasoning_json      JSONB NOT NULL,
  chain_summary_json  JSONB NOT NULL,
  evaluation_source   TEXT NOT NULL CHECK (evaluation_source IN ('cache', 'graph')),
  evaluated_at        TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_authz_decisions_org_agent
  ON authorization_decisions (org_id, agent_id);

CREATE INDEX IF NOT EXISTS idx_authz_decisions_request_id
  ON authorization_decisions (request_id);

CREATE INDEX IF NOT EXISTS idx_authz_decisions_evaluated_at
  ON authorization_decisions (evaluated_at DESC);
