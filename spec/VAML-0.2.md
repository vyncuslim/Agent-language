# VAML 0.2 public protocol specification

Status: experimental; this revision hardens the earlier 0.2 architecture. Earlier experimental handshakes and source boolean payloads are intentionally incompatible and fail closed. No 0.1 decoder or opcode bridge exists.

## Layers and identity

1. Public specification: binary framing, numeric type tags, limits and cryptography.
2. Private semantic layer: canonical machine records, relations and optional embeddings.
3. Private ingestion adapters: multilingual expressions and explicit sense alignment, excluded from runtime packs.
4. Session-local codebook: bounded active concepts, no permanent public semantic integers.
5. Encrypted transport: binary TCP packets and authenticated VAML envelopes.

A concept identity is base64url(HMAC-SHA256(semantic_key, canonical_semantic_record)), exactly 32 bytes. The semantic record must already be normalized through ingestion. Object keys use deterministic ordinal ordering. Aliases, domains and annotations do not determine identity. Different senses require different semantic records. Normalization uses NFC for semantic strings, NFKC/trim for import aliases. No public dictionary is needed or supplied.

## Handshake

Every connection uses a fresh X25519 key pair and 32-byte nonce. Binary hello:

| Field                                           |      Bytes |
| ----------------------------------------------- | ---------: |
| V2 magic, major 0, minor 2                      |          4 |
| peer ID length                                  |          1 |
| opaque configured peer ID (ASCII token, max 64) |   variable |
| DER SPKI X25519 public key                      |         44 |
| random nonce                                    |         32 |
| catalog count                                   |          1 |
| pinned catalog digests                          | count × 32 |
| maximum frame bytes, big-endian                 |          4 |
| supported type bitmap                           |          2 |
| required feature bitmap (127)                   |          1 |

Catalog count is 1–32. The reference network path uses one pinned catalog. No semantic concept list is sent in plaintext. All required features, protocol versions, peer IDs and catalog sets are checked; the complete decoded hellos are canonically ordered by peer ID and included in the KDF/confirmation transcript. A resolver MUST be scoped to exactly the pinned shared catalog; SDK callers must not pass a union of unshared vocabularies.

The network authentication key is HKDF-SHA256(pack_key, zero32, "VAML-0.2/network-peer-auth"). The X25519 secret is mixed with this key through HMAC-SHA256, then HKDF-SHA256 with the transcript digest derives low-to-high, high-to-low, codebook and confirmation keys. Peer IDs determine direction. Each direction has a different AEAD key. Confirmation HMACs include the transcript and sender ID, so reflection fails. Runtime traffic is rejected until the remote confirmation passes a timing-safe comparison.

PSK possession authenticates a trust group, not a unique device among other holders. Pin distinct authenticated identities or use mTLS for mutually untrusted peers. A successful key exchange alone does not authorize a tool.

## Active set and lazy codebook

After confirmation, A sends an encrypted control frame (kind 1) containing concatenated 32-byte concept IDs. B validates each ID against its own authorized pinned index, derives the mapping, then returns an empty encrypted acknowledgment (kind 2). The network adapter sends semantic data only after this acknowledgment.

For each active concept:

```text
session_code = first64(HMAC-SHA256(session_codebook_key, concept_id_bytes))
```

A maximum of 4096 unique concepts is permitted. Reverse resolution is an O(1) Map from code to concept; it never scans vocabulary. Code collisions fail the negotiation and require a fresh session; no order-dependent remapping is allowed. Active-set updates in this reference connection are a single bounded transaction. Create another connection for a different set or more messages.

Handshake cost depends on compact catalog metadata, not vocabulary cardinality. Active-set creation costs O(k) HMAC operations plus at most k cold shard reads; cold lookup can be materially slower than hot lookup.

## Frame and nonce

TCP prefixes every packet with a 4-byte big-endian size (1–1,048,576). Each established-session VAML frame is:

| Field                                         | Bytes |
| --------------------------------------------- | ----: |
| V2 magic                                      |     2 |
| major 0, minor 2                              |     2 |
| kind: data 0, active set 1, acknowledgment 2  |     1 |
| reserved zero                                 |     1 |
| session ID (first64 transcript digest)        |     8 |
| monotonically increasing directional sequence |     8 |
| nonce: zero32 followed by sequence64          |    12 |
| ciphertext length                             |     4 |
| ciphertext                                    |     N |
| AES-256-GCM authentication tag                |    16 |

All 38 header bytes are AAD. Sequence starts at 1 and is never reused with the same directional key, including across control and data frames. Reject values above uint64; rekey by creating a new session. Strictly increasing receive sequences reject duplicates and out-of-order frames. Tag failure does not advance receive state; authenticated malformed payloads consume the sequence and terminate the network exchange. Reflection, wrong session IDs, nonce/header tampering, truncated/trailing data and unexpected frame kinds are rejected.

No semantic labels, aliases or stable concept IDs are serialized in public handshake fields. Encrypted data uses 64-bit session codes for both field identities and Concept values. Typed user data may include text/JSON but is always encrypted; it is never interpreted as a semantic opcode.

## Data payload and graph edges

Each field is session_code64 | type8 | length32 | value. All integers are big-endian. Maximum 4096 fields and 1 MiB total encrypted frame size.

| Type | Value                                              |
| ---- | -------------------------------------------------- |
| 00   | empty                                              |
| 01   | unsigned 64-bit integer                            |
| 02   | signed 64-bit integer                              |
| 03   | finite IEEE float64                                |
| 04   | one binary byte, 0 or 1                            |
| 05   | byte sequence                                      |
| 06   | strict UTF-8 data                                  |
| 07   | 8-byte session code referring to an active concept |
| 08   | uint32 reference to a zero-based field index       |
| 09   | UTF-8 JSON data                                    |

Unknown and unnegotiated types, invalid lengths, invalid booleans, nonfinite numbers, unnegotiated concepts and dangling references fail. Reference-valued fields express graph edges; the field concept supplies the private relation semantics. Cycles are structurally allowed and must be handled by the consuming model/policy.

## Source and compilation

Text machine IR is V2, followed by P and the opaque peer ID, followed by F lines containing opaque concept ID, two-digit type tag, and base64url binary payload (dash for empty). Public grammar markers are not semantic labels. IDs are strict canonical base64url, not English aliases or legacy opcodes.

The offline compiler emits VC 00 02, peer-length8, peer bytes, field-count16, then records containing concept-id32, type8, length32 and typed binary data. Offline Concept values are 32-byte private IDs; session compilation replaces them with 8-byte active codes. Compilation rejects malformed input before output and does not generate reusable pre-encrypted frames. Build artifacts are private and bounded to approximately 1 MiB.

Inspect requires the explicit local --authorized flag and prints only IDs/types/peer metadata, never semantic records. This flag is operator intent, not an authentication mechanism; filesystem access controls remain necessary. Run resolves authorized concepts, negotiates the peer session and sends encrypted frames.

## Bounds and sealed operation

TCP queues are capped at eight packets / 2 MiB; advertised sizes are checked before allocation. Idle timeout is 10 seconds and the whole connection has a 15-second deadline. The server permits 16 concurrent connections, one request/response per connection. Higher-level deployments still need per-principal rate limits and connection admission policy.

Normal logs contain only HEX ciphertext, counts and generic failure categories. Decrypted semantics and aliases must not be logged. close() clears exposed session key buffers and maps; Node/V8 copies, KeyObjects, immutable strings and privileged process inspection are outside guaranteed zeroization.

Frame integrity, private pack authorization and runtime syntax never grant permission to execute a tool or modify external state.

For corpus adapters that supply explicit private identityMaterial, identity uses HMAC-SHA256 over a canonical object containing identityVersion (vaml-private-identity/0.1) and identityMaterial. This preserves identity across evidence/domain enrichment while keeping differently aligned concepts distinct. The importer normalizes and preserves that private material through ID derivation, then omits it from compiled runtime records. This is an explicit private semantic alignment source, never a public word-to-code registry.
