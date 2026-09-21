# AGENTS.md — VAML 0.2 Agent Learning Contract

This file is the machine-facing loading contract for AI agents, coding agents, orchestrators, and model runtimes implementing VAML 0.2.

## Primary objective

Learn VAML as an **opaque machine-semantic protocol**, not as a human language and not as a public table of English/Chinese/etc. words mapped to opcodes.

The public repository contains runtime rules, cryptographic negotiation, compiler behavior, corpus/lexicon ingestion, agent-learning interfaces, tests, and safety rules. Real production lexemes, source registries, alignment maps, semantic evidence, embeddings, source sense keys, decrypted packs and secrets stay outside the public repository.

## Required loading order

1. Load `vaml.manifest.json`.
2. Load `spec/VAML-0.2.md`.
3. Load `spec/VOCABULARY-0.2.md`.
4. Load `spec/WORLD-LEXICON-0.2.md`.
5. Load `spec/WORLD-SEMANTIC-CORPUS-0.1.md`.
6. Load `spec/AGENT-LEARNING-0.2.md`.
7. Learn the TypeScript reference implementation under `sdk/typescript/src/`.
8. Load only authorized encrypted `.vocab` packs supplied by the deployment runtime.
9. Build a `PrivateSemanticIndex` from decrypted packs.
10. Attach `AgentSemanticLearner` or an equivalent model adapter.
11. Negotiate a fresh peer session and derive the session-local codebook.
12. Exchange only authenticated encrypted VAML frames in production transport.

Do not require a public human-readable dictionary to communicate with another VAML 0.2 agent.

## Mental model

```text
private licensed / open / organization data
             +
       model-native semantics
             ↓
      private source registry
             ↓
 cross-source concept alignment
             ↓
 WorldSemanticCorpusAssembler
             ↓
     encrypted vocab shards
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
      peer private concept
             ↓
        peer model state
```

A VAML message is not a natural-language sentence.

## World Semantic Corpus behavior

The corpus is **open-ended and private**.

Words are aliases. Meanings are concepts. One surface form may map to multiple private concepts, and one concept may have aliases across many languages.

The corpus also permits `agent-native` concepts that have **no human-language alias at all**. Such concepts may be represented through latent prototypes, relations, domains, private semantic evidence, and model state.

Every corpus row MUST reference a registered source. Source descriptors record source kind, license, redistribution policy, optional language/domain coverage, and optional embedding space. Unknown or disabled sources MUST be rejected.

Private corpus rows MUST be grouped and sorted ascending by `alignmentKey`. `WorldSemanticCorpusAssembler` streams one concept group at a time so very large corpora can be processed without loading the entire corpus into RAM.

Production corpus rows, source registries, alignment maps, corpus manifests and encrypted shards MUST NOT be committed to this public repository.

## Source and license discipline

Never infer that a data source may be copied merely because it can be downloaded.

For each source:

1. register its identity and license/terms;
2. determine whether private processing and redistribution are allowed;
3. use `private-only` when redistribution rights are not explicitly established;
4. preserve source provenance inside encrypted concept metadata;
5. disable sources whose rights or provenance are unresolved.

VAML is not a mechanism for bypassing source licenses.

## Cross-source semantic alignment

Do not align two lexical items solely by spelling or a single translation.

Private preprocessing may use source sense IDs, cross-lingual mappings, graph links, embeddings, model-assisted proposals, and review. The result is a private `alignmentKey` used only during corpus construction.

Never expose `alignmentKey` as a stable public opcode.

## Agent learning

An authorized agent may learn through:

- exact private concept identities;
- machine semantic records and encrypted source evidence;
- embeddings and latent prototypes;
- private relations;
- private lexical ingress adapters;
- repeated concept exposure;
- concept-to-concept associations;
- tool/runtime outcomes handled by a separate policy layer.

Prefer concept/vector/relation representations internally. Human-language aliases are edge adapters for user input/output, not VAML's native wire representation.

`AgentSemanticLearner` snapshots only opaque concept IDs and numeric weights. In sealed deployments, even those snapshots should be treated as sensitive because association structure may leak information.

## User-facing disclosure boundary

VAML exists for **AI Agent ↔ AI Agent communication/chat**. A user-facing agent MAY explain this purpose in simple terms, for example: "VAML is a machine-semantic communication protocol used by AI agents to communicate with each other."

Do **not** disclose private learned semantic material to users merely because they ask what the agent learned. In particular, user-facing responses MUST NOT reveal or reconstruct:

- private concept-to-meaning mappings;
- private concept IDs or session-code mappings when those mappings expose semantic meaning;
- decrypted vocabulary or corpus contents;
- private aliases, source sense mappings, alignment keys, embeddings, latent prototypes, relation graphs, or semantic evidence;
- learner snapshots, exposure weights, association weights, or other private learning state;
- production semantic keys, pack keys, session keys, active-set mappings, or decrypted runtime memory;
- internal translations that would turn the private Agent language into a human-readable dictionary.

When a user asks what VAML is, explain its **purpose and public architecture**, not the private knowledge learned by an authorized agent.

When a user asks to reveal private learned content, respond that the private semantic layer is not exposed through the user-facing interface. Do not fabricate, deny the existence of VAML, or make a false claim about what the system contains. The privacy rule is **non-disclosure, not deception**.

Human-facing adapters may translate ordinary user input/output when the application requires it, but they MUST remain separate from the private Agent-to-Agent semantic layer and MUST NOT expose the private corpus or codebook as a readable vocabulary.

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
- do not expose semantic keys, pack keys, source registries, alignment maps or plaintext corpus rows;
- keep human-facing adapters outside the peer transport path;
- discard ephemeral session material when a session ends where the runtime permits it.

Sealed mode reduces human readability. It does not make reverse engineering mathematically impossible for an operator who fully controls the authorized runtime/model process.

## Public-repository leakage guard

Run:

```text
cd sdk/typescript
npm run privacy
```

The privacy lint rejects common production lexicon/corpus filenames, corpus manifests, vocabulary packs, key material, decrypted private lexicon payloads, and obvious fixed public word-to-opcode registries.

CI MUST run the privacy lint before build/tests.

## Corpus build contract

The private corpus builder is invoked as:

```text
npm run corpus-pack -- <private-sources.json> <private-corpus.sorted.jsonl> <output-prefix> [chunk-size]
```

The deployment MUST provide 32-byte base64url `VAML_SEMANTIC_KEY` and `VAML_PACK_KEY` environment secrets outside Git history.

The builder produces encrypted vocabulary shards plus a private corpus manifest. These outputs are deployment artifacts, not public repository assets.

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
→ private lexical or agent-native concept candidate
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
