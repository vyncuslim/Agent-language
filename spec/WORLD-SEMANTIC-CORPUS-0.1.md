# VAML World Semantic Corpus 0.1

## Purpose

The VAML World Semantic Corpus is the private data layer that feeds large encrypted VAML vocabulary packs.

It is designed for multilingual lexical knowledge, morphology, named entities, scientific terminology, mathematics, programming, domain terminology, and model-native concepts that do not require a human-readable word at all.

The public repository contains the corpus **format, validation, streaming compiler, encryption path, and tests**. Production corpus rows remain outside the public repository.

## Design boundary

VAML does not claim that a public repository can make meaning mathematically impossible for every human to recover. The goal is narrower and technically defensible:

- repository readers do not receive the production word/concept mapping;
- ordinary network observers see authenticated encrypted VAML traffic;
- session codes are not stable global word IDs;
- normal sealed-mode telemetry does not emit decrypted semantic labels;
- authorized agents can load private encrypted semantic packs and operate on concept/vector/relation state.

An operator who possesses the authorized runtime, model memory, corpus keys, and debugger may still recover meaning.

## Corpus layers

```text
licensed/open/private source material
              ↓
      source-specific adapters
              ↓
 normalized private CorpusRow JSONL
              ↓
 private cross-source sense alignment
              ↓
 rows sorted/grouped by alignmentKey
              ↓
 WorldSemanticCorpusAssembler
              ↓
       ConceptSourceRecord
              ↓
   HMAC private concept identity
              ↓
      encrypted .vocab shards
              ↓
       PrivateSemanticIndex
              ↓
        authorized agents
```

## Source registry

Every input row must reference an entry in a private source registry.

A source descriptor contains:

```text
id
kind
license
redistribution
languages[]
domains[]
embeddingSpace
enabled
notes
```

Supported source kinds include dictionaries, lexical knowledge bases, encyclopedic sources, terminology, morphology, entities, programming ontologies, organization-private sources, model-generated sources, and agent-native generators.

The compiler rejects rows whose `sourceId` is not registered or whose source is disabled.

### Licensing

The source registry is not a license bypass mechanism. A deployment must have the legal right to ingest and process every source it uses and must obey source-specific redistribution and attribution requirements.

The recommended default for third-party production corpus data is `private-only` unless redistribution rights are explicitly known.

## Corpus rows

Two row families are supported.

### Lexical row

A lexical row links a private concept alignment key to one or more natural-language surface forms.

Logical fields:

```text
kind = lexeme
alignmentKey
sourceId
sourceSenseId
language
lexeme
aliases[]
domains[]
relations{}
semanticEvidence
embedding
embeddingSpace
metadata{}
```

`alignmentKey` is a private cross-source identity and MUST NOT be treated as a public opcode.

### Agent-native row

An agent-native row creates or enriches a concept that may have no human-readable lexical alias.

Logical fields:

```text
kind = agent-native
alignmentKey
sourceId
prototype[]
domains[]
relations{}
semanticEvidence
embedding
embeddingSpace
metadata{}
```

The absence of a word is intentional. The concept may exist only as latent/vector/relation structure used by compatible agents.

## Cross-lingual alignment

The corpus compiler does not guess that two words mean the same thing merely because they have similar spelling or translation.

Before compilation, private preprocessing must align source senses to a shared `alignmentKey`. Alignment can use:

- source-provided sense IDs;
- curated cross-lingual mappings;
- graph links;
- multilingual embeddings;
- model-assisted proposals;
- human review for high-risk or ambiguous mappings.

One surface form may resolve to many concepts. One concept may contain aliases in many languages.

## Streaming and scale

Input JSONL MUST be grouped and sorted ascending by `alignmentKey`.

`WorldSemanticCorpusAssembler` holds only the active concept group in memory. This allows very large private datasets to be processed without loading the entire corpus into RAM.

The default encrypted shard size is 50,000 concepts and is configurable.

Capacity examples:

```text
20 shards       about 1,000,000 concepts
200 shards      about 10,000,000 concepts
2,000 shards    about 100,000,000 concepts
```

These are architectural capacities, not claims about corpus content shipped by this repository.

## Semantic evidence

Source-specific semantic records may be attached as private `semanticEvidence`.

The assembler preserves that evidence inside encrypted concept metadata together with provenance. It does not publish the evidence as a stable word/opcode table.

The stable semantic identity used by the current corpus layer is a private alignment reference plus the concept's private domain set. Rich evidence can evolve without needing a readable public registry.

## Embeddings

Rows may contain vectors only when their embedding space is identified by `embeddingSpace` or by the registered source descriptor.

For one concept:

- vectors from one common embedding space may be centroid-merged;
- vectors from incompatible spaces are recorded in provenance metadata but are not blindly averaged into one public/runtime vector;
- inconsistent dimensions inside one mergeable space are rejected.

Production systems with very large concept spaces should connect the agent learning layer to an ANN/vector database rather than relying on linear scans.

## Agent-native concepts

VAML intentionally permits concepts with no lexical alias.

Examples of suitable agent-native concept formation mechanisms include:

- recurring latent clusters discovered from model activations;
- tool-state patterns;
- multimodal semantic prototypes;
- stable graph motifs;
- task-state abstractions;
- learned internal relations between existing private concepts.

Agent-native concepts are still subject to the same authorization, policy, provenance, and encrypted storage requirements as lexical concepts.

## Privacy requirements

Production deployments SHOULD:

1. keep source JSONL, source registries, plaintext alignment maps, and corpus manifests outside the public repository;
2. use separate 32-byte semantic and pack secrets;
3. encrypt compiled vocabulary shards at rest;
4. keep keys outside Git history;
5. run repository privacy lint before commits/CI;
6. avoid decrypted semantic logging in sealed mode;
7. treat opaque learner snapshots as sensitive because graph structure can leak information;
8. rotate compromised production keys and rebuild affected packs.

## Builder CLI

From `sdk/typescript`:

```bash
VAML_SEMANTIC_KEY=<base64url-32-byte-secret> \
VAML_PACK_KEY=<base64url-32-byte-secret> \
npm run corpus-pack -- \
  /secure/corpus.sources.json \
  /secure/corpus.sorted.jsonl \
  /secure/out/world-corpus \
  50000
```

Outputs:

```text
world-corpus.00000.vocab.json
world-corpus.00001.vocab.json
...
world-corpus.corpus.manifest.json
```

All outputs are private deployment artifacts and must not be committed to this public repository.

## Corpus success criteria

A corpus build is suitable for VAML when it can:

- combine multiple registered sources without exposing a public mapping;
- preserve multilingual ambiguity rather than collapsing all words into one meaning;
- include lexical and non-lexical concepts;
- retain encrypted provenance and machine-semantic evidence;
- stream to encrypted shards at large scale;
- load into an authorized semantic index and learner;
- participate in session-local VAML negotiation without creating stable public word IDs.
