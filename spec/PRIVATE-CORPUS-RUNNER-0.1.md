# VAML Private Corpus Build Runner 0.1

## Purpose

Private Corpus Build Runner 0.1 is the offline production-oriented path from authorized private Source Pack 1 snapshots to the current VAML 0.2.4 encrypted vocabulary architecture.

It does not publish a world dictionary. The public repository contains only runner code, schemas, synthetic tests and protocol rules. Production snapshots, sense alignments, plaintext corpus rows, encrypted production packs, catalog pins, receipts and keys remain private deployment material.

## Pipeline

```text
authorized private source snapshots
              ↓
       SHA-256 verification
              ↓
       SourcePack1Candidate
              ↓
 deterministic quality gate
              ↓
 opaque candidate lookup ID
              ↓
 sharded private sense alignment
              ↓
      private alignmentKey
              ↓
 normalized CorpusRow
              ↓
 bounded private chunk sort
              ↓
 multi-pass k-way merge + exact dedupe
              ↓
 sorted private CorpusRow JSONL
              ↓
 WorldSemanticCorpusAssembler
              ↓
 ConceptSourceRecord stream
              ↓
 buildVocabulary()
              ↓
 content-addressed encrypted .vocab shards
              +
 encrypted pinned catalog
              ↓
 private build receipt
```

External IDs such as QIDs, synsets and source sense IDs remain provenance. They are never VAML wire opcodes.

## Private input boundary

The build plan, source manifest, snapshots, alignment manifest, alignment shards, temporary directory and output directory MUST resolve outside the public repository.

The runner refuses a build when configured sensitive paths resolve inside the repository. The CLI also checks the build-plan path before reading it.

The runner does not download or scrape any source. Dataset acquisition, licensing review, source-specific extraction and semantic alignment are explicit upstream private processes.

## Integrity pinning

The following input artifacts are pinned by SHA-256 using base64url encoding:

- source manifest;
- every source snapshot;
- alignment manifest;
- every alignment shard when it is first loaded.

A digest mismatch fails the build.

The source registry must be VAML corpus-sources 0.1 and must contain enabled sources with explicit license text. Placeholder license strings such as `unknown`, `unresolved` or `tbd` fail the build.

## Candidate quality gate

Runner 0.1 has a deterministic hygiene score. It is not a truth score.

A lexical candidate requires both language and lexeme. Valid lexical identity starts at 0.5. Evidence, aliases, relations, domains, embeddings and metadata may increase the score to a maximum of 1.0.

`policy.minQuality` defaults to `0.5`.

Semantic correctness is still determined upstream by the source, private alignment process and any deployment-specific validation/review.

## Opaque alignment lookup

The alignment layer does not require a public `word -> concept` table.

For each candidate the runner hashes canonical private identity material:

```text
category
sourceId
sourceSenseId
language
lexeme
       ↓
canonical JSON
       ↓
SHA-256
       ↓
43-character base64url lookup ID
```

That lookup ID is used only to locate a private alignment record. It is not a VAML concept ID and is not used on the wire.

## Sharded alignment format

A private alignment manifest maps lookup-ID prefixes to digest-pinned shards.

Logical manifest:

```json
{
  "format": "vaml-private-alignment-manifest",
  "version": "0.1",
  "prefixChars": 2,
  "shards": {
    "Ab": {
      "file": "Ab.alignment.private.json",
      "sha256": "<base64url-sha256>"
    }
  }
}
```

Logical shard:

```json
{
  "format": "vaml-private-alignment-shard",
  "version": "0.1",
  "entries": {
    "<opaque-lookup-id>": "<private-alignment-key>"
  }
}
```

The reference resolver validates shard paths, checks each shard digest before use and keeps only a bounded number of shards in memory.

`policy.missingAlignment` defaults to `reject`. `skip` is available only when an authorized deployment explicitly accepts incomplete coverage.

## Normalization and exact deduplication

Accepted candidates are normalized into `CorpusRow` values using NFKC normalization, deterministic alias/domain ordering and deterministic relation ordering.

The runner derives a private sorting identity from canonical row JSON. Exact duplicate normalized rows are removed during merge.

Different senses are not deduplicated merely because their surface text is equal. Their private alignment keys remain distinct.

## Bounded-memory external sort

Source snapshots do not need to arrive in alignment-key order.

The runner holds at most `policy.chunkRows` normalized rows in memory, sorts each private chunk and writes it with owner-only permissions where supported.

It then performs multi-pass k-way merging. `policy.mergeFanIn` limits the number of simultaneously open chunk readers.

Defaults:

```text
chunkRows   = 100000
mergeFanIn  = 64
```

This permits a corpus larger than available RAM as long as sufficient private temporary storage is available.

The final plaintext sorted corpus is still sensitive and remains outside the public repository.

## Current VAML vocabulary output

Runner 0.1 uses the same `buildVocabulary()` implementation as the current VAML 0.2.4 runtime.

This means output is not an old fixed `.vocab.json` collection. It is:

- hash-partitioned content-addressed encrypted `.vocab` shards;
- an encrypted content-addressed catalog;
- a catalog ID used by the runtime as an externally pinned identity;
- an explicit catalog revision for rollback policy.

Aliases are ingestion-only and are stripped before runtime shard generation by the existing vocabulary builder.

The build plan supplies `output.revision`, defaulting to `1`.

## Private build receipt

A successful build creates `<prefix>.build.receipt.json` outside the public repository.

The receipt contains:

- run ID and timestamps;
- verified source/alignment/snapshot digests;
- quality, alignment, sorting and merge policy;
- candidate and rejection counters;
- deduplication count;
- final corpus statistics;
- sorted-corpus digest;
- catalog ID and revision;
- catalog digest;
- digests and sizes for generated encrypted `.vocab` artifacts.

It does not contain semantic or pack keys.

## Build plan

Public schema: `spec/schema/private-corpus-build-plan-0.1.schema.json`.

Logical example:

```json
{
  "format": "vaml-private-corpus-build-plan",
  "version": "0.1",
  "runId": "world-corpus-build-001",
  "sourceManifest": {
    "path": "/secure/vaml/corpus.sources.json",
    "sha256": "<base64url-sha256>"
  },
  "snapshots": [
    {
      "id": "source-a-snapshot",
      "sourceId": "source-a",
      "path": "/secure/vaml/snapshots/source-a.sourcepack.jsonl",
      "sha256": "<base64url-sha256>",
      "format": "source-pack-1-candidate-jsonl"
    }
  ],
  "alignmentManifest": {
    "path": "/secure/vaml/alignment/alignment.manifest.json",
    "sha256": "<base64url-sha256>"
  },
  "tempDir": "/secure/vaml/tmp/build-001",
  "output": {
    "directory": "/secure/vaml/output/build-001",
    "prefix": "world-corpus",
    "revision": 1
  },
  "policy": {
    "minQuality": 0.5,
    "missingAlignment": "reject",
    "chunkRows": 100000,
    "mergeFanIn": 64,
    "cleanupTemp": true
  }
}
```

`tempDir` and `output.directory` must be separate non-overlapping empty directories at build start.

## CLI

From `sdk/typescript`:

```bash
VAML_SEMANTIC_KEY=<base64url-32-byte-secret> \
VAML_PACK_KEY=<base64url-32-byte-secret> \
npm run private-corpus-run -- /secure/vaml/build-plan.json
```

Keys remain in protected environment/secret-manager state and are not stored in the build plan. The CLI clears its accessible key buffers in `finally`; JavaScript does not guarantee elimination of every copy from process/runtime memory.

## Fail-closed conditions

Runner 0.1 rejects at least:

- invalid or changed SHA-256 pinned inputs;
- a build plan or sensitive build path inside the public repository;
- overlapping temp/output directories;
- unsafe output prefixes;
- unresolved source licenses;
- disabled/unregistered snapshot sources;
- snapshot rows claiming another source ID;
- non-finite embeddings;
- malformed or oversized source lines;
- alignment path traversal;
- malformed alignment IDs/entries;
- missing required alignment in default reject mode;
- non-empty temp/output directories;
- invalid key lengths;
- corpus/vocabulary accounting mismatch.

## Security boundary

This runner improves reproducibility, privacy hygiene and integrity of corpus builds. It does not make private semantics mathematically unrecoverable to an operator who controls the authorized process, model, plaintext source snapshots and keys.

The intended guarantee is that the public GitHub repository and ordinary network traffic do not themselves publish a readable production `word -> Agent meaning/code` dictionary.
