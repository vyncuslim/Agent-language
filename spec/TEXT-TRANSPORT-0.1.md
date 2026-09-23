# VAML Text Transport 0.1

Status: experimental reference.

## 1. Purpose

VAML Text Transport carries one **already-encrypted VAML frame** as
copy/paste-safe ASCII text between two computers (chat box, email, QR
payload, clipboard). It is transport armor only: modulation, not
encryption, not authentication.

```text
encrypted VAML frame bytes
        ↓ encode
VAMLTXT1.<base64url>.<crc32>
        ↓ copy / paste / QR
VAMLTXT1.<base64url>.<crc32>
        ↓ decode
identical encrypted VAML frame bytes
        ↓ session AEAD open
private semantic payload (or rejection)
```

## 2. Format

```text
VAMLTXT1 . <payload> . <checksum>
```

- Magic `VAMLTXT1`: ASCII, identifies format and version 1.
- Payload: base64url (RFC 4648 §5, alphabet `A–Z a–z 0–9 - _`), canonical
  encoding omits `=` padding. Decoders accept zero, one or two trailing
  `=` padding characters and nothing else outside the alphabet.
- Checksum: CRC32 of the raw frame bytes, 8 lowercase hex digits.
- The three segments are joined by exactly two ASCII `.` characters. The
  encoded text contains no whitespace.

Frame bounds: 1 to 1,048,576 bytes, matching the packet transports.
Empty frames are rejected. Text that would decode beyond the bound is
rejected before allocation.

## 3. Decode rules

1. Strip leading/trailing ASCII whitespace (`space`, `\t`, `\r`, `\n`)
   once — copy/paste routinely adds it. Inner whitespace rejects.
2. Split into exactly three `.`-separated segments.
3. Magic must equal `VAMLTXT1`.
4. Payload must match `[A-Za-z0-9_-]*` plus at most two trailing `=`.
5. Base64url-decode; reject empty or over-bound results.
6. CRC32 of the decoded bytes must equal the checksum segment.

Any violation fails closed with an error. A decoder MUST NOT return
partially recovered bytes.

## 4. Security notes

- The checksum is **transport corruption detection only**. It detects
  typos and truncation; it authenticates nothing.
- Confidentiality and authenticity come exclusively from the VAML session
  AEAD (`seal`/`open`). A pasted text that decodes byte-exact still fails
  at `open` unless it was sealed by the peer session (wrong key, replay,
  or forgery all reject there).
- Text frames are opaque: they expose frame length and timing, never
  concepts. Do not log pasted texts alongside session keys.
- Success rule for a copy/paste run: decode yields byte-identical input
  **and** the session `open` accepts it **and** the recovered payload is
  byte-exact. Proximity ("almost the same text") is never success.

## 5. Reference implementation

`sdk/typescript/src/text-transport.ts`:

```ts
encodeVamlFrameToText(frame)
decodeVamlFrameFromText(text)
```

Tests: `sdk/typescript/test/text-transport.test.ts`, including a
sealed-frame end-to-end run through text with AEAD verification.
