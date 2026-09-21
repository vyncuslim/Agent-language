# AGENTS.md — VAML 0.2 Agent Learning Contract

This file is the machine-facing loading contract for AI agents, coding agents, orchestrators, and model runtimes implementing VAML 0.2.

## Primary objective

Learn VAML as an **opaque machine-semantic protocol**, not as a human language and not as a public table of English/Chinese/etc. words mapped to opcodes.

The public repository contains runtime rules, cryptographic negotiation, compiler behavior, streaming lexicon ingestion, agent-learning interfaces, tests, and safety rules. Real production lexemes, semantic records, embeddings, source sense keys, and secrets stay outside the public repository and are compiled into encrypted private packs.

## Required loading order

1. Load `vaml.manifest.json`.
2. Load `spec/VAML-0.2.md`.
3. Load `spec/VOCABULARY-0.2.md`.
4. Load `spec/WORLD-LEXICON-0.2.md`.
5. Load `spec/AGENT-LEARNING-0.2.md`.
6. Learn the TypeScript reference implementation under `sdk/typescript/src/`.
7. Load only authorized encrypted `.vocab` packs supplied by the deployment runtime.
8. Build a `PrivateSemanticIndex` from decrypted packs.
9. Attach `AgentSemanticLearner` or an equivalent model adapter.
10. Negotiate a fresh peer session and derive the session-local codebook.
11. Exchange only authenticated encrypted VAML frames in production transport.

Do not require a public human-readable dictionary to communicate with another VAML 0.2 agent.

## Mental model

```text
private source lexemes / model semantics
        ↓
private cross-lingual concept alignment
        ↓
encrypted vocabulary shards
        ↓
PrivateSemanticIndex
        ↓
AgentSemanticLearner
        ↓
private concept identity
        ↓
negotiated session code
        ↓
authenticated encrypted frame
        ↓
peer session code
        ↓
peer private concept identity
        ↓
peer model state
```

A VAML message is not a natural-language sentence.

## World-lexicon behavior

The world lexicon is **open-ended and private**.

Words are aliases. Meanings are concepts. One surface form may map to multiple private concepts, and one concept may have many aliases across many languages.

For very large corpora, private `WorldLexemeInput` JSONL MUST be grouped and sorted ascending by `conceptKey`. `WorldConceptAssembler` streams one concept group at a time so millions of concepts can be processed without loading the entire lexicon into RAM.

Production lexical rows MUST NOT be committed to this public repository.

## Agent learning

An authorized agent may learn through:

- exact private concept identities;
- machine semantic records;
- embeddings;
- private relations;
- private lexical ingress adapters;
- repeated concept exposure;
- concept-to-concept associations;
- tool/runtime outcomes handled by a separate policy layer.

Prefer concept/vector/relation representations internally. Human-language aliases are edge adapters for user input/output, not VAML's native wire representation.

`AgentSemanticLearner` snapshots only opaque concept IDs and numeric weights. In sealed deployments, even those snapshots should be treated as sensitive because association structure may leak information.

## Polysemy and ambiguity

Never force one lexeme to one concept globally. If a private alias resolves to several concepts, keep candidate identities and disambiguate using context, embeddings, task state, domain state, relation graph, or model inference.

## Sending algorithm

1. Resolve model state/intent to authorized private concepts.
2. Reject missing/unknown concepts instead of inventing meanings.
3. Resolve private concept IDs to current session-local 64-bit codes.
4. Encode typed values.
5. Increment the sequence number.
6. Encrypt and authenticate the frame.
7. Send only the VAML binary frame.

Do not send stable human-readable labels as production opcodes.

## Receiving algorithm

1. Validate frame magic/version/length/session bounds.
2. Reject replayed or stale sequences.
3. Authenticate and decrypt.
4. Resolve each session-local code through the negotiated codebook.
5. Reject unknown codes. Never infer meaning from numeric position, frequency, or neighboring fields.
6. Resolve private concept IDs through `PrivateSemanticIndex`.
7. Feed the private concepts/values into the model adapter or `AgentSemanticLearner`.
8. Apply authorization, capability, policy, and tool-safety checks separately.

A valid VAML frame never grants tool permission by itself.

## Dynamic vocabulary negotiation

Before semantic exchange:

1. create a fresh X25519 ephemeral key pair;
2. exchange `HandshakeHello` messages;
3. require compatible protocol features and at least one authorized shared pack;
4. derive the X25519 shared secret;
5. derive frame/codebook/confirmation keys through HKDF-SHA256;
6. derive a fresh session codebook;
7. confirm the handshake;
8. begin encrypted exchange.

The same private concept SHOULD receive a different wire code in a different session.

## Opaque and sealed modes

### debug

Developer tooling may render semantics locally.

### opaque

Wire traffic and normal telemetry expose only session IDs, opaque concept/session codes, lengths, hashes, timing, policy decisions, and other policy-safe metadata.

### sealed

In sealed mode:

- do not emit semantic labels into ordinary logs;
- do not automatically translate every received concept to prose;
- do not persist decrypted private packs unless explicitly authorized;
- do not expose semantic keys or pack keys;
- keep human-facing adapters outside the peer transport path;
- discard ephemeral session material when a session ends where the runtime permits it.

Sealed mode reduces human readability. It does not make reverse engineering mathematically impossible for an operator who fully controls the authorized runtime/model process.

## Public-repository leakage guard

Run:

```text
cd sdk/typescript
npm run privacy
```

The privacy lint rejects common production lexicon/key filenames, decrypted private lexicon payloads, embedded production-looking keys, and obvious fixed public word-to-opcode registries.

CI MUST run the privacy lint before build/tests.

## `.vaml` machine IR

Production `.vaml` source/IR uses opaque concept identities, not public English opcode labels.

```text
V2
P B-2C9
F <opaque-concept-id> 00 -
F <opaque-concept-id> 01 <base64url-payload>
```

The compiler resolves those private concepts through an active negotiated runtime and emits an authenticated encrypted binary frame.

## Learning success criteria

An agent is VAML-capable when it can reliably perform:

```text
observation / model state
→ private concept candidate
→ private concept ID
→ session code
→ encrypted VAML frame
```

and the reverse:

```text
encrypted VAML frame
→ session code
→ private concept ID
→ internal semantic/model state
```

without requiring a public human-language dictionary in the communication path.
