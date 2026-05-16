-- Migration 004: approval_requests
CREATE TABLE IF NOT EXISTS approval_requests (
  approval_request_id      TEXT PRIMARY KEY,
  org_id                   TEXT NOT NULL,
  decision_id              TEXT NOT NULL REFERENCES authorization_decisions(decision_id),
  agent_id                 TEXT NOT NULL,
  required_approvers_json  JSONB NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'DENIED', 'AUTO_DENIED')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at              TIMESTAMPTZ,
  resolved_by              TEXT,
  resolution_reason        TEXT
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_org_status
  ON approval_requests (org_id, status);

CREATE INDEX IF NOT EXISTS idx_approval_requests_decision_id
  ON approval_requests (decision_id);

CREATE INDEX IF NOT EXISTS idx_approval_requests_agent_id
  ON approval_requests (agent_id);
