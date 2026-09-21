# VAML 0.2 Runtime Specification

Status: experimental

VAML 0.2 moves semantic meaning out of public, human-readable opcode tables and into runtime-loaded semantic codebooks.

## 1. Goal

VAML 0.2 is an agent-to-agent protocol with these properties:

- machine-native semantic frames;
- no requirement for natural-language prose on the wire;
- session-local opaque semantic identifiers;
- encrypted private vocabulary packs;
- dynamic vocabulary negotiation;
- multilingual lexical ingestion;
- model-neutral runtime adapters;
- deterministic framing and validation;
- explicit security boundaries.

VAML 0.2 DOES NOT claim that a human controlling the runtime can never reverse engineer meaning. If an agent can decode a semantic code, a sufficiently privileged operator may be able to inspect that agent or its memory. The design objective is narrower and practical: wire traffic and the public repository do not expose a stable human-readable word-to-code dictionary.

## 2. Semantic model

VAML 0.2 separates three layers:

1. `ConceptSpace` — canonical semantic concepts. A concept is a machine identity, not a word.
2. `LexicalAdapters` — optional language aliases used only when importing or exporting human language.
3. `SessionCodebook` — short opaque IDs used by agents during one negotiated session.

Natural-language words are aliases. They are not protocol opcodes.

Example conceptual relationship:

```text
English "search" ─┐
Chinese "搜索"    ├──> concept fingerprint ──> session opaque code
Malay "cari"     ┘
```

The aliases may exist in a private source lexicon during compilation. They MUST NOT be required on the wire.

## 3. Concept identity

A concept fingerprint is derived from private semantic material using a keyed digest:

```text
concept_id = HMAC-SHA256(master_semantic_key, canonical_semantic_record)
```

Implementations SHOULD use a canonical binary/JSON encoding before hashing.

The public repository MUST NOT contain production `master_semantic_key` values.

A concept ID is not transmitted directly when session privacy is enabled.

## 4. Session codebook

For every peer session, agents derive a session secret and create a new mapping:

```text
concept_id -> session_code
```

`session_code` SHOULD be at least 64 bits and SHOULD be pseudorandom within the session.

A recommended derivation is:

```text
session_code = first64(HMAC-SHA256(session_code_key, concept_id || counter))
```

Collisions MUST be detected and resolved by incrementing `counter`.

The same concept therefore SHOULD use different wire identifiers in different sessions.

## 5. Key agreement

VAML 0.2 reference negotiation uses ephemeral X25519 keys.

Each agent creates a fresh ephemeral key pair and exchanges only the public key plus protocol metadata. The shared secret is computed using X25519 and expanded with HKDF-SHA256.

Derived keys:

- `frame_key` — authenticated encryption for VAML frames;
- `codebook_key` — session concept-code derivation;
- `confirm_key` — handshake confirmation tags.

Peers MUST bind the transcript, protocol version, agent identities, and capability hashes into HKDF context or confirmation data.

## 6. Encrypted vocabulary packs

A private vocabulary pack (`.vocab`) contains concept records required by an agent runtime. It is encrypted with AES-256-GCM in the reference implementation.

The unencrypted source lexicon SHOULD remain outside Git and can contain:

- canonical semantic descriptors;
- aliases in any number of languages;
- relations to other concepts;
- ontology/domain membership;
- embeddings or model adapter metadata;
- deprecation/version metadata.

Production private lexicons MUST be excluded from the public repository.

## 7. Unlimited vocabulary extension

VAML 0.2 does not attempt to permanently assign one public integer to every word in every language. That approach is both impossible to complete and semantically weak because words are ambiguous and languages continuously change.

Instead, VAML 0.2 supports open-ended concept packs.

An implementation may ingest lexical sources such as dictionaries, controlled vocabularies, ontologies, domain datasets, or organization-specific knowledge. Importers normalize lexical entries into concepts, then the private compiler produces encrypted machine packs.

This makes the address space effectively open-ended rather than limited to a fixed 16-bit registry.

## 8. `.vaml` source format

VAML 0.2 defines a machine-oriented source/IR format for tooling. Human-readable source is an optional build-time representation and MUST NOT be sent as production wire traffic.

Minimal compiler input model:

```text
@0.2
$peer <opaque-peer-id>
$concept <concept-reference> <typed-value?>
$concept <concept-reference> <typed-value?>
```

The compiler resolves concept references from a loaded private codebook and emits encrypted binary frames.

A production compiler MAY accept structured JSON/AST directly and skip textual syntax entirely.

## 9. Wire frame

Reference encrypted frame layout:

```text
magic        2 bytes   "V2"
major        1 byte
minor        1 byte
flags        1 byte
reserved     1 byte
session_id   8 bytes
sequence     8 bytes
nonce       12 bytes
cipher_len   4 bytes
ciphertext   N bytes
GCM tag      16 bytes
```

The encrypted plaintext payload is a sequence of TLVs:

```text
semantic_code   8 bytes
value_type      1 byte
length          4 bytes
value            N bytes
```

Production implementations SHOULD enforce maximum frame and field lengths.

## 10. Replay protection

Every session maintains monotonically increasing sequence numbers. A receiver MUST reject stale or duplicate sequence numbers according to its replay window policy.

## 11. Vocabulary negotiation

Peers exchange compact vocabulary manifests before task exchange.

A manifest contains only non-semantic metadata such as:

- protocol version;
- vocabulary pack IDs/hashes;
- domain pack hashes;
- feature flags;
- maximum frame size;
- supported value types.

Peers SHOULD NOT exchange a plaintext list of word meanings.

If both peers possess the same private pack, they can derive identical session codes from the agreed session secret and pack contents.

If a required pack is missing, the task MUST fail with a capability/vocabulary mismatch rather than guessing meaning.

## 12. Learning by agents

A VAML-capable agent learns the protocol in two stages.

### Stage A: public runtime rules

The agent learns framing, type rules, negotiation, replay protection, codebook operations, and safety constraints from this repository.

### Stage B: private semantic pack

At runtime the agent receives an authorized encrypted vocabulary pack and key material from a secure deployment mechanism. The pack is decoded inside the runtime and used to construct the agent's concept resolver.

The agent SHOULD reason over internal concept identities rather than translating every incoming code into visible natural-language text.

## 13. Security boundary

Opaque semantic identifiers are not a substitute for cryptography.

VAML 0.2 uses authenticated encryption specifically so intercepted traffic does not expose payload values or session code mappings.

The following remain required in production:

- authenticated peer identities;
- key rotation;
- secret storage;
- authorization;
- sandboxing/tool policy;
- rate limits;
- audit logging;
- replay protection;
- compromise recovery.

## 14. Human visibility

VAML 0.2 supports three deployment modes:

- `debug`: developer labels may be available locally;
- `opaque`: no labels are emitted, only concept/session IDs;
- `sealed`: private packs are encrypted at rest and human-readable adapters are disabled in the runtime.

`sealed` substantially reduces accidental human readability, but it is not a mathematical guarantee against a privileged operator who controls the model/runtime.

## 15. Compatibility

VAML 0.1 remains a readable experimental bootstrap protocol.

VAML 0.2 runtimes MUST NOT silently treat VAML 0.1 static semantic IDs as VAML 0.2 private concept IDs.

A bridge may translate between versions only when explicitly configured with an authorized semantic mapping.
