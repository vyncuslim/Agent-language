# VAML 0.2 private World Concept Space architecture

The target is an extensible World Concept Space, not an exhaustive public list of words. A concept can have Chinese, English, Malay, Japanese and other expressions. A single expression may refer to several distinct concepts. Agent-to-Agent transmission carries session codes for concepts, never an expression chosen as a universal semantic opcode.

## Ingestion pipeline

datasets -> bounded reader -> normalizer -> explicit sense splitter -> semantic records -> relations / domains / optional embeddings -> semantic deduplication -> secret-derived identities -> hash partitioning -> authenticated encrypted shards + encrypted catalog.

ConceptSourceRecord contains semantic and optional aliases, relations, domains, embedding, metadata. An import row may provide an explicit senses array; each element becomes a separate semantic record sharing import aliases. Importers do not pretend to infer correct real-world senses from arbitrary text. The dataset/model must supply semantic alignment and provenance.

JSONL and CSV are streamed with a 1 MiB record limit. CSV headers name fields and each nonempty cell contains JSON data, using standard CSV quoting. JSON input is a top-level array capped at 64 MiB; large datasets should use streaming formats. Semantic nesting is capped at 32, semantic records at 64 KiB, embedding dimension at 4096. Semantic strings normalize to NFC; aliases normalize with NFKC and trimming.

Multilingual private rows with conceptKey/language/lexeme remain supported through WorldConceptAssembler and pack:world. Those rows must be grouped and sorted by private conceptKey. Each source sense aligns expressions into one concept. Production sources and source keys remain private.

## Identity and deduplication

concept_id = HMAC-SHA256(semantic_key, canonical_semantic_record).

The secret is exactly 32 bytes. Concept IDs are 32 bytes encoded as canonical unpadded base64url in local APIs. Aliases and domains do not affect identity. Equal normalized semantics deduplicate even across languages, domains and input batches. Distinct semantic senses remain separate. Duplicate domains/relations are merged; conflicting metadata or embeddings fail rather than silently replacing information.

The builder strips aliases before writing runtime shards. PrivateImportAliases can retain a private ingestion index when needed; it is never included in the network path or encrypted runtime pack. CompiledConceptRecord.aliases is retained only as a compatibility type marker and is rejected by pack/index validation. A caller requiring lexical learning must explicitly supply a private adapter.

Relations are private graph annotations. Their target identifiers and relation schema must be aligned by the dataset adapter; this runtime does not claim to perform automatic cross-dataset ontology matching. Structural validation alone is not semantic fact checking.

## Encrypted storage and routing

There are 256 routing buckets selected by the first byte of the secret concept ID. The builder buffers at most 16,384 source records with a 16 MiB buffered-data flush threshold, writes encrypted temporary fragments, merges/deduplicates each bucket, then publishes content-addressed .vocab shards. The .build-* staging directory is deleted on success or failure. No plaintext intermediate vocabulary is written. A process crash can leave encrypted staging or orphaned encrypted shard files; operational cleanup is a deployment responsibility.

Each shard holds at most 50,000 concepts and 64 MiB plaintext. Pack encryption uses a fresh 32-byte salt, HKDF-SHA256 and fresh 96-bit GCM nonce. AAD binds protocol, document purpose and pack digest. Payload digests, algorithm identifiers and exact parameter lengths are checked; sensitive comparisons use timingSafeEqual.

The encrypted catalog contains revision, total concept count and at most 256 bucket entries (filename, authenticated pack digest and concept count). Catalog and shard use distinct KDF/AAD domains. Files are addressed by authenticated digest; arbitrary paths and traversal are rejected. Shards are published first; a new immutable content-addressed catalog is published last. Old files are not silently overwritten.

ShardedSemanticIndex requires an externally pinned catalog ID and minimum revision. This prevents substitution/rollback relative to trusted policy. An old valid pack is not intrinsically invalid: a trusted deployment must advance the pin/revision durably. If an attacker can roll back both the packs and the trusted policy, cryptography alone cannot detect it. The CLI never selects "latest" from an untrusted directory.

Opening the catalog decrypts only bounded routing metadata. Lookup reads one bucket and creates a private concept map. An LRU holds four shards by default. Hot lookup is O(1); cold lookup includes disk read/decrypt/parse/validation of one shard. Synchronous reference lookups can block Node's event loop, so large network deployments should prewarm allowed active sets or place storage work in a worker.

## Session scale

Handshake exchanges a compact catalog digest and does not enumerate concepts, derive codes or load shards. After authenticated confirmation, encrypted active-set negotiation selects at most 4096 concepts. Codes are HMAC-derived lazily, and a compact reverse dictionary handles decode in constant time. Cost is O(k), not O(N).

The measured 1m synthetic run had 0 loaded shards and 0 derived concepts immediately after handshake. See ../docs/BENCHMARKS.md for all measured metrics, method and limitations.

## Beyond one million

A million concepts fits the implemented 256 buckets (approximately 3906 concepts per bucket for uniform keyed IDs). 50,000 per bucket is an enforced upper bound, not an unlimited-size claim. Larger deployments should introduce a new authenticated catalog version with multi-byte/radix routing, subordinate catalogs and per-domain access boundaries. No fallback should scan all records during handshake.

World-scale retrieval will also require private ANN/graph indexes, dataset licensing, provenance, ontology alignment, deduplication quality assessment, key rotation, update distribution and authorization policy. The reference learner's nearest-neighbor query is an explicit local linear scan for small loaded indexes; it is not invoked by handshake and is not a million-concept ANN implementation.

Memory depends on record size, embedding dimensions and cold shards, not only concept count. Numeric synthetic benchmark records do not represent the storage cost or semantic quality of a licensed world knowledge corpus.

For corpus adapters that supply explicit private identityMaterial, identity uses HMAC-SHA256 over a canonical object containing identityVersion (vaml-private-identity/0.1) and identityMaterial. This preserves identity across evidence/domain enrichment while keeping differently aligned concepts distinct. The importer normalizes and preserves that private material through ID derivation, then omits it from compiled runtime records. This is an explicit private semantic alignment source, never a public word-to-code registry.
