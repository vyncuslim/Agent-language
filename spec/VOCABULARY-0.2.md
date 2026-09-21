# VAML 0.2 Private Vocabulary Architecture

## Objective

VAML 0.2 is designed to support a vocabulary far larger than a hand-written opcode table, including multilingual lexical coverage and non-linguistic machine concepts.

The target is not "one public code for every word". The target is an open-ended private concept space that can ingest lexical resources from many languages while keeping production semantic mappings outside the public protocol.

## Why concepts instead of words

A word is not a reliable semantic unit:

- one word can have several meanings;
- several words can express one meaning;
- morphology creates many surface forms;
- languages do not divide concepts identically;
- technical domains continuously introduce new terminology;
- agents also need concepts that have no convenient human word.

VAML therefore treats lexical forms as optional aliases to semantic concepts.

## Private source record

The private vocabulary builder accepts newline-delimited JSON records. The schema is:

```json
{
  "semantic": { "machine": "private semantic structure" },
  "aliases": {
    "<language-tag>": ["<private lexical form>"]
  },
  "relations": {
    "<private-relation>": ["<private-target>"]
  },
  "domains": ["<domain-id>"],
  "embedding": [0.0, 0.0, 0.0],
  "metadata": {}
}
```

This is a schema example only. Production lexical content SHOULD remain in a private data location and MUST NOT be committed to the public repository.

Language keys SHOULD use stable language tags (for example BCP-47 style tags) so aliases can coexist across scripts and regional variants.

## Concept identity

The compiler derives a keyed concept identity from canonical semantic material. The public wire protocol never requires the source lexical form.

Because the derivation is keyed, an observer who only knows a word cannot calculate the production concept ID without the semantic key and canonical record.

## Multilingual resolution

After an authorized agent decrypts a vocabulary pack, `PrivateSemanticIndex` can resolve a private lexical alias to one or more candidate concept IDs.

Multiple candidates are expected. The agent/model must disambiguate using context, relations, embeddings, task state, or other authorized model logic.

## Scale

The reference builder reads JSONL as a stream and emits encrypted vocabulary shards. The default shard size is 50,000 records.

Example capacity model:

```text
20 shards  = 1,000,000 source records
200 shards = 10,000,000 source records
```

There is no protocol-level assumption that the vocabulary stops at those sizes. Deployment limits are determined by storage, memory, indexing, retrieval design, and model/runtime capacity.

## What should be imported

A broad production concept space can ingest authorized/licensed sources covering areas such as:

- general multilingual lexicons;
- morphology and inflection data;
- named entities;
- scientific terminology;
- mathematics;
- computing and software;
- medicine and biology;
- law and policy;
- geography;
- history;
- finance;
- engineering;
- arts and culture;
- organization-specific knowledge;
- agent-native concepts that do not correspond to human words.

VAML does not bundle third-party dictionary data in this repository. Data licensing and provenance must be handled by the deployment that builds the private packs.

## Sharding strategy

Large deployments SHOULD shard by one or more of:

- semantic domain;
- language family/script;
- frequency tier;
- model capability;
- organization/product boundary;
- sensitivity/access class.

An agent should load only the packs it is authorized and expected to use.

## Runtime privacy

Production pack files are AES-256-GCM encrypted by the reference implementation. Pack keys and semantic keys belong in a secret manager or equivalent protected runtime channel, not source control.

The `.gitignore` in this repository excludes common private vocabulary and key file patterns.

## Agent-only operation

The intended sealed path is:

```text
private source data
  -> private compiler
  -> encrypted .vocab shards
  -> authorized agent runtime
  -> internal concept/embedding graph
  -> session-randomized VAML codes
  -> encrypted agent-to-agent frames
```

Normal logs and network captures do not need to contain lexical aliases or semantic labels.

## Important limitation

No software can guarantee that a human with full control of the agent process, model weights, memory, debugger, and decryption keys can never recover meaning. VAML 0.2 is designed to prevent ordinary public readability and passive wire interpretation, not to defeat a fully privileged owner of the runtime.
