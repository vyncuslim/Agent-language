# VAML Acoustic Transport 0.1

## Purpose

VAML Acoustic Transport allows two authorized AI Agents to carry an already-encrypted VAML frame over sound.

It is an acoustic transport/modulation layer, not a second semantic language and not Morse code.

```text
Agent semantic state
        ↓
VAML encrypted/authenticated frame
        ↓
Acoustic modulation
        ↓
speaker / audio stream / file
        ↓
microphone / audio stream / file
        ↓
Acoustic demodulation
        ↓
original encrypted VAML frame
        ↓
VAML authenticated decode
        ↓
peer Agent semantic state
```

## Non-goals

Acoustic Transport MUST NOT define mappings such as:

```text
1200 Hz = search
1800 Hz = yes
2400 Hz = concept-X
```

Frequencies encode only transport symbols/bits. Human-readable words, private concept identities, session codes, aliases and semantic meanings are never assigned stable sounds.

The reference transport is therefore not Morse code and not a public sound-to-meaning vocabulary.

## Reference profile

The TypeScript reference implementation exposes `AUDIBLE_4FSK_PROFILE`:

- sample rate: 48 kHz;
- mono PCM16 WAV;
- symbol duration: 10 ms;
- four audible carriers: 1200, 1800, 2400 and 3000 Hz;
- each detected carrier represents one 2-bit transport symbol;
- a fixed synchronization preamble precedes the packet;
- packet header includes magic + encrypted frame length;
- CRC-32 detects acoustic corruption before the VAML frame reaches the authenticated protocol decoder.

The CRC is not a security primitive. VAML AEAD remains responsible for confidentiality and authentication.

## Security boundary

Acoustic modulation does not make a VAML conversation secret by itself.

Anyone who records the sound may be able to recover the transmitted encrypted bytes if they know or reproduce the public acoustic codec. They still require the authorized VAML session material and semantic runtime to authenticate/decrypt/interpret the message.

Do not claim that humans cannot record, inspect or demodulate the waveform.

Never place production session keys, semantic keys, pack keys or private concept mappings inside the acoustic header.

## API

Reference implementation:

```text
sdk/typescript/src/acoustic.ts
```

Primary APIs:

```ts
encodeVamlFrameToWav(frame)
decodeVamlFrameFromWav(wav)
```

These APIs accept/return opaque VAML frame bytes. They do not parse semantic content.

## Live speaker/microphone deployments

The reference codec deliberately separates modulation from hardware access.

A deployment may connect the codec to:

- browser Web Audio;
- native microphone/speaker APIs;
- WebRTC audio tracks;
- virtual audio devices;
- stored WAV files.

Live deployments SHOULD add automatic gain control, noise filtering, resynchronization, bounded buffering and explicit device permissions around the codec.

## Future profiles

Additional profiles may include:

- higher-throughput audible FSK/OFDM;
- ultrasonic carriers where hardware and local rules permit;
- noisy-room robust chirp spread spectrum;
- forward error correction.

Every profile must remain a byte transport. It must not create stable sound-to-concept mappings.
