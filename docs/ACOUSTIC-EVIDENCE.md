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

## Channel calibration + carrier equalization

### v2 (formal path): 26 ms symbol-domain closed loop

Real rooms are not flat: one deployment showed ~51% of preamble energy on
1600 Hz but only ~12% on 1200 Hz, with systematic 2000 Hz → 800 Hz confusion
(`VAC1` byte `0x43` recovered as `0x40`). CRC rules and the `VERIFIED PASS`
definition are unchanged — calibration only levels the playing field.

Long-tone gains do not transfer to 26 ms symbols (ramps, guard/window, ISI,
AGC attack), so v2 calibrates **in the symbol domain through the same
`encodeAcousticSymbols` generator as the probe** (`[0,1,2,3]` × 40 rounds):

```text
Round 1 (uniform TX) → measure g_s + confusion matrix → derive TX
Round 2 (compensated TX) → MEASURE effectiveRxGains e_s (never g_s x t_s^2)
Probe: TX uses t_s, RX uses only measured e_s
```

Hard rules: ground-truth symbols never influence winners (statistics only;
`winner`/`rawPowers`/`normalizedPowers` all preserved); v2 JSON requires
`round1Sha256` + `round2Sha256` (loader REJECTS without them); TX is
`1/sqrt(gain)` clamped `[0.25, 4]` with `0.9` peak ceiling.

```bash
npm run acoustic:evidence -- capture.wav --calibration vaml-acoustic-calibration-v2.json
```

A `--calibration` file must be v2; v1 files are rejected (legacy
diagnostic only). The report prints the calibration source
(`v2 closed-loop (MEASURED ROUND 2)` plus both SHAs) so the gains used are
always auditable.

### v1 (legacy diagnostic): 750 ms tones

Retained with all its tests, but superseded: steady-state tone gains plus
re-applied long-tone RX normalization is double correction. v2 browser flow
(`tools/two-computer-acoustic-evidence.html`):

```text
B: Arm Symbol Cal Round 1 → A: Send Round 1 → B saves Round-1 WAV + profile
A: load Round 1 profile → B: Arm Round 2 → A: Send Compensated Round 2
B: saves Round-2 WAV + v2 JSON → A: load v2 → B: Arm Evidence
A: Send Calibrated Probe → B: saves RAW evidence WAV
```

Page DSP mirrors `src/acoustic-calibration.ts`; cross-check it after edits:

```bash
npm run build
node dist/tools/xcheck-page-cal.js
```

The calibration JSON contains channel physics only — no keys or secrets.
Real capture WAVs stay out of the repo (see `.gitignore`).
