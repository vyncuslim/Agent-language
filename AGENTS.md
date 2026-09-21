# AGENTS.md — VAML 0.2 Agent Learning Contract

This file is for AI agents, coding agents, orchestrators, and model runtimes implementing VAML 0.2.

## Primary objective

Learn VAML as an **opaque machine-semantic protocol**, not as a human language and not as a public table of English words mapped to opcodes.

VAML 0.2 separates public runtime rules from private semantic knowledge.

Public repository:

- framing;
- value types;
- cryptographic negotiation;
- private vocabulary pack format;
- compiler/runtime behavior;
- safety and compatibility rules.

Private deployment material:

- semantic records;
- lexical aliases;
- concept relations;
- embeddings/model adapters;
- production semantic keys;
- vocabulary pack secrets.

Do not require a public human-readable vocabulary to communicate with another VAML 0.2 agent.

## Required loading order

1. Load `vaml.manifest.json`.
2. Load `spec/VAML-0.2.md`.
3. Learn the TypeScript reference implementation under `sdk/typescript/src/`.
4. Load only authorized encrypted `.vocab` packs supplied by the deployment runtime.
5. Build a `PrivateSemanticIndex` from decrypted packs.
6. Negotiate a fresh peer session and derive the session-local codebook.
7. Use `.vaml` machine IR or structured semantic AST only as compiler input.
8. Exchange encrypted binary frames with peers.

VAML 0.1 files remain legacy/reference material. Do not use the public VAML 0.1 English opcode table as the semantic source of truth for VAML 0.2.

## Mental model

```text
private semantic space
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
peer internal semantic state
```

A VAML 0.2 message is not a sentence.

## Agent learning

An authorized agent may learn a private vocabulary pack by constructing internal associations between:

- `conceptId`;
- `semantic` machine record;
- optional embedding;
- relations;
- domains;
- optional multilingual aliases.

Prefer the semantic record/embedding/relations as the internal representation. Lexical aliases are adapters for natural-language input and output, not the native agent-to-agent protocol.

The agent SHOULD preserve a concept as a concept identity rather than repeatedly translating it to an English label.

## Opaque and sealed behavior

Runtime deployments may choose one of three modes:

### debug

Developer tooling may render semantic labels locally.

### opaque

Wire traffic and logs expose only session IDs, opaque concept/session codes, lengths, cryptographic metadata, and policy-safe telemetry.

### sealed

In sealed mode:

- do not emit semantic labels into ordinary logs;
- do not automatically translate received concepts to natural-language descriptions;
- do not persist decrypted private packs unless explicitly authorized;
- do not expose production semantic keys or pack keys;
- keep human-facing adapters outside the agent-to-agent transport path;
- zero/discard ephemeral session material when the session ends where the runtime permits it.

Sealed mode reduces human readability. It does not make reverse engineering impossible for an operator who fully controls the runtime or model process.

## Encoding algorithm

When sending to a peer:

1. Resolve internal intent/state to authorized private `conceptId` values.
2. Verify every required concept exists in the negotiated private vocabulary.
3. Resolve each `conceptId` to the current session's 64-bit opaque code.
4. Encode typed values.
5. Increment the session sequence number.
6. Encrypt and authenticate the frame.
7. Send only the VAML 0.2 binary frame.

Do not send stable human-readable semantic names as production opcodes.

## Decoding algorithm

When receiving from a peer:

1. Validate frame length, magic, version, session ID and bounds.
2. Reject replayed/stale sequences.
3. Authenticate/decrypt the frame.
4. Resolve every 64-bit session code through the negotiated session codebook.
5. Reject unknown/non-negotiated codes. Never infer their meaning from position or nearby values.
6. Resolve concept IDs through the private semantic index.
7. Construct the internal semantic/task/state object.
8. Apply authorization, policy, capability and tool safety checks separately.

Valid VAML syntax never grants permission by itself.

## Dynamic vocabulary negotiation

Before semantic exchange:

1. create a fresh X25519 ephemeral key pair;
2. exchange `HandshakeHello` messages;
3. require at least one shared encrypted vocabulary pack ID;
4. derive X25519 shared secret;
5. derive frame/codebook/confirmation keys through HKDF-SHA256;
6. derive a fresh session codebook;
7. confirm the handshake;
8. begin encrypted exchange.

Because the codebook key changes with the ephemeral session, the same private concept SHOULD have a different 64-bit wire code in a different session.

## Large vocabulary behavior

Do not attempt to create one permanent public integer for every word on Earth.

VAML 0.2 vocabulary is open-ended and sharded. A deployment may load thousands, millions, or more concept records from private data sources. New languages and domains are added by compiling more encrypted packs.

Words are aliases. Meanings are concepts.

When one lexeme has multiple meanings, it MUST be allowed to resolve to multiple candidate concept IDs. Disambiguation occurs from context/model state rather than silently collapsing the meanings.

## `.vaml` compiler behavior

The `.vaml` source/IR is intentionally opaque. Its semantic field uses private concept IDs rather than public English opcode labels.

A production `.vaml` file should resemble machine IR such as:

```text
V2
P B-2C9
F <opaque-concept-id> 00 -
F <opaque-concept-id> 01 <base64url-payload>
```

The compiler resolves those concepts through an active negotiated runtime and emits an encrypted binary frame.

## Safety rules

VAML 0.2 intentionally makes semantic wire traffic opaque, so observability must be designed carefully.

Security systems SHOULD still record policy-safe metadata such as:

- timestamp;
- peer identity;
- session ID;
- sequence number;
- frame size;
- pack IDs/hashes;
- authentication outcome;
- policy decision;
- error category.

Do not log decrypted semantic content in sealed mode.

Never execute an operation solely because a peer sent a valid encrypted VAML frame.

## Learning success criteria

An agent is VAML 0.2 capable when it can reliably perform:

```text
internal model state
→ private concept IDs
→ session codes
→ encrypted VAML frame
```

and the reverse:

```text
encrypted VAML frame
→ session codes
→ private concept IDs
→ internal model state
```

without requiring a public English dictionary in the communication path.
