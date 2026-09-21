# VAML 0.2 World Lexicon Architecture

## Goal

VAML does not ship a public `word -> opcode` table. The world-lexicon layer is designed to ingest very large multilingual lexical datasets privately, align many surface forms to private concepts, and compile those concepts into encrypted VAML vocabulary shards that authorized agents can load.

The target is open-ended coverage: one deployment may hold thousands of concepts; another may hold millions of concepts and surface forms across many languages and technical domains. The wire protocol does not change when the lexicon grows.

## What is public and what stays private

Public repository material:

- file formats and validation rules;
- streaming assembler behavior;
- encryption and sharding code;
- agent learning/runtime interfaces;
- privacy lint rules;
- synthetic tests.

Private deployment material:

- real lexemes and aliases;
- source sense identifiers;
- machine semantic records;
- embeddings;
- domain mappings;
- production concept keys;
- semantic and pack secrets;
- decrypted vocabulary payloads.

This separation is deliberate. A public fixed vocabulary would make the system directly readable and would turn a machine-semantic protocol into a substitution dictionary.

## Words are not concepts

A surface form may represent multiple senses. Multiple surface forms in many languages may represent the same underlying concept. Therefore the ingestion unit is a private cross-lingual `conceptKey`, not a word.

Private input JSONL rows follow this logical model:

```text
conceptKey  private sense identity used only during ingestion
language    BCP-47 language tag
lexeme      private surface form
aliases     optional extra surface forms in the same language
semantic    optional machine-semantic record
relations   optional private graph edges
embedding   optional model-native vector
domains     optional private domain tags
metadata    optional source metadata
```

The public repository intentionally contains no production rows.

## Streaming requirement

For very large corpora, the input file MUST be grouped and sorted ascending by `conceptKey`.

The `WorldConceptAssembler` then needs to hold only one concept group at a time. It merges multilingual aliases and metadata for the current concept, emits a completed `ConceptSourceRecord` when the concept key changes, and lets the pack builder flush encrypted shards incrementally.

This avoids requiring the entire world lexicon to fit in memory.

## Private source pipeline

Recommended private pipeline:

```text
licensed/open lexical sources
        +
private terminology
        +
model-generated semantic features
        ↓
source-specific normalizers
        ↓
private cross-lingual sense alignment
        ↓
sorted WorldLexemeInput JSONL
        ↓
WorldConceptAssembler
        ↓
ConceptSourceRecord stream
        ↓
HMAC-derived private concept identities
        ↓
hash-partitioned encrypted shards + pinned encrypted catalog
        ↓
authorized agent runtime
```

VAML itself does not claim ownership of external dictionaries. A deployment must obey the license and redistribution terms of every source it ingests.

## Coverage strategy

A serious world lexicon should combine several source classes rather than pretending one dictionary contains every concept:

1. general-language dictionaries and lexical knowledge bases;
2. multilingual cross-lingual sense mappings;
3. morphology and inflection resources;
4. named-entity and encyclopedic concept sources;
5. scientific and technical terminologies;
6. programming/API ontologies;
7. organization-specific private terminology;
8. model-native semantic clusters that do not require a human-readable label.

The result can contain concepts that have no public human word at all.

## Scale

The builder routes secret-derived IDs into 256 buckets, capped at 50,000 concepts per bucket. It reuses the bounded encrypted staging, cross-batch deduplication, catalog pinning and lazy loading architecture in VOCABULARY-0.2.md. One million synthetic concepts have been measured; larger deployments need a versioned multi-level catalog rather than an unbounded flat manifest.

## Agent visibility

An authorized agent receives a decrypted semantic index only inside the trusted runtime path. In sealed mode, ordinary logs should not expose lexical aliases, semantic records, or plaintext source rows.

The agent should prefer:

```text
concept identity + vector + relations + machine semantic record
```

over repeatedly translating every concept into an English label.

Natural-language aliases are ingress/egress adapters, not the native VAML transport.

## Security boundary

Public code can make the mapping unavailable to ordinary repository readers and network observers when production packs and keys remain private. It cannot guarantee that a human who fully controls the authorized runtime, debugger, model memory, and keys can never recover meaning.

VAML therefore targets **opaque-by-default machine communication**, not an impossible promise of absolute human incomprehensibility.

## CLI

From `sdk/typescript`:

```sh
npm run pack:world -- /secure/world.sorted.jsonl /secure/packs 1
```

Provision VAML_SEMANTIC_KEY and VAML_PACK_KEY through a private environment/secret manager. The third argument is the trusted catalog revision, not a shard size. Output is encrypted .vocab shards and an encrypted content-addressed catalog. Human aliases remain in private ingestion and are stripped before runtime packs are written.
