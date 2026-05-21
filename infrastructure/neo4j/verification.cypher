// ======================================================
// CANARY GRAPH INTEGRITY VERIFICATION
// ======================================================


// ------------------------------------------------------
// CHECK 1 — MULTIPLE ACTIVE AUTHORITY SOURCES
// Every agent must have ONLY ONE active incoming
// authority edge.
// ------------------------------------------------------

MATCH (a:Agent)<-[r:DELEGATED_TO {status:'ACTIVE'}]-()

WITH a, count(r) AS incoming

WHERE incoming > 1

RETURN
  'MULTIPLE_ACTIVE_PARENTS' AS violation,
  a.id AS agent_id,
  incoming;


// ------------------------------------------------------
// CHECK 2 — CYCLE DETECTION
// Delegation graph must remain acyclic.
// ------------------------------------------------------

MATCH p=(a:Agent)-[:DELEGATED_TO*1..25]->(a)

RETURN
  'CYCLE_DETECTED' AS violation,
  p

LIMIT 1;


// ------------------------------------------------------
// CHECK 3 — INVALID PERMISSION ATTENUATION
// Child permissions must be subset of parent.
// ------------------------------------------------------

MATCH ()-[p:DELEGATED_TO]->(parent:Agent)

MATCH (parent)-[c:DELEGATED_TO]->()

WHERE ANY(
  x IN c.inherited_permissions
  WHERE NOT x IN p.inherited_permissions
)

RETURN
  'INVALID_PERMISSION_ATTENUATION' AS violation,
  parent.id AS parent_agent,
  c.id AS child_edge;


// ------------------------------------------------------
// CHECK 4 — INVALID TEMPORAL ATTENUATION
// Child expiry cannot outlive parent expiry.
// ------------------------------------------------------

MATCH ()-[p:DELEGATED_TO]->(parent:Agent)

MATCH (parent)-[c:DELEGATED_TO]->()

WHERE c.expires_at > p.expires_at

RETURN
  'INVALID_TEMPORAL_ATTENUATION' AS violation,
  parent.id AS parent_agent,
  c.id AS child_edge;


// ------------------------------------------------------
// CHECK 5 — DEPTH VIOLATIONS
// No edge may exceed maximum authority depth.
// ------------------------------------------------------

MATCH ()-[r:DELEGATED_TO]->()

WHERE r.depth > 5

RETURN
  'DEPTH_VIOLATION' AS violation,
  r.id AS edge_id,
  r.depth AS depth;