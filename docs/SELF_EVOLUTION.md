# Autonomy & Self-Evolution Layer

This document covers the second layer of the runtime: the subsystems that
let it operate autonomously over long horizons — deterministic self-healing,
cross-session maintenance, verification gates, execution boundaries, and a
**guarded** self-evolution loop. It implements the operational blueprint for
autonomous self-evolving agent frameworks (deterministic routing, mutation-
guided validation, companion monitoring, sandbox boundaries, secured
evolution) as concrete, tested modules.

The central design bet: **capability lives in the harness, not the model.**
Every subsystem here is deterministic infrastructure around the LLM, which is
why a cheaper model plugged into the `Provider` interface still yields a
reliable system — the harness routes, verifies, remembers, bounds, and
audits regardless of how smart the model is.

## 1. Deterministic control plane — `agi/routing/`

`SelfHealingRouter` models the tool-use plan as a cost-weighted directed
graph. Failures are handled without the model:

- A failed step sets its edge cost to ∞ and Dijkstra recomputes the
  shortest remaining path in microseconds.
- The LLM escalation callback fires **only** when no feasible path remains
  (`stats.reroutes` vs `stats.escalations` quantifies the savings).
- `AttentionMonitor` runs cheap regex/predicate matchers that assign
  priority scores to runtime signals, so a `database timeout` (0.99)
  preempts routine intent (0.5) without a model call.

## 2. Maintenance plane — `agi/monitoring/`

`CompanionRuntime` (VIGIL-style) runs beside execution, never inside it:

- Subscribes to the event bus and appraises task outcomes into a bounded
  signal bank (`{ts, emotion, intensity, valence, cause, episode}`).
- `driftReport()` compares the older half of the recent window against the
  newer half, surfacing error-rate and latency drift that single-session
  monitors structurally miss.
- `report()` emits a Roses/Buds/Thorns diagnostic; recurring failures
  become thorns.
- `proposeRemediations()` converts thorns into evolution **proposals** —
  the companion has no authority to commit anything. Diagnosis and commit
  live in separate planes by construction.

## 3. Verification gates — `agi/verification/`

Two independent oracles break the "cycle of self-deception" where generated
code is validated by generated tests that share its blind spots:

- **Property-based testing** (`property-testing.js`): `forAll(generators,
  property)` falsifies behavioral invariants over seeded adversarial inputs
  and greedily shrinks failures to the *minimal* counterexample.
- **Mutation-guided validation** (`mutation-testing.js`): coverage is a weak
  proxy for fault detection, so test suites are scored by **mutant kill
  rate**. Single-fault semantic mutants (operator swaps, boundary shifts,
  off-by-one constants) are generated, non-compilable ones discarded, and a
  suite must kill ≥ `evolution.minMutationScore` (default 0.6) of them.
  Note: equivalent mutants (e.g. `<` vs `<=` in a `min()`) survive any
  suite; the threshold, not 1.0, accounts for this.

## 4. Execution boundaries — `agi/security/execution-boundaries.js`

Blast-radius controls that hold even outside a container:

- **Multi-level timeouts**: tool-level (`tools.timeoutMs`, default 30s,
  enforced inside the registry) and loop-level (`agentDefaults.maxDurationMs`,
  default 20min, enforced in the agent's run loop) — both independent of the
  step budget.
- **Default-deny egress**: `EgressPolicy` allows only explicit hostnames
  (`api.example.com`) or subdomain wildcards (`*.trusted.dev`);
  `guardedFetch()` wraps fetch and audits every block.
- **Workspace confinement**: `WorkspaceBoundary.resolve()` rejects any path
  that escapes the workspace root (`../../etc/passwd` → `PATH_ESCAPE`).

## 5. Guarded self-evolution — `agi/evolution/`

The engine is deliberately **evolution-augmented, not evolution-native**:
the system may propose changes to its skills and adaptive prompt sections,
but the pipeline that judges those changes is out of its reach.

```
propose ──> threat scan ──> independent evaluation ──> policy ──> human approval ──> commit
   │             │                   │                                                │
   │             │                   │                                                └─ hash-chained lineage + rollback
   │             │                   └─ compile + test suite + mutant kill rate + property invariants
   │             └─ injection phrases, exec primitives, exfiltration, self-elevation patterns
   └─ agents, companion runtime, or humans
```

How each classic self-evolution failure mode is addressed:

| Threat | Countermeasure |
|--------|----------------|
| Optimizer-optimizee collapse | `protectedTargets` — proposals against policy, RBAC, audit, approvals, verification, egress, or the engine itself are rejected at proposal time. The optimizer can never rewrite its own evaluator. |
| Lamarckian propagation | Content is threat-scanned before evaluation; injection phrases and exec/exfiltration primitives acquired mid-session cannot be encoded into prompts or skills. |
| Evolutionary hijacking | Evaluators are fixed at construction; every commit is policy-gated (high risk ⇒ human approval under the default pack) and recorded in a hash-chained lineage (`verifyLineage()`), with `rollback(generation)` for recovery. |
| Silent regression | Skills without a test suite fail evaluation outright; suites below the mutant kill threshold fail; declared property invariants are falsified adversarially before commit. |

Committed prompt sections land in `evolution.promptSections`, which flows
into every agent's system prompt as clearly-labeled "adaptive guidance".
Committed skills land in **procedural memory** (`memory.procedural`) with
versioning, per-skill reliability stats, and history — completing the
Tulving-style taxonomy (semantic / episodic / procedural + working buffer).

## What is deliberately NOT in-process

Honesty about scope — these blueprint items need external infrastructure and
are exposed as integration seams rather than imitated in-process:

| Blueprint item | Status | Seam |
|----------------|--------|------|
| Formal SMT verification (Dafny-class contracts) | Not in-process — a JS runtime cannot fake a theorem prover | Add a verifier as an `EvolutionEngine` evaluation check calling an external Dafny/Z3 service |
| Surrogate execution environments (learned world models) | Not in-process | Implement as a `Provider` used by a "simulation" tool; commit gates still require real execution |
| Container/VM isolation (non-root, read-only mounts, Firecracker) | Deployment concern | Run this process inside the container; in-process boundaries above still apply as defense-in-depth |
| WORM audit storage | Approximated | Audit log is hash-chained and append-only (`AGI_AUDIT_FILE`); point it at write-once storage for true WORM |
| CodeAct (code-as-action) execution | Intentionally not enabled | Arbitrary code execution as the action interface conflicts with default-deny governance; skills go through the evolution pipeline instead |

## Cheap-model doctrine

To run this harness with a small/cheap model:

1. Keep `maxSteps` low and let the router, not the model, handle recovery.
2. Register narrow, well-described tools — schema validation catches weak
   models' malformed calls, and the denial observations steer them.
3. Let procedural memory accumulate verified skills so the model recalls
   working routines instead of re-deriving them.
4. Let the companion runtime convert recurring failures into adaptive
   prompt guidance (each one human-approved) — the system gets more reliable
   over time without touching model weights.
5. Reserve a stronger model for the escalation callback if desired — the
   two-tier setup (cheap model in the loop, strong model on `no_feasible_path`)
   is directly supported by the `Provider` abstraction.
