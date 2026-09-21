# Measured vocabulary benchmark

Recorded 2026-09-21, Windows, Node v24.11.1, AMD Ryzen AI 7 350, approximately 15.1 GiB installed usable RAM. See benchmark-results.json for unrounded machine output.

```sh
cd sdk/typescript
npm run build
npm run benchmark
# Individual size:
npm run benchmark -- --size 100000
```

Each size runs in a separate Node process with --expose-gc. Inputs are generated numeric semantic records with short vectors, not production vocabulary. Build timing includes normalization, HMAC identity generation, encrypted temporary fragments, cross-batch deduplication, all final shards and encrypted catalog disk writes. Pack bytes include the JSON/base64 encryption envelope and catalog, excluding temporary fragments.

| Metric                                      |    10k |   100k |      1m |
| ------------------------------------------- | -----: | -----: | ------: |
| Unique concepts                             |  10000 | 100000 | 1000000 |
| Pack build (s)                              |  1.760 | 13.498 | 232.758 |
| Total encrypted pack size (MB, decimal)     |  2.625 | 25.069 | 250.703 |
| Catalog decrypt/load (ms)                   |  3.525 |  4.532 |   9.697 |
| All shards decrypt/load/validate (s)        |  0.272 |  1.217 |   9.801 |
| First cold semantic lookup (ms)             |  1.694 |  8.053 |  54.618 |
| Hot semantic lookup mean (µs)               |  4.096 |  4.300 |   5.020 |
| Two-sided key agreement + confirmation (ms) |  5.643 |  9.588 |  36.355 |
| Vocabulary shards loaded during handshake   |      0 |      0 |       0 |
| Concepts derived during handshake           |      0 |      0 |       0 |
| Active concepts                             |     16 |     16 |      16 |
| Codebook derivation per side (ms)           |  0.466 |  0.654 |   3.021 |
| Encode mean (µs)                            | 30.205 | 26.125 |  35.093 |
| Decode mean (µs)                            | 23.690 | 21.610 |  25.359 |
| Sample frame bytes                          |     75 |     75 |      75 |
| Final RSS (MiB)                             |   70.9 |  206.2 |   299.8 |
| Final JS heap used (MiB)                    |   11.9 |   62.8 |    57.7 |
| Process peak RSS (MiB)                      |   72.6 |  207.9 |   329.6 |

Hot lookup uses 10,000 queries against 16 concepts in one loaded shard. Derivation is measured after that shard is loaded. Cold lookups across many different buckets will be slower and can evict cache entries. Encode/decode measurements average 2000 sequential one-field frames; network RTT and model inference are not included. All-shard load traverses the catalog explicitly for verification while retaining only the bounded cache, not all one million concepts in memory.

The observed handshake timings vary with CPU scheduling, GC and background machine load. They do not imply O(N) vocabulary work: instrumented loaded-shard and derived-concept counts are zero for every size. The benchmark verifies the important structural property, not a constant wall-clock latency guarantee.

The million-concept builder spends time on encrypted staging and repeated bucket merging. It is functional, not optimized for throughput. Future work can reduce fragment merges without changing the lazy session protocol. Large embeddings, annotations and relations increase real corpus costs; these numbers are not claims of world-language coverage, semantic correctness or model intelligence.
