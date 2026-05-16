-- Migration 002: audit_events (append-only)
CREATE TABLE IF NOT EXISTS audit_events (
  event_id      TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  sequence_id   BIGINT NOT NULL,
  timestamp     TIMESTAMPTZ NOT NULL,
  payload_json  JSONB NOT NULL,
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_org_type
  ON audit_events (org_id, event_type);

CREATE INDEX IF NOT EXISTS idx_audit_events_org_seq
  ON audit_events (org_id, sequence_id);

CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp
  ON audit_events (timestamp DESC);

-- Unique constraint ensures idempotent ingestion
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_events_event_id_unique
  ON audit_events (event_id);
