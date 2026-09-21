# Security controls and validation boundaries

The runtime is experimental reference software, not a completed independent cryptographic audit.

| Threat                         | Implemented control / regression evidence                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| GCM nonce reuse                | Independent directional HKDF keys; nonce = zero32 + monotonically increasing uint64 sequence; control/data share the counter; overflow fails |
| Replay / order                 | Strictly increasing receive sequence; replay and every-byte corruption tests                                                                 |
| Reflection / session confusion | Role-bound confirmation, different send/receive keys, transcript-bound session ID and KDF; cross-session and reflection tests                |
| Downgrade                      | Exact 0.2 version, required feature bitmap, bounded frame/type negotiation, pinned catalog set and expected peer                             |
| MITM without deployment secret | X25519 secret mixed with deployment PSK; mandatory confirmation; wrong-key TCP tests                                                         |
| Unknown concept injection      | Authorized resolver and bounded encrypted active set; unknown data codes and Concept references fail                                         |
| Code collisions                | Detect within active set, fail and require fresh session; no ambiguous order-based mapping                                                   |
| Pack tampering / wrong key     | AES-GCM, purpose-separated KDF/AAD, authenticated digest, strict nonce/tag/salt/algorithm checks                                             |
| Pack replay / rollback         | Mandatory trusted catalog pin plus minimum revision; tests reject old policy revision and shard substitution                                 |
| Unauthorized vocabulary load   | Correct pack key and pinned catalog required; aliases in runtime packs are rejected                                                          |
| Malformed / oversized frames   | Header, type, length, reference and aggregate bounds; truncation, fuzzed bytes and TCP advertised-size tests                                 |
| Resource exhaustion            | 1 MiB packets, bounded queue, field/active-set caps, concurrent connection cap, idle/absolute deadline, bounded record input and shard cache |
| Sealed logging                 | Generic errors, ciphertext HEX and numeric counts; inspect reveals only authorized opaque structural metadata                                |
| Private vocabulary leakage     | No source dictionaries or production keys, import-only alias adapter, .gitignore and privacy lint                                            |

Tests preserve the original runtime cases and add crypto negative paths, TCP fragmentation/EOF, private import alignment, catalog routing/rollback and real CLI subprocesses. Every passing test has an assertion against actual behavior; no security predicate is replaced by an unconditional success.

## Remaining risks

- The pack-derived PSK authenticates a trust group. Any other holder can impersonate a configured peer ID. Use pair-specific deployment trust or authenticated device identities/mTLS before connecting mutually untrusted agents.
- Pin/revision policy must live in trusted durable storage. Returning both stored data and policy to an earlier valid state defeats rollback detection.
- TCP length, timing, catalog digest, peer token and connection metadata remain visible. Encryption is not traffic-analysis resistance.
- Cold shard loading is synchronous, which can stall the Node event loop. The connection cap is not a distributed/per-principal rate limiter; high-load deployment needs worker isolation and admission controls.
- Objects, immutable strings, V8 copies and KeyObjects cannot be proven erased by fill(0). A process owner with keys can inspect private semantics.
- Exact canonical semantic equality deduplicates records; the importer does not establish factual correctness, synonymy or cross-language meaning by itself.
- The benchmark uses synthetic numeric records, not a world corpus. Large embeddings and relation graphs increase storage/memory substantially.
- Compiled .vaml files contain stable private IDs and typed application data. Keep them private and access-controlled; only negotiated encrypted frames belong on the network.
- The low-level SDK is for trusted local callers. Supplying an unscoped resolver, modifying exposed maps/counters or sharing session state across processes violates its contract.
- Pack encryption uses random salt/nonce per pack. Deployments need a sound operating-system RNG, key rotation and secure provisioning.
- No autonomous tool execution is included. Applications must independently authorize every requested action.
- Existing public 0.1 history remains public. Git cleanup cannot revoke distributed copies.
