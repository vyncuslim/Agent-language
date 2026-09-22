# VAML Live Acoustic Hardware Test

This test validates the physical acoustic path:

```text
synthetic opaque frame
→ VAML Acoustic 4-FSK
→ real speaker
→ air / room
→ real microphone
→ preamble + clock recovery
→ CRC
→ recovered frame
```

It does not use production semantic content, vocabulary, session keys or production credentials.

## Requirements

- Node.js 20+
- npm dependencies installed (`npm ci`)
- a modern browser with WebAudio + microphone support
- a real speaker and microphone
- microphone permission for `http://127.0.0.1`

Use speakers rather than headphones for the physical loopback test.

## Start

From `Agent-language/sdk/typescript`:

### Windows PowerShell / Windows Terminal

```powershell
npm.cmd run test:audio:live
```

### macOS / Linux

```sh
npm run test:audio:live
```

The command starts a localhost-only server and prints:

```text
http://127.0.0.1:8787
```

Open that URL in Chrome, Edge, Safari or Firefox. Allow microphone access and press **Start physical loopback test**.

Recommended first test conditions:

- speaker volume: 50–70%
- distance: approximately 0.3–1 m
- quiet room
- headphones disconnected

## Reported fields

The page reports:

```text
TRANSMITTED FRAME
RECEIVED FRAME
BYTE MATCH: YES/NO
CLOCK DRIFT
CRC: PASS/FAIL
DECODE LATENCY
AUDIO SAMPLE RATE
CAPTURED AUDIO
```

A successful physical test requires both:

```text
BYTE MATCH: YES
CRC: PASS
```

`CLOCK DRIFT` is the estimated timing difference observed by the decoder. `DECODE LATENCY` is decoder compute time, not the total acoustic transmission duration.

## If the test fails

Check:

1. the browser has microphone permission;
2. the selected OS output device is the physical speaker;
3. the selected OS input device is the intended microphone;
4. headphones/Bluetooth routing are not preventing sound from reaching the microphone;
5. speaker volume is high enough but not clipping;
6. the room is reasonably quiet;
7. OS/browser echo cancellation or audio enhancement is not overriding the requested raw-audio constraints.

A failed physical test does not automatically mean VAML Core or TCP Agent communication is broken. Acoustic hardware reliability is a separate transport-layer property.

## Security boundary

Acoustic modulation is not encryption. A listener may record or demodulate the waveform. Confidentiality must come from the encrypted VAML frame placed inside Acoustic Transport. This hardware harness uses random opaque bytes only and is intended for transport validation.
