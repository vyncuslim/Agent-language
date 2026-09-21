# VAML — World Concept Space runtime

VAML 0.2 experimental is an opaque Agent-to-Agent machine semantic runtime. It is not a human language or a public word-to-opcode dictionary.

Public protocol rules describe binary framing, data types, negotiation and compiler behavior. Private semantic knowledge stays in authorized encrypted concept packs. Human expressions in Chinese, English, Malay, Japanese or other languages are private ingestion aliases of concepts. A surface form can have multiple senses; several expressions can share one concept.

```text
datasets -> private ingestion / sense alignment -> CONCEPT
        -> secret-derived concept ID -> encrypted vocabulary shards
        -> authorized semantic index -> session-local opaque code
        -> authenticated encrypted frame -> peer's private machine representation
```

## Run and verify

Node.js 20+ is required; CI targets Node 24.

```sh
cd sdk/typescript
npm ci
npm run build
npm test
npm run demo
npm run privacy
```

The demo starts **two independent Node processes** over loopback TCP, generates ephemeral synthetic numeric semantics and secrets, builds encrypted packs in a temporary directory, performs X25519 + HKDF-SHA256 + role-bound PSK confirmation, negotiates an encrypted active set, and exchanges AES-256-GCM frames in both directions. It prints complete frame HEX and verifies that B recovered its private machine representation. Temporary material is removed afterward. No production key or vocabulary is included.

HEX itself is not encryption. Ciphertext can contain arbitrary byte patterns by chance; the protocol never serializes readable semantic opcodes or aliases onto the network.

## Compiler and CLI

After building, use `npm run vaml -- ...`, `node dist/src/cli.js ...`, or install the local bin with `npm link` to expose `vaml`.

```sh
vaml compile input.vaml
vaml inspect input.vaml.compiled.vaml --authorized
vaml pack build /private/input.jsonl --out /private/packs --revision 1
vaml pack verify /private/packs --catalog <pinned-catalog-id> --min-revision 1
vaml run input.vaml --peer 127.0.0.1:7002 --id 01 --vocab /private/packs --catalog <pinned-catalog-id> --min-revision 1
```

Supply 32-byte base64url secrets through `VAML_SEMANTIC_KEY` and `VAML_PACK_KEY` using a private secret manager or protected environment. The builder needs both; receivers need only the pack key and pinned catalog identity/revision. `.env.example` intentionally contains names only. Never put keys in command arguments.

Start B independently:

```sh
node dist/examples/network-agent-b.js --port 7002 --id 02 --peer-id 01 --vocab /private/packs --catalog <pinned-catalog-id> --min-revision 1
node dist/examples/network-agent-a.js input.vaml --peer 127.0.0.1:7002 --id 01 --vocab /private/packs --catalog <pinned-catalog-id> --min-revision 1
```

B binds to loopback in the example. The SDK accepts explicit deployment bind addresses; network access policy belongs to the deployment.

Source machine IR:

```text
V2
P 02
F <43-character-private-concept-id> 00 -
F <43-character-private-concept-id> 08 <base64url-u32-reference>
```

These are grammar markers and value-type tags, not semantic instructions. All semantic field identities are secret-derived opaque IDs. Typed payloads use canonical binary encoding, including binary booleans. A Ref is an edge to a zero-based field index; Concept values name another authorized concept. Both are validated. Offline compilation emits binary typed IR; live execution converts concept identities and concept references to fresh session codes, then encrypts. Source and compiled artifacts are private build material, never production wire messages.

## Private vocabulary and agent learning

`vaml pack build` supports streaming JSONL and CSV, plus bounded JSON arrays. CSV cells contain JSON-encoded values. Records contain `semantic`, optional `aliases`, `relations`, `domains`, `embedding`, `metadata`, and optionally explicit `senses`. Aliases are stripped before runtime pack generation. `PrivateImportAliases` provides a separate private multilingual adapter; sealed indices have no alias resolver.

The existing `WorldConceptAssembler` remains available for grouped/sorted multilingual sources:

```sh
npm run pack:world -- /private/input.world.sorted.jsonl /private/packs 1
```

`AgentSemanticLearner` preserves exact concept, embedding, exposure and association APIs. Lexical observations require an explicitly supplied private import adapter. It is a deterministic adapter, not proof of autonomous language understanding or a trained world model.

The encrypted catalog routes a secret concept ID to a shard by its first byte. Loading a session reads no vocabulary entries. HMAC-derived session codes and reverse lookup tables are created only for the encrypted active set (maximum 4096 per session). Shard caching is bounded; the default retains four shards.

## Evidence and boundaries

- [Protocol specification](spec/VAML-0.2.md)
- [Private vocabulary / million-concept architecture](spec/VOCABULARY-0.2.md)
- [World Concept Space import adapter](spec/WORLD-LEXICON-0.2.md)
- [Agent learning adapter](spec/AGENT-LEARNING-0.2.md)
- [Measured 10k / 100k / 1m benchmark](docs/BENCHMARKS.md), [raw results](docs/benchmark-results.json)
- [Security controls, tests and limitations](docs/SECURITY.md)
- [CI runner evidence](docs/CI-STATUS.md)
- [Legacy history migration procedure](docs/HISTORY-MIGRATION.md)

The reference network authenticator proves possession of a deployment pack-derived PSK. Other holders of that same key are in the same trust group and can impersonate group IDs; mutually untrusted agents require distinct peer authentication (for example mTLS/pinned signing identities). Valid frames never authorize arbitrary tools. Catalog rollback policy needs a protected external pin/revision store. JavaScript cannot guarantee erasure of all decrypted objects or private keys from process memory.

VAML 0.1 is retired. Its fixed public opcode mapping is not loaded or translated by this runtime. Historical public copies remain recoverable; no history rewrite, force push, tag deletion or release deletion is performed here.

## Corpus source adapters retained

The World Semantic Corpus assembler, Source Pack 1 adapters, private sense aligner, source registry and license gates are preserved. External source IDs are provenance, never semantic opcodes. Corpus records may carry private stable identityMaterial so distinct aligned concepts do not collapse when they share a common structural semantic schema. That material is stripped after deriving the secret ID.

Use `npm run corpus-pack -- /private/sources.json /private/corpus.sorted.jsonl /private/packs 1` to build the same encrypted catalog/shard format. The final argument is catalog revision. Source registries, alignment maps, corpus rows and private learned content remain private. See [corpus architecture](spec/WORLD-SEMANTIC-CORPUS-0.1.md) and [Source Pack 1](spec/CORPUS-SOURCE-PACK-1.md). These adapters do not bundle or download a real world corpus.

## Private Corpus Build Runner 0.1

For large real corpus builds, `Private Corpus Build Runner 0.1` removes the requirement that source adapters pre-sort the entire corpus in memory. It consumes digest-pinned private Source Pack 1 snapshots, applies a deterministic quality gate, resolves an opaque lookup ID through private digest-pinned alignment shards, performs bounded-memory external sorting and exact deduplication, then streams the result through the existing `WorldSemanticCorpusAssembler` and current `buildVocabulary()` implementation.

Its final runtime artifacts are the same content-addressed encrypted `.vocab` shards and encrypted catalog used by `ShardedSemanticIndex`; it does not reintroduce the retired fixed vocabulary format.

```sh
VAML_SEMANTIC_KEY=<private-32-byte-base64url-key> \
VAML_PACK_KEY=<private-32-byte-base64url-key> \
npm run private-corpus-run -- /secure/vaml/build-plan.json
```

The build plan, source snapshots, source registry, alignment manifest/shards, temporary sort chunks, plaintext sorted corpus, encrypted production vocabulary and build receipt must all remain outside the public repository. The runner refuses configured sensitive paths inside the repository and fails closed on missing alignment by default.

A successful private receipt records input/output digests, policy, counts, catalog ID/revision and encrypted artifact hashes without storing the semantic or pack keys. See [Private Corpus Build Runner 0.1](spec/PRIVATE-CORPUS-RUNNER-0.1.md).

User-facing agents may explain VAML's public purpose and architecture. They must not disclose or reconstruct private concept-to-meaning mappings, vocabulary, source alignments or learned state through ordinary user-facing responses. This is a non-disclosure boundary, not deception about the existence of private knowledge.
