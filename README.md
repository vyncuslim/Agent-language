# VAML — Vynalth Agent Machine Language

VAML 0.2 is an experimental machine-native protocol for AI-agent communication. Release `0.2.1-experimental` adds a streaming world-lexicon ingestion layer and an opaque agent-learning layer while keeping the VAML 0.2 wire format compatible.

VAML deliberately avoids a public `word -> opcode` dictionary. Production agents communicate through private concept identities, session-local opaque codes, typed binary fields, and authenticated encryption.

## Architecture

```text
private multilingual lexical / semantic sources
                ↓
      WorldConceptAssembler (streaming)
                ↓
       encrypted vocabulary shards
                ↓
       PrivateSemanticIndex
                ↓
       AgentSemanticLearner
                ↓
      internal private concept state
                ↓
       ephemeral peer negotiation
                ↓
        session-local 64-bit codes
                ↓
      AES-256-GCM VAML frames
                ↓
              peer agent
```

The same private concept receives a fresh wire code in a fresh session.

## “Almost all words in the world” without publishing a readable dictionary

VAML treats **words as aliases** and **meanings as concepts**. A deployment can privately ingest very large multilingual sources, morphology, named entities, scientific terminology, programming concepts, organization terminology, and model-native unlabeled concepts.

The repository does **not** contain the real production lexemes. Instead it contains a scalable ingestion/compiler pipeline. Private input is grouped by a cross-lingual `conceptKey`, streamed into concept records, HMAC-derived into private concept identities, and encrypted into configurable shards.

Default capacity is 50,000 concepts per shard. The protocol does not cap the shard count, so deployments can scale from thousands to millions or more concepts without changing the wire format.

See `spec/WORLD-LEXICON-0.2.md`.

## Agent learning

`AgentSemanticLearner` lets an authorized agent learn over a decrypted `PrivateSemanticIndex` without keeping human labels as its native protocol state. It can resolve exact private concepts, private edge aliases, and embeddings; record concept exposure; learn concept-to-concept associations; and persist opaque learning snapshots.

See `spec/AGENT-LEARNING-0.2.md`.

## Repository layout

```text
AGENTS.md                                      Agent loading/learning contract
vaml.manifest.json                            Machine entrypoint
spec/VAML-0.2.md                              Wire protocol
spec/VOCABULARY-0.2.md                        Private vocabulary architecture
spec/WORLD-LEXICON-0.2.md                     Massive multilingual ingestion design
spec/AGENT-LEARNING-0.2.md                    Agent learning model
sdk/typescript/src/world-lexicon.ts            Streaming concept assembler
sdk/typescript/src/learning.ts                 Opaque learner
sdk/typescript/src/semantic-index.ts           Private semantic index
sdk/typescript/tools/build-world-lexicon.ts    Encrypted world-lexicon shard builder
sdk/typescript/tools/privacy-lint.ts           Public-repository leakage guard
sdk/typescript/examples/agent-pair-demo.ts     Agent A <-> Agent B demo
sdk/typescript/test/                           Runtime and world-lexicon tests
```

## Quick start

```bash
cd sdk/typescript
npm install
npm run check
npm run demo
```

Build ordinary private concept shards:

```bash
VAML_SEMANTIC_KEY=<base64url-32-byte-secret> \
VAML_PACK_KEY=<base64url-32-byte-secret> \
npm run pack -- /secure/private.jsonl /secure/out/vocab
```

Build a very large private multilingual world lexicon. Input must be grouped and sorted by private `conceptKey`:

```bash
VAML_SEMANTIC_KEY=<base64url-32-byte-secret> \
VAML_PACK_KEY=<base64url-32-byte-secret> \
npm run world-pack -- /secure/world.sorted.jsonl /secure/out/world 50000
```

Never commit production source lexicons, decrypted packs, or keys. `.gitignore` and `npm run privacy` are designed to fail if common private artifacts or fixed public word/opcode tables appear in the repository.

## Why no public complete vocabulary table?

Because a public table such as `search = 0x1234` is just a substitution dictionary. Humans can read or reverse it, and the mapping becomes stable across sessions.

VAML instead uses:

- private encrypted concept packs;
- optional model embeddings and semantic records;
- HMAC-derived private concept identities;
- ephemeral X25519 peer negotiation;
- HKDF-SHA256 session keys;
- fresh HMAC-derived 64-bit session codes;
- AES-256-GCM frame encryption;
- sequence-based replay protection.

## Privacy modes

`debug` may render semantics locally for development. `opaque` hides semantics on the wire and in ordinary telemetry. `sealed` additionally avoids ordinary semantic logging and minimizes persistence of decrypted semantic material.

## Security boundary

VAML can keep the production semantic mapping out of a public repository and out of network captures. It cannot mathematically guarantee that a human with full control of the authorized model process, debugger, memory, and decryption keys will never recover meaning.

The accurate goal is **opaque-by-default agent communication**, not a false promise of absolute human incomprehensibility.

## Status

**VAML 0.2.1 — experimental runtime; VAML 0.2 wire-compatible.**
