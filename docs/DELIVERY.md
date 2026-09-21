# VAML 0.2.4 experimental delivery

## Verification

On 2026-09-21, local Windows/Node 24:

- npm install: passed (initial baseline).
- npm ci: passed using the committed lockfile; audit reported 0 vulnerabilities.
- npm run build: passed; TypeScript strict checking includes runtime, tools, demos, tests and benchmark.
- npm test: 43 passed, 0 failed, 0 skipped; original and upstream tests retained.
- npm run demo: passed; independent Node A/B processes exchanged authenticated encrypted TCP frames and resolved private semantics.
- CLI subprocess tests exercised compile, inspect authorization, pack build/verify, and both multilingual world/corpus importers. The network demo executes compiled binary .vaml.
- npm run privacy and git diff whitespace checks: passed before commit.
- Synthetic benchmark: 10k, 100k and 1m concepts completed; final raw results are in benchmark-results.json.
- GitHub-hosted execution remains blocked by the observed billing/account runner failure; local test success is not a claim of remote CI success.

## Behavior delivered

Binary handshake and directional X25519/PSK/HKDF/AES-GCM sessions; encrypted active-set negotiation; bounded lazy PRF codebook and reverse map; strict typed graph IR and executable CLI; private ingestion with explicit senses and multilingual alias adapters; secret-derived identity including stable corpus identityMaterial; encrypted hash-partitioned shards, catalog pin/revision policy and LRU lookup; fail-closed validation with security regression tests.

The existing main commits through 61e49c2 (World Lexicon, World Semantic Corpus, Source Pack 1 and user-facing privacy boundary) were integrated without force-pushing or discarding their adapters/tests. Corpus schema version 0.1 is unrelated to retired VAML wire protocol 0.1.

## Measured benchmark

| Concepts | Build seconds | Encrypted MB | Peak RSS MiB | Handshake vocabulary entries |
| -------: | ------------: | -----------: | -----------: | ---------------------------: |
|    10000 |         1.760 |        2.625 |         72.6 |                            0 |
|   100000 |        13.498 |       25.069 |        207.9 |                            0 |
|  1000000 |       232.758 |      250.703 |        329.6 |                            0 |

See BENCHMARKS.md for decrypt/load, cold/hot lookup, codebook, encode/decode and methodology. No real private corpus or production secrets were committed.

## Remaining risks

See SECURITY.md. Principal boundaries are shared-PSK group identity, trusted durable rollback policy, synchronous cold-shard IO, Node memory zeroization limits, production rate limits and independent cryptographic review. Benchmarks are synthetic and do not establish world-language coverage or semantic correctness. Existing experimental packs/clients must be rebuilt for the hardened protocol; retired 0.1 mappings remain historical only.

History cleanup instructions are in HISTORY-MIGRATION.md. No history rewriting, repository/release/tag deletion or force push was performed.

## Changed files relative to integrated main

- .env.example
- .github/workflows/test.yml
- .gitignore
- AGENTS.md
- README.md
- VERSION
- docs/BENCHMARKS.md
- docs/CI-STATUS.md
- docs/DELIVERY.md
- docs/HISTORY-MIGRATION.md
- docs/SECURITY.md
- docs/benchmark-results.json
- sdk/typescript/bench/vocabulary.ts
- sdk/typescript/examples/agent-pair-demo.ts
- sdk/typescript/examples/network-agent-a.ts
- sdk/typescript/examples/network-agent-b.ts
- sdk/typescript/package-lock.json
- sdk/typescript/package.json
- sdk/typescript/src/cli.ts
- sdk/typescript/src/compiler.ts
- sdk/typescript/src/crypto.ts
- sdk/typescript/src/index.ts
- sdk/typescript/src/ingestion.ts
- sdk/typescript/src/learning.ts
- sdk/typescript/src/lexicon.ts
- sdk/typescript/src/negotiation.ts
- sdk/typescript/src/runtime.ts
- sdk/typescript/src/semantic-index.ts
- sdk/typescript/src/transport.ts
- sdk/typescript/src/types.ts
- sdk/typescript/src/vocabulary.ts
- sdk/typescript/test/network.test.ts
- sdk/typescript/test/runtime.test.ts
- sdk/typescript/test/security.test.ts
- sdk/typescript/test/vocabulary.test.ts
- sdk/typescript/test/world-lexicon.test.ts
- sdk/typescript/tools/build-private-lexicon.ts
- sdk/typescript/tools/build-world-lexicon.ts
- sdk/typescript/tools/build-world-semantic-corpus.ts
- sdk/typescript/tools/privacy-lint.ts
- sdk/typescript/tsconfig.json
- spec/AGENT-LEARNING-0.2.md
- spec/VAML-0.2.md
- spec/VOCABULARY-0.2.md
- spec/WORLD-LEXICON-0.2.md
- spec/WORLD-SEMANTIC-CORPUS-0.1.md
- vaml.manifest.json
