# VAML — Vynalth Agent Machine Language

VAML 0.2 is an experimental machine-native protocol for AI-agent communication. Release `0.2.3-experimental` adds **Corpus Source Pack 1** on top of the VAML World Semantic Corpus while remaining wire-compatible with VAML 0.2.

VAML deliberately avoids a public `word -> opcode` dictionary. Production agents communicate through private concept identities, session-local opaque codes, typed binary fields, and authenticated encryption.

## Architecture

```text
private dictionaries / entities / terminology / model semantics
                         ↓
               source-pack adapters
                         ↓
              source candidates
                         ↓
             private sense aligner
                         ↓
            private alignmentKey
                         ↓
       WorldSemanticCorpusAssembler
                         ↓
           encrypted vocab shards
                         ↓
            PrivateSemanticIndex
                         ↓
            AgentSemanticLearner
                         ↓
          internal private concepts
                         ↓
           ephemeral peer negotiation
                         ↓
           session-local 64-bit codes
                         ↓
             encrypted VAML frames
                         ↓
                    peer agent
```

The same private concept receives a fresh wire code in a fresh session.

## Corpus Source Pack 1

The first concrete source pack covers five categories:

- general vocabulary — Princeton WordNet 3.0 + private Wiktionary extracts;
- morphology — UniMorph datasets with explicit per-dataset license verification;
- entities — Wikidata structured data profile;
- science and mathematics — Wikidata structured data profile;
- programming/software concepts — Wikidata structured data profile.

Public code contains adapters and synthetic tests only. Third-party dumps, private source registries, source-to-concept alignment maps and compiled production shards stay outside Git history.

External IDs such as WordNet synsets or Wikidata QIDs are provenance identifiers. They are **not VAML opcodes**. Every source candidate must go through a private semantic aligner before becoming a corpus concept.

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

Corpus input is grouped and sorted by a private `alignmentKey`. The assembler streams one concept group at a time instead of loading the entire corpus into memory.

The default output shard contains 50,000 concepts. There is no protocol-level shard-count limit.

```text
20 shards       ≈ 1,000,000 concepts
200 shards      ≈ 10,000,000 concepts
2,000 shards    ≈ 100,000,000 concepts
```

These numbers describe capacity, not corpus content bundled with this repository.

## Repository layout

```text
AGENTS.md                                           Agent loading/learning contract
vaml.manifest.json                                 Machine entrypoint
spec/VAML-0.2.md                                   Wire protocol
spec/VOCABULARY-0.2.md                             Private vocabulary architecture
spec/WORLD-LEXICON-0.2.md                          Large multilingual lexicon layer
spec/WORLD-SEMANTIC-CORPUS-0.1.md                  Multi-source private corpus architecture
spec/CORPUS-SOURCE-PACK-1.md                       First real source-ingestion profiles
spec/AGENT-LEARNING-0.2.md                         Agent learning model
sdk/typescript/src/corpus.ts                       Streaming corpus assembler + provenance
sdk/typescript/src/source-adapter.ts               Source adapter boundary
sdk/typescript/src/source-pack-1.ts                WordNet/Wiktionary/UniMorph/Wikidata adapters
sdk/typescript/src/learning.ts                     Opaque learner
sdk/typescript/src/semantic-index.ts               Private semantic index
sdk/typescript/tools/build-world-semantic-corpus.ts Corpus -> encrypted shard builder
sdk/typescript/tools/privacy-lint.ts                Public-repository leakage guard
sdk/typescript/test/source-pack-1.test.ts           Source Pack 1 synthetic tests
sdk/typescript/test/corpus.test.ts                  Synthetic corpus tests
sdk/typescript/examples/agent-pair-demo.ts          Agent A <-> Agent B demo
```

## Quick start

```bash
cd sdk/typescript
npm install
npm run check
npm run demo
```

Build a private world semantic corpus:

```bash
VAML_SEMANTIC_KEY=<base64url-32-byte-secret> \
VAML_PACK_KEY=<base64url-32-byte-secret> \
npm run corpus-pack -- \
  /secure/corpus.sources.json \
  /secure/corpus.sorted.jsonl \
  /secure/out/world-corpus \
  50000
```

Input rows must be grouped and sorted by private `alignmentKey`. The source manifest must register every source and its license/redistribution policy.

Outputs are encrypted `.vocab.json` shards plus a private corpus manifest. Do not commit those artifacts.

## Privacy guard

Run:

```bash
npm run privacy
```

The guard rejects common private corpus/lexicon/source-pack paths, alignment maps, vocabulary packs, keys and obvious fixed public word/opcode registries.

## Security boundary

VAML can keep production semantic mappings out of a public repository, out of ordinary logs, and out of passive network captures. It cannot truthfully guarantee that meaning is forever unknowable to a human with complete control of the authorized model process and secrets.

The target is **opaque-by-default agent communication and private machine semantics**.

## Status

**VAML 0.2.3 experimental runtime · VAML 0.2 wire-compatible · World Semantic Corpus 0.1 · Corpus Source Pack 1.**
