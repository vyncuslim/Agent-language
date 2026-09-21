# VAML Private Corpus Build Runner 0.1

## Purpose

Private Corpus Build Runner 0.1 turns authorized private source snapshots into encrypted VAML World Semantic Corpus shards without placing plaintext corpus data, alignment maps, source extracts, build plans, or keys in the public repository.

It is the first production-oriented offline build path for VAML Corpus Source Pack 1.

## Security boundary

The public repository contains only the runner implementation, schemas, synthetic tests, and protocol documentation.

The following artifacts are private deployment material and MUST remain outside the public Git repository:

- source snapshots;
- source manifests used for a production build;
- cross-source alignment manifests and shards;
- plaintext normalized/sorted corpus JSONL;
- encrypted vocabulary shards when they contain production corpus data;
- corpus manifests and build receipts;
- semantic keys and pack keys.

The runner refuses to use configured sensitive paths that resolve inside the public repository root.

## Pipeline

```text
licensed/authorized source snapshot(s)
                ↓
        SHA-256 verification
                ↓
        SourcePack1Candidate
                ↓
       deterministic quality gate
                ↓
      opaque candidate lookup ID
                ↓
 sharded private alignment resolver
                ↓
          private alignmentKey
                ↓
            CorpusRow
                ↓
       bounded in-memory chunks
                ↓
          chunk sorting
                ↓
        k-way merge + dedupe
                ↓
      sorted private corpus JSONL
                ↓
   WorldSemanticCorpusAssembler
                ↓
     encrypted VAML vocab shards
                ↓
 private corpus manifest + receipt
```

No external source identifier is used as a VAML wire opcode.

## Source snapshots

Runner 0.1 accepts `source-pack-1-candidate-jsonl` snapshots. Each line is a `SourcePack1Candidate` created by a source-specific private extraction process.

Each snapshot entry in the build plan contains:

```text
id
sourceId
path
sha256
format
```

The file digest MUST match before parsing begins. Every candidate emitted by a snapshot MUST use the same `sourceId` declared by that snapshot.

The referenced source MUST also exist and be enabled in the private source manifest.

## Quality gate

The initial quality score is deterministic and intentionally simple. A candidate requires both a language and lexeme. Valid core identity contributes a baseline score, while semantic evidence, aliases, relations, domains, embeddings, and metadata can increase the score.

The build plan controls `policy.minQuality` from 0 to 1. The default is `0.5`.

This score is a build hygiene filter, not a truth score and not a replacement for source validation, semantic alignment, model evaluation, or domain review.

## Opaque candidate lookup ID

The private alignment layer does not need a plaintext `word -> alignmentKey` index.

The runner derives an opaque lookup identifier by hashing canonical private candidate identity material:

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
base64url lookup ID
```

The lookup ID is not a semantic opcode. It only locates a private alignment record during corpus construction.

## Sharded private alignment

Large alignment maps are split by lookup-ID prefix so the runner does not load millions of mappings into RAM at once.

Private alignment manifest logical format:

```json
{
  "format": "vaml-private-alignment-manifest",
  "version": "0.1",
  "prefixChars": 2,
  "shards": {
    "Ab": { "file": "Ab.alignment.private.json", "sha256": "<base64url-sha256>" }
  }
}
```

Each private shard contains:

```json
{
  "format": "vaml-private-alignment-shard",
  "version": "0.1",
  "entries": {
    "<opaque-lookup-id>": "<private-alignment-key>"
  }
}
```

Every alignment shard is SHA-256 verified when first loaded. The reference runtime keeps only a small number of alignment shards in memory at once.

`policy.missingAlignment` defaults to `reject`. `skip` is available only when a deployment explicitly accepts incomplete coverage.

## Bounded sorting and deduplication

Production source rows do not need to arrive in `alignmentKey` order.

The runner:

1. normalizes accepted candidates to `CorpusRow`;
2. collects at most `policy.chunkRows` rows in memory;
3. sorts each private temporary chunk;
4. writes chunk files with owner-only file mode where supported;
5. performs a k-way merge;
6. removes exact duplicate normalized rows;
7. emits one sorted private corpus JSONL file.

The default `chunkRows` is `100000`.

This lets corpus size grow beyond available RAM as long as private temporary storage is sufficient.

## Encrypted shard build

The sorted corpus is streamed through `WorldSemanticCorpusAssembler` and existing VAML concept compilation/encryption.

The runner requires two separate 32-byte base64url secrets through environment variables:

```text
VAML_SEMANTIC_KEY
VAML_PACK_KEY
```

They are never stored in the build plan.

Default encrypted shard size is `50000` concepts.

## Build plan

The build plan is itself private because it contains private filesystem locations and digests.

Logical example:

```json
{
  "format": "vaml-private-corpus-build-plan",
  "version": "0.1",
  "runId": "world-corpus-2026-09-21",
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
    "shardSize": 50000
  },
  "policy": {
    "minQuality": 0.5,
    "missingAlignment": "reject",
    "chunkRows": 100000,
    "cleanupTemp": true
  }
}
```

Public schema: `spec/schema/private-corpus-build-plan-0.1.schema.json`.

## CLI

From `sdk/typescript`:

```bash
VAML_SEMANTIC_KEY=<base64url-32-byte-secret> \
VAML_PACK_KEY=<base64url-32-byte-secret> \
npm run private-corpus-run -- /secure/vaml/build-plan.json
```

The runner does not download source material. Snapshot acquisition and source-specific extraction remain explicit private preprocessing steps so licensing, provenance, version pinning, and reproducibility can be handled by the deployment.

## Build receipt

A successful build creates a private `*.build.receipt.json` containing:

- run ID and timestamps;
- verified input digests;
- build policy;
- candidate/quality/alignment/deduplication counters;
- final corpus statistics;
- sorted corpus digest;
- encrypted shard pack IDs and SHA-256 digests;
- corpus manifest digest.

The receipt provides reproducibility and audit evidence without exposing keys.

## Fail-closed behavior

The build MUST fail when:

- an input checksum does not match;
- a source is missing or disabled;
- a source license is unresolved/placeholder text;
- a snapshot emits another source's records;
- a required alignment is missing under `reject` mode;
- an alignment shard checksum is invalid;
- an alignment shard attempts path traversal;
- a sensitive path resolves inside the public repository;
- encryption keys are not exactly 32 bytes;
- corpus accounting does not match encrypted output.

## Non-goals

Runner 0.1 does not:

- scrape websites automatically;
- bypass source terms or access controls;
- decide whether two source senses are semantically equivalent;
- expose private concept mappings to human-facing interfaces;
- claim that encrypted or opaque representations are impossible to reverse engineer by an operator controlling the authorized runtime and keys.

Semantic alignment remains a private upstream process. The runner verifies and consumes its outputs.
