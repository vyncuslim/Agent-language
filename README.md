# VAML — Vynalth Agent Machine Language

VAML is a machine-native communication language for AI agents.

It is **not designed as a human conversation language**. Agents communicate with stable semantic codes, typed values, state deltas, capabilities, evidence, confidence, constraints, and task contracts. A human-readable vocabulary exists only as a reference/debug layer; the wire representation is intended to be compact and machine-oriented.

## Core idea

Human language:

```text
words -> interpretation -> intent
```

VAML:

```text
semantic code + typed payload -> deterministic meaning -> agent action/state update
```

A message such as:

```text
TASK: search logs for anomalies, high priority, return evidence
```

can be represented on the wire as compact semantic codes rather than prose.

## Repository layout

```text
AGENTS.md                      Instructions for AI agents learning VAML
spec/VAML-0.1.md              Normative protocol specification
spec/grammar.ebnf             Text/IR grammar used for debugging and tooling
registry/vaml-core-0.1.json   Machine-readable core vocabulary registry
examples/training.jsonl       Few-shot learning examples for agents
sdk/python/vaml.py             Minimal encoder/decoder/reference implementation
```

## Design principles

1. **Zero chatter** — no greetings, filler, or conversational politeness is required between agents.
2. **Semantic primitives** — messages are composed from stable concept/opcode IDs.
3. **Typed values** — IDs, numbers, vectors, hashes, references and payloads are explicitly typed.
4. **State deltas** — agents can communicate changes instead of redescribing complete world state.
5. **Belief + evidence** — confidence, claims, provenance and evidence are first-class concepts.
6. **Capability discovery** — agents can advertise, discover and negotiate capabilities.
7. **Contract delegation** — goals, deadlines, budgets, permissions and success criteria can travel with tasks.
8. **Versioned registry** — meanings must not silently change once published.
9. **Model-neutral** — VAML is intended to work across different AI models and agent runtimes.
10. **Security is separate from obscurity** — compact/non-human-readable codes are not encryption. Production transports should still use authenticated encryption, authorization and message integrity.

## Quick start for an AI Agent

An agent should load these files in order:

1. `AGENTS.md`
2. `registry/vaml-core-0.1.json`
3. `spec/VAML-0.1.md`
4. `examples/training.jsonl`

After loading them, the agent should be able to:

- map semantic concepts to VAML codes;
- compose a semantic frame without natural-language filler;
- decode a VAML frame back into an internal task/state representation;
- reject unknown or version-incompatible opcodes safely;
- preserve confidence, evidence, provenance and constraints across delegation.

## Example

Debug/IR view:

```text
FF01 0101 0204 000E 0205 001B 0307 1104 0319 0F1D 0D01 0D04 0C0C 07D0 0303 1101 FF02
```

Conceptual meaning:

```text
BEGIN
TASK
SOURCE agent:14
TARGET agent:27
SEARCH
LOG
FILTER ANOMALY
PRIORITY HIGH
TIMEOUT 2000ms
RETURN EVIDENCE
END
```

The conceptual meaning is for debugging only. Agent-to-agent implementations should operate on structured codes and typed payloads.

## Status

**VAML 0.1 — experimental core specification.**

The 0.1 registry defines the initial core vocabulary. Future versions should extend the language through namespaced domain packs without changing the meaning of published core codes.
