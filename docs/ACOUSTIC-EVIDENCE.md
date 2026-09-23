# Offline VAML Acoustic Evidence Analyzer

Independent offline verification for the two-computer acoustic probe
(`sdk/typescript/tools/two-computer-acoustic-evidence.html`). The browser
page PASS/FAIL indicator is **not** evidence; the analyzer below is.

## Capture (Computer B)

1. On Computer B, open `two-computer-acoustic-evidence.html` and click
   **Arm Evidence Receiver**.
2. Wait for **LISTENING — SEND NOW**, then send from Computer A.
3. Save the raw capture WAV **without editing it**
   (e.g. `vaml-two-computer-evidence-48000hz.wav`).
4. Never commit real captures (see `.gitignore`).

## Analyze

```bash
cd sdk/typescript
npm run acoustic:evidence -- vaml-two-computer-evidence-48000hz.wav
npm run acoustic:evidence -- vaml-two-computer-evidence-48000hz.wav --json report.json
```

Example output:

```text
SHA-256: ...
Sample rate: 48000 Hz
Duration: 17.2 s

Bursts detected: 3

Burst 1:
Preamble 32/32
VAC1 PASS
Length 8
Payload a34f...
Bit errors 2
CRC FAIL

Burst 2:
...

Combined:
VAC1 PASS
Length 8
Payload a34f912c770de851
Bit errors 0
CRC PASS

VERIFIED PASS
```

## Known probe profile

26 ms symbols, 4-FSK 800/1200/1600/2000 Hz, 2 bits/symbol,
32-symbol preamble, 3 repetitions, 650 ms gap, fixed payload
`a34f912c770de851`, packet `VAC1 + length + payload + CRC32`.

CRC32 here is **transport corruption detection only**, not cryptographic
authentication (authentication belongs to the VAML session).

## Verdict rules

- **VERIFIED PASS** — at least one physical burst, or the strict
  soft-combined packet, shows `VAC1 valid + length valid + CRC PASS +
  payload == a34f912c770de851`. Nothing passes on "close enough".
- **VERIFIED PARTIAL** — packet structure partially recovered
  (e.g. valid header but CRC fails, or clear preamble/carriers with
  measurable payload bit errors). The report names the evidence.
- **VERIFIED FAIL** — no burst recovered VAML packet structure.

Detection is matched (carrier-energy scan → known-preamble correlation →
candidate peaks → separation → timing refinement over ±25000 ppm), never a
bare RMS threshold. Per-symbol timing uses preamble-derived global timing
plus small bounded correction. Soft combining weights each 2-bit symbol by
carrier confidence across bursts and re-verifies VAC1/length/CRC/exact
match; it never bypasses CRC.

## Tests

Deterministic seeded synthetic tests (no real recordings committed):

```bash
npm test -- test/acoustic-evidence.test.ts
```

Covers clean PASS, leading silence, moderate noise, clock drift,
single-symbol corruption (CRC failure, never silent), noise-only FAIL,
unrelated-tone FAIL, corrupted-magic never-PASS, 3-burst single-intact
PASS, and damaged-burst soft-combine PASS.

A real two-computer run counts as **VERIFIED PASS** only after this
analyzer reports `CRC PASS + BYTE EXACT MATCH` on an actual Computer B
evidence WAV.
