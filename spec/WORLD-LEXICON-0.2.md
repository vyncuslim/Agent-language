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
50k-concept encrypted shards (configurable)
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

The reference `build-world-lexicon.ts` defaults to 50,000 concepts per encrypted shard. There is no protocol-level maximum number of shards.

Examples of deployment scale:

```text
20 shards     ≈ 1,000,000 concepts
200 shards    ≈ 10,000,000 concepts
2,000 shards  ≈ 100,000,000 concepts
```

These are capacity examples, not claims that the repository already contains that number of real-world concepts.

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

```bash
VAML_SEMANTIC_KEY=<base64url-32-byte-secret> \
VAML_PACK_KEY=<base64url-32-byte-secret> \
npm run world-pack -- /secure/world.sorted.jsonl /secure/out/world 50000
```

The output is encrypted `.vocab.json` shards plus a private shard manifest. The repository `.gitignore` and privacy lint intentionally reject those production artifacts if somebody tries to commit them.
