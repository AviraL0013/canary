-- Migration 005: org_config
CREATE TABLE IF NOT EXISTS org_config (
  org_id                 TEXT PRIMARY KEY,
  fail_mode              TEXT NOT NULL DEFAULT 'CLOSED'
    CHECK (fail_mode IN ('CLOSED', 'OPEN')),
  max_delegation_depth   INTEGER NOT NULL DEFAULT 5,
  risk_score_threshold   INTEGER NOT NULL DEFAULT 750,
  security_contact_id    TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default system org
INSERT INTO org_config (org_id, fail_mode, max_delegation_depth, risk_score_threshold)
VALUES ('SYSTEM', 'CLOSED', 5, 750)
ON CONFLICT (org_id) DO NOTHING;
