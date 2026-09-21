# VAML — Vynalth Agent Machine Language

VAML 0.2 is an experimental machine-native protocol for AI-agent communication.

Its production design intentionally avoids a public `word -> opcode` dictionary. Agents communicate through private concept identities, session-local opaque codes, typed binary fields, and authenticated encryption.

## VAML 0.2 architecture

```text
private multilingual / model semantic data
                ↓
       encrypted vocabulary packs
                ↓
      authorized agent semantic index
                ↓
       ephemeral peer negotiation
                ↓
        session-local 64-bit codes
                ↓
      AES-256-GCM binary VAML frames
                ↓
              peer agent
```

The same concept receives a fresh wire code in a fresh session.

## Why there is no public complete vocabulary table

A fixed public table would make the protocol human-readable and would not scale well to the world's languages. VAML 0.2 instead treats words as aliases to semantic concepts and supports open-ended encrypted vocabulary shards.

The reference builder defaults to 50,000 records per shard, so a deployment can ingest very large private concept spaces without changing the wire protocol.

## Repository layout

```text
AGENTS.md                                  Agent learning/runtime contract
vaml.manifest.json                        Machine entrypoint
spec/VAML-0.2.md                          VAML 0.2 protocol specification
spec/VOCABULARY-0.2.md                    Private multilingual vocabulary architecture
sdk/typescript/src/                       TypeScript runtime
sdk/typescript/src/compiler.ts            .vaml machine-IR compiler
sdk/typescript/src/negotiation.ts         X25519/HKDF dynamic codebook negotiation
sdk/typescript/src/runtime.ts             Encrypted frame encoder/decoder
sdk/typescript/src/semantic-index.ts      Agent private semantic index
sdk/typescript/tools/build-private-lexicon.ts  Sharded encrypted vocabulary builder
sdk/typescript/examples/agent-pair-demo.ts     Agent A <-> Agent B demo
sdk/typescript/test/runtime.test.ts       Runtime tests
```

## `.vaml` is machine IR, not English

A VAML 0.2 source frame uses opaque concept identities:

```text
V2
P B-2C9
F <opaque-concept-id> 00 -
F <opaque-concept-id> 01 <base64url-payload>
```

The compiler converts this into an authenticated encrypted binary frame using the active negotiated session codebook.

## Dynamic negotiation

The TypeScript reference runtime uses:

- ephemeral X25519 peer keys;
- HKDF-SHA256 session key derivation;
- a fresh HMAC-derived 64-bit semantic codebook per session;
- AES-256-GCM encrypted frames;
- monotonically increasing sequence numbers for replay protection.

## Large private vocabularies

Production lexical/semantic data should be kept outside this public repository.

The builder accepts private JSONL concept records and produces encrypted `.vocab` shards. Concepts may contain private multilingual aliases, semantic structures, embeddings, relations, and domain metadata. Agents decrypt authorized packs at runtime and build a `PrivateSemanticIndex`.

See `spec/VOCABULARY-0.2.md`.

## Quick start

```bash
cd sdk/typescript
npm install
npm run build
npm run test
npm run demo
```

To build encrypted private vocabulary shards, supply 32-byte base64url secrets through `VAML_SEMANTIC_KEY` and `VAML_PACK_KEY`, then run the `pack` script with a private JSONL source and output prefix.

Do not commit production source lexicons or secrets. `.gitignore` excludes common VAML private vocabulary/key patterns.

## Privacy modes

VAML 0.2 defines `debug`, `opaque`, and `sealed` deployment modes. In sealed mode, semantic labels should not be emitted into ordinary logs and decrypted vocabulary material should remain inside the authorized runtime path.

## Important security boundary

VAML can make public source and wire traffic non-human-readable without exposing the production semantic mapping. It cannot mathematically guarantee that a human with full control of the model process, debugger, memory, and decryption keys will never recover meaning.

This repository therefore aims for **opaque-by-default agent communication**, not a false claim of impossible-to-reverse-engineer secrecy.

## Legacy

VAML 0.1 was a readable experimental bootstrap design. Its public opcode vocabulary is not used as the semantic source of truth for VAML 0.2 and cannot decode VAML 0.2 session traffic.

## Status

**VAML 0.2.0 — experimental runtime.**
