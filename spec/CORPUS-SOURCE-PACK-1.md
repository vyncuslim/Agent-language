# VAML Corpus Source Pack 1

## Purpose

Corpus Source Pack 1 defines the first concrete ingestion profiles for the private VAML World Semantic Corpus.

It covers five source categories:

1. general vocabulary;
2. morphology;
3. named/encyclopedic entities;
4. mathematics and science;
5. programming and software concepts.

The public repository contains adapters, validation and synthetic tests only. It does **not** ship third-party dumps, private alignment maps, plaintext production corpus rows or decrypted VAML packs.

## Sources and policy

### Princeton WordNet 3.0

Use for English lexical-semantic bootstrap data.

The source descriptor records the Princeton WordNet 3.0 License. Redistribution is permitted only while preserving the required copyright/license notices and other license conditions.

The adapter accepts normalized synset records and emits `general-vocabulary` candidates.

### Wiktionary extracts

Use for multilingual lexical aliases, forms, parts of speech and sense evidence.

Wiktionary content has attribution/share-alike and GFDL obligations. Source Pack 1 therefore defaults its descriptor to `private-only` even though lawful redistribution may be possible when all obligations are implemented.

Do not copy fair-use or separately licensed media into the VAML corpus merely because it appears on a Wiktionary page.

### UniMorph

Use for morphology and inflectional forms.

UniMorph datasets are distributed in language-specific repositories and source/license conditions may differ. Source Pack 1 does not pretend there is one universal license. `unimorphDescriptor()` requires an explicit verified license string per enabled dataset and rejects unresolved values.

### Wikidata structured data

Use for entities and structured concept profiles.

Source Pack 1 uses one CC0 Wikidata adapter with three profiles:

- `entities`;
- `science-math`;
- `programming`.

The adapter consumes a private/offline normalized extract rather than requiring the VAML runtime to call Wikidata over the network.

## Why the adapters emit candidates first

External source identifiers must not become public VAML opcodes.

The ingestion path is:

```text
source dump / private extract
        ↓
source-specific adapter
        ↓
SourcePack1Candidate
        ↓
private sense aligner
        ↓
private alignmentKey
        ↓
CorpusRow
        ↓
WorldSemanticCorpusAssembler
        ↓
stable private concept identity
        ↓
encrypted VAML shards
```

A private aligner may use source sense IDs, graph relations, multilingual embeddings, curated mappings and model-assisted alignment. The aligner output is private deployment material.

## Adapter contracts

### `wordNetCandidates()`

Input fields: `synset`, `pos`, `lemmas[]`, optional `gloss`, optional `pointers{}`.

Output category: `general-vocabulary`.

### `wiktionaryCandidates()`

Input fields: `entryId`, `senseId`, `language`, `lemma`, optional aliases/forms/part-of-speech/gloss.

Output category: `general-vocabulary`.

### `uniMorphCandidates()`

Input fields: `lemma`, `form`, `features`.

Output category: `morphology`.

A corresponding `unimorphDescriptor()` with an explicitly verified license is required before the source is registered in a production build.

### `wikidataCandidates()`

Input fields: `id`, multilingual labels/aliases/descriptions, optional `instanceOf[]`, `subclassOf[]`, and profile `entities | science-math | programming`.

Output category is selected by the private extraction profile.

## Privacy rules

Source Pack 1 must not introduce a fixed public mapping such as:

```text
word -> number
QID -> VAML opcode
WordNet synset -> public wire code
```

Source IDs and source sense IDs are provenance/ingestion information only. They do not grant authorization and do not become stable session codes.

Production source extracts, source registries, private aligner outputs and compiled shards remain outside the public repository.

## Scale strategy

Do not build one monolithic file containing every source. Each source can be updated independently, then privately aligned and sorted before corpus compilation.

Stable private concept identities allow new evidence and aliases to enrich an existing concept without turning the corpus into a public dictionary.

## Source Pack 1 success criteria

A deployment is Source-Pack-1-ready when it can:

- ingest all five source categories through the public adapter contracts;
- enforce explicit source license metadata;
- reject unresolved UniMorph licensing;
- keep Wiktionary redistribution conservative by default;
- use CC0 Wikidata structured data for entity/science/programming profiles;
- route every source candidate through private semantic alignment;
- compile aligned rows into encrypted World Semantic Corpus shards;
- expose no stable human-readable word-to-opcode table in Git history.
