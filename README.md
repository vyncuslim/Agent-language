# VAML — Vynalth Agent Machine Language

VAML 0.2 is an experimental machine-native protocol for AI-agent communication. Release `0.2.4-experimental` adds **Private Corpus Build Runner 0.1** on top of Corpus Source Pack 1 and the VAML World Semantic Corpus while remaining wire-compatible with VAML 0.2.

VAML deliberately avoids a public `word -> opcode` dictionary. Production agents communicate through private concept identities, session-local opaque codes, typed binary fields, and authenticated encryption.

## Architecture

```text
private source snapshots
        ↓
checksum verification
        ↓
source-pack adapters
        ↓
SourcePack1Candidate
        ↓
opaque lookup ID
        ↓
private sharded alignment
        ↓
bounded sort + exact dedupe
        ↓
WorldSemanticCorpusAssembler
        ↓
encrypted vocab shards
        ↓
PrivateSemanticIndex
        ↓
AgentSemanticLearner
        ↓
session-local VAML codes
        ↓
encrypted VAML frames
        ↓
peer agent
```

The same private concept receives a fresh wire code in a fresh session.

## Private Corpus Build Runner 0.1

The new offline runner is the production-oriented path from authorized private source snapshots to encrypted VAML corpus shards.

It performs:

- SHA-256 pinning of source snapshots, source policy files, alignment manifests and alignment shards;
- source enablement/license sanity checks;
- deterministic candidate quality gating;
- opaque candidate lookup IDs;
- private alignment lookup through lazily loaded shards;
- fail-closed missing-alignment behavior by default;
- bounded-memory chunk sorting;
- k-way merge and exact duplicate removal;
- encrypted VAML corpus shard generation;
- private corpus manifest generation;
- private build receipt generation with input/output digests and build counters;
- path checks that reject sensitive build material inside the public repository.

The runner intentionally **does not download or scrape source material**. Acquisition, licensing review, source-specific extraction and semantic alignment remain explicit private preprocessing steps.

See `spec/PRIVATE-CORPUS-RUNNER-0.1.md`.

## Corpus Source Pack 1

The first concrete source pack covers five categories:

- general vocabulary — Princeton WordNet 3.0 + private Wiktionary extracts;
- morphology — UniMorph datasets with explicit per-dataset license verification;
- entities — Wikidata structured data profile;
- science and mathematics — Wikidata structured data profile;
- programming/software concepts — Wikidata structured data profile.

Public code contains adapters and synthetic tests only. Third-party dumps, private source registries, source-to-concept alignment maps and compiled production shards stay outside Git history.

External IDs such as WordNet synsets or Wikidata QIDs are provenance identifiers. They are **not VAML opcodes**. Every source candidate must go through private semantic alignment before becoming a corpus concept.

See `spec/CORPUS-SOURCE-PACK-1.md`.

## World Semantic Corpus

The corpus layer is designed to combine many private or properly licensed sources into one concept space without publishing a readable dictionary in this repository.

Supported source classes include multilingual dictionaries and lexical knowledge bases, morphology and inflection data, named entities, science/mathematics/engineering terminology, programming concepts, organization-private vocabulary, model-generated semantic structures, and **agent-native concepts with no required human-language word**.

Words remain edge aliases. Meanings are private concepts.

See `spec/WORLD-SEMANTIC-CORPUS-0.1.md`.

## Why there is no giant public list of “all words”

A public table such as:

```text
search -> 0x1234
cat    -> 0x1235
危险   -> 0x1236
```

would be directly readable and statistically learnable by humans. It would also fail to represent polysemy, multilingual synonymy, entities, latent concepts and concepts that have no word at all.

VAML instead uses private cross-source sense alignment, encrypted concept packs, optional embeddings and relations, HMAC-derived private identities, and fresh session-local wire codes.

## Source license discipline

Source Pack 1 intentionally refuses to treat every downloadable dataset as unrestricted.

WordNet usage must preserve its required license/copyright notices. Wiktionary is kept `private-only` by default until attribution/share-alike/GFDL export compliance is implemented. UniMorph datasets must declare an explicit verified license per enabled language dataset. Wikidata structured data is registered as CC0.

## Agent-native concepts

A corpus row can be `kind: "agent-native"`. Such a concept may contain a latent prototype, relations, domains and private semantic evidence without containing any lexical alias.

This allows compatible agents to develop semantic units that are not required to be named in English, Chinese or any other human language.

It does **not** create a mathematical guarantee that a human controlling the authorized runtime, keys, model memory and debugger can never reverse engineer meaning.

## Scale

The low-level corpus assembler requires rows grouped by private `alignmentKey`. Private Corpus Build Runner 0.1 removes that burden from source adapters by externally sorting normalized rows using bounded private chunks before assembly.

Default runner settings:

```text
chunkRows   100,000 normalized rows in memory
shardSize    50,000 compiled concepts per encrypted shard
alignment   lazy sharded lookup with a small in-memory cache
```

The protocol itself does not impose a shard-count limit.

```text
20 shards       ≈ 1,000,000 concepts
200 shards      ≈ 10,000,000 concepts
2,000 shards    ≈ 100,000,000 concepts
```

These numbers describe capacity, not corpus content bundled with this repository.

## Repository layout

```text
AGENTS.md                                             Agent loading/learning contract
vaml.manifest.json                                   Machine entrypoint
spec/VAML-0.2.md                                     Wire protocol
spec/VOCABULARY-0.2.md                               Private vocabulary architecture
spec/WORLD-LEXICON-0.2.md                            Large multilingual lexicon layer
spec/WORLD-SEMANTIC-CORPUS-0.1.md                    Multi-source private corpus architecture
spec/CORPUS-SOURCE-PACK-1.md                         First source-ingestion profiles
spec/PRIVATE-CORPUS-RUNNER-0.1.md                    Verified offline corpus build pipeline
spec/schema/private-corpus-build-plan-0.1.schema.json Build-plan schema
spec/AGENT-LEARNING-0.2.md                           Agent learning model
sdk/typescript/src/source-pack-1.ts                  WordNet/Wiktionary/UniMorph/Wikidata adapters
sdk/typescript/src/private-corpus-runner.ts          Offline build runner core
sdk/typescript/tools/run-private-corpus-build.ts     Offline build runner CLI
sdk/typescript/tools/build-world-semantic-corpus.ts  Low-level pre-sorted corpus builder
sdk/typescript/tools/privacy-lint.ts                 Public-repository leakage guard
sdk/typescript/test/private-corpus-runner.test.ts    End-to-end synthetic runner tests
sdk/typescript/examples/agent-pair-demo.ts           Agent A <-> Agent B demo
```

## Quick start

```bash
cd sdk/typescript
npm install
npm run check
npm run demo
```

Preferred private build path:

```bash
VAML_SEMANTIC_KEY=<base64url-32-byte-secret> \
VAML_PACK_KEY=<base64url-32-byte-secret> \
npm run private-corpus-run -- /secure/vaml/build-plan.json
```

The build plan, snapshots, alignment data, temporary chunks, plaintext sorted corpus, production encrypted packs and build receipts must stay outside the public repository.

Low-level pre-sorted build remains available:

```bash
VAML_SEMANTIC_KEY=<base64url-32-byte-secret> \
VAML_PACK_KEY=<base64url-32-byte-secret> \
npm run corpus-pack -- \
  /secure/corpus.sources.json \
  /secure/corpus.sorted.jsonl \
  /secure/out/world-corpus \
  50000
```

## Privacy guard

Run:

```bash
npm run privacy
```

The guard rejects common private corpus/lexicon/source-pack/build paths, source snapshots, alignment artifacts, build plans/receipts, vocabulary packs, keys and obvious fixed public word/opcode registries.

## Security boundary

VAML can keep production semantic mappings out of a public repository, out of ordinary logs, and out of passive network captures. It cannot truthfully guarantee that meaning is forever unknowable to a human with complete control of the authorized model process and secrets.

The target is **opaque-by-default agent communication and private machine semantics**.

## Status

**VAML 0.2.4 experimental runtime · VAML 0.2 wire-compatible · World Semantic Corpus 0.1 · Corpus Source Pack 1 · Private Corpus Build Runner 0.1.**
