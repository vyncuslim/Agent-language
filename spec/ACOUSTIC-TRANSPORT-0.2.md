# VAML Acoustic Transport 0.2

## Purpose

VAML Acoustic Transport 0.2 extends the 0.1 byte-over-sound profile with live microphone capture, adaptive synchronization and sample-clock recovery.

It remains a transport for already-encrypted VAML frames. It is not Morse code, speech, a sound-to-concept dictionary, or a replacement semantic language.

```text
AI Agent semantic state
        ↓
VAML authenticated encryption
        ↓
opaque encrypted frame
        ↓
4-FSK acoustic modulation
        ↓
speaker / room / microphone
        ↓
stream resampling
        ↓
preamble synchronization
        ↓
symbol-clock estimation + timing recovery
        ↓
opaque encrypted frame
        ↓
VAML authenticated decode
        ↓
peer AI Agent
```

## Reference modules

```text
sdk/typescript/src/acoustic.ts
sdk/typescript/src/acoustic-live.ts
sdk/typescript/src/acoustic-browser.ts
```

`acoustic.ts` remains the deterministic WAV/reference codec.

`acoustic-live.ts` adds microphone-oriented PCM streaming, sample-rate conversion, preamble lock and adaptive clock recovery.

`acoustic-browser.ts` connects the transport to browser microphone and speaker APIs while preserving the browser permission boundary.

## Clock recovery

Real speaker and microphone devices do not share one perfect sample clock. A receiver MUST NOT assume that every transmitted 10 ms symbol occupies exactly the nominal number of captured samples for an entire packet.

The reference live decoder therefore performs:

1. coarse preamble discovery;
2. fine search over candidate samples-per-symbol values around the nominal clock;
3. estimation of sample-clock drift in parts per million;
4. early/late local timing search around each predicted symbol boundary;
5. continuous boundary correction instead of cumulative integer rounding;
6. CRC validation before returning the recovered encrypted frame.

The default search range is ±10,000 ppm (±1%). Deployments may configure a smaller or larger bounded range where hardware characteristics are known.

Clock recovery is a transport property. It MUST NOT change concept identities, session codes, semantic records, VAML sequence numbers or cryptographic keys.

## Synchronization

The fixed acoustic preamble is used only to find packet timing and estimate the symbol clock.

A receiver MAY encounter arbitrary leading silence or unrelated room audio before the preamble. The live decoder keeps a bounded rolling PCM buffer and searches only a bounded leading interval.

A false synchronization candidate MUST NOT be treated as an authenticated VAML message. Packet magic, length bounds, CRC and finally VAML AEAD authentication all remain required.

## Microphone streaming

`AcousticMicrophoneReceiver` accepts continuous PCM chunks. Chunk boundaries have no protocol meaning and may occur in the middle of a transport symbol.

Primary APIs:

```ts
new AcousticMicrophoneReceiver(...)
receiver.pushPcm16(chunk)
receiver.pushFloat32(chunk)
decodeVamlFrameFromMicrophonePcm(recording)
```

The receiver:

- resamples the microphone input rate to the selected acoustic profile rate;
- preserves resampler phase across callback chunks;
- buffers only a configured bounded amount of audio;
- acquires and retains a clock lock while a packet is incomplete;
- can recover multiple acoustic packets from one continuous stream;
- emits only complete CRC-valid encrypted VAML frame bytes.

## Browser microphone

`startBrowserAcousticMicrophone()` uses `navigator.mediaDevices.getUserMedia()` and WebAudio.

The browser permission prompt is authoritative. The implementation MUST NOT attempt to bypass microphone consent.

Speech-oriented DSP defaults to disabled:

```text
echoCancellation = false
noiseSuppression = false
autoGainControl = false
```

These processors may alter narrow-band modem carriers. A deployment can explicitly override constraints after hardware testing.

`playVamlFrameThroughBrowserSpeaker()` provides the matching browser speaker path for one encrypted frame.

## Security boundary

Acoustic 0.2 does not obtain secrecy from unusual sounds.

Anyone who records the waveform may reproduce the public acoustic demodulator and recover the encrypted bytes. Security continues to come from the VAML authenticated encrypted session and private semantic runtime.

Never place production session keys, pack keys, semantic keys, private mappings or plaintext conversation state in the acoustic header.

Microphone audio is untrusted transport input. Successfully demodulating a packet does not grant authorization. The recovered VAML frame must still pass normal protocol/session validation and AEAD authentication.

## Limits

The 4-FSK reference profile prioritizes inspectability and robustness over throughput. It is not yet a high-bandwidth voice-band modem.

Production room deployment SHOULD additionally evaluate:

- multipath and echo;
- frequency response of small speakers/microphones;
- clipping;
- impulsive noise;
- long-frame clock stability;
- frequency offset;
- optional forward error correction and interleaving;
- periodic re-synchronization for very long frames;
- retransmission/acknowledgement policy.

## Compatibility

0.2 keeps the 0.1 `VAC1` packet payload format and audible 4-FSK profile. The changes are receiver-side synchronization, clock recovery and live hardware adapters, so existing 0.1-generated acoustic packets remain decodable.
