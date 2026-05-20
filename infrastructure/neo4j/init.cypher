// Canary — Neo4j Schema Initialization
// Run once on database startup via neo4j-init container

// ─── Constraints ────────────────────────────────────────────────────────────

CREATE CONSTRAINT human_id_unique IF NOT EXISTS
  FOR (h:Human) REQUIRE h.id IS UNIQUE;

CREATE CONSTRAINT agent_id_unique IF NOT EXISTS
  FOR (a:Agent) REQUIRE a.id IS UNIQUE;

CREATE CONSTRAINT tool_id_unique IF NOT EXISTS
  FOR (t:Tool) REQUIRE t.id IS UNIQUE;

CREATE CONSTRAINT action_id_unique IF NOT EXISTS
  FOR (a:Action) REQUIRE a.id IS UNIQUE;

CREATE CONSTRAINT scope_id_unique IF NOT EXISTS
  FOR (s:DelegationScope) REQUIRE s.id IS UNIQUE;

// ─── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX human_org_idx IF NOT EXISTS
  FOR (h:Human) ON (h.org_id);

CREATE INDEX agent_org_idx IF NOT EXISTS
  FOR (a:Agent) ON (a.org_id);

CREATE INDEX agent_status_idx IF NOT EXISTS
  FOR (a:Agent) ON (a.status);

CREATE INDEX agent_org_status_idx IF NOT EXISTS
  FOR (a:Agent) ON (a.org_id, a.status);

CREATE INDEX tool_risk_idx IF NOT EXISTS
  FOR (t:Tool) ON (t.risk_tier);

CREATE INDEX action_executed_at_idx IF NOT EXISTS
  FOR (ac:Action) ON (ac.executed_at);

CREATE INDEX action_outcome_idx IF NOT EXISTS
  FOR (ac:Action) ON (ac.outcome);

// ─── Relationship property indexes ───────────────────────────────────────────

CREATE INDEX delegated_to_status_idx IF NOT EXISTS
  FOR ()-[r:DELEGATED_TO]-() ON (r.status);

CREATE INDEX delegated_to_expires_idx IF NOT EXISTS
  FOR ()-[r:DELEGATED_TO]-() ON (r.expires_at);

CREATE INDEX delegated_depth_idx IF NOT EXISTS
  FOR ()-[r:DELEGATED_TO]-() ON (r.depth);

CREATE INDEX called_decision_idx IF NOT EXISTS
  FOR ()-[r:CALLED]-() ON (r.authorization_decision_id);

RETURN "Canary Neo4j schema initialized successfully" AS status;
