# Canary Concurrency Invariants

## Purpose

This document defines the concurrency guarantees enforced by the Canary delegation graph.

These guarantees are security-critical.

Removing or weakening these controls can produce:
- split-brain authority
- ghost delegations
- stale executable permissions
- duplicate active parents
- revocation bypass races
- inconsistent audit state

The locking and idempotency behavior in the graph layer is intentional and must not be “optimized away”.

---

# Core Security Invariants

## 1. Single Active Authority Source

An agent may have at most ONE active incoming `DELEGATED_TO` edge.

Invariant:

COUNT(ACTIVE incoming DELEGATED_TO edges) <= 1

Why:
- prevents split-brain authority
- prevents ambiguous execution lineage
- ensures deterministic authorization ancestry

Validated by:
- two-parent race tests
- fan-in pressure tests
- burst invocation tests

---

## 2. Revocation Must Cascade Transitively

Revoking upstream authority MUST revoke all downstream delegated authority.

Why:
- prevents stale inherited permissions
- prevents revoked agents from continuing execution
- prevents orphan authority chains

Validated by:
- revoke/delegate race tests
- subtree cascade race tests

---

## 3. Rejected Delegations Must Leave No Residue

Failed delegations must not persist partial graph state.

Why:
- prevents ghost authority
- prevents graph corruption
- prevents future authorization ambiguity

Validated by:
- rejected-edge persistence checks
- fan-in concurrency tests

---

## 4. Event Ingestion Must Be Idempotent

Concurrent submissions of the same event must process exactly once.

Implemented using:
- INSERT-first ownership claim
- PostgreSQL UNIQUE(event_id)
- ON CONFLICT DO NOTHING

Validated by:
- concurrent idempotency tests

---

# Locking Strategy

## Parent Lock Before Child Lock

Delegation writes always lock:
1. parent
2. child

in that order.

Implementation:

SET parent._lock = timestamp()
SET child._lock = timestamp()

The `_lock` property itself is not semantically meaningful.

Its purpose is to force Neo4j write-lock acquisition.

---

## Child Lock Re-Validation

After child lock acquisition, ACTIVE incoming edges are re-checked under lock.

Why:
- prevents TOCTOU races
- guarantees only one surviving active authority source

---

# Revocation Cascade Locking

Revocation cascades immediately lock:
- root agent
- descendant subtree

Why:
- prevents delegation into a subtree mid-revocation
- serializes cascade vs delegation races

---

# Transaction Semantics

## Delegation Writes Are Atomic

Delegation creation:
- validates
- locks
- re-validates
- writes
- commits

as a single transaction.

Partial success is forbidden.

---

## Revocation Is Atomic

Cascade revocation:
- traverses subtree
- revokes edges
- commits

as a single transaction.

Partial subtree revocation is forbidden.

---

# Infrastructure-Level Concurrency Handling

Transient infrastructure conflicts:
- deadlocks
- lock contention
- Neo4j transient tx failures

are treated differently from domain authorization failures.

Domain failures:
- MULTIPLE_ACTIVE_AUTHORITIES
- PARENT_AUTHORITY_INVALID

must NEVER be treated as transient infra retries.

---

# Current Guarantees

The current implementation guarantees:

- deterministic single-parent authority
- revocation consistency
- subtree cascade correctness
- idempotent ingestion
- no dangling rejected edges
- concurrency-safe graph mutation

under concurrent mutation pressure.

---

# Future Work

Recommended future improvements:
- bounded retry loops
- exponential backoff
- jitter
- retryable Neo4j transient failures
- formal verification
- invariant fuzzing

---

# Warning

Do NOT:
- remove lock acquisition
- reorder lock acquisition
- remove re-validation checks
- replace INSERT-first idempotency
- weaken subtree locking

without proving the invariants still hold.

The concurrency model is security-critical infrastructure.