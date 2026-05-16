-- Migration 003: policies
CREATE TABLE IF NOT EXISTS policies (
  policy_id    TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  policy_type  TEXT NOT NULL,
  config_json  JSONB NOT NULL DEFAULT '{}',
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_policies_org_enabled
  ON policies (org_id, enabled);

-- Seed built-in policies for initial org setup
-- These are inserted per-org by the application on org creation.
-- The 'SYSTEM' org_id represents global defaults loaded at startup.
INSERT INTO policies (policy_id, org_id, policy_type, config_json, enabled) VALUES
  ('POLICY_001', 'SYSTEM', 'MAX_DELEGATION_DEPTH',          '{"threshold": 5}',   TRUE),
  ('POLICY_002', 'SYSTEM', 'SCOPE_ATTENUATION_REQUIRED',    '{}',                 TRUE),
  ('POLICY_003', 'SYSTEM', 'EXPIRED_DELEGATION_BLOCK',      '{}',                 TRUE),
  ('POLICY_004', 'SYSTEM', 'REVOKED_DELEGATION_BLOCK',      '{}',                 TRUE),
  ('POLICY_005', 'SYSTEM', 'CRITICAL_TOOL_REQUIRE_APPROVAL','{}',                 TRUE),
  ('POLICY_006', 'SYSTEM', 'HIGH_RISK_SCORE_ESCALATION',    '{"threshold": 750}', TRUE),
  ('POLICY_007', 'SYSTEM', 'CROSS_ORG_BLOCK',               '{}',                 TRUE)
ON CONFLICT (policy_id) DO NOTHING;
