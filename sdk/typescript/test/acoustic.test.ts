import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  acousticFingerprint,
  decodeVamlFrameFromWav,
  encodeVamlFrameToWav,
} from "../src/index.js";

test("acoustic transport round-trips an opaque encrypted VAML frame", () => {
  const frame = randomBytes(96);
  const wav = encodeVamlFrameToWav(frame);
  const decoded = decodeVamlFrameFromWav(wav);
  assert.deepEqual(decoded, frame);
  assert.equal(acousticFingerprint(wav).length, 64);
});

test("acoustic transport rejects a corrupted packet", () => {
  // Deterministic corruption: zero one complete 10 ms symbol window in the body. The
  // emptied window has zero Goertzel power at every carrier, so its symbol decodes to 0,
  // the recovered byte differs from the transmitted 0xab byte, and the CRC must fail.
  const frame = Buffer.alloc(48, 0xab);
  const wav = encodeVamlFrameToWav(frame);
  const symbolSamples = 480; // 10 ms @ 48 kHz
  // 44-byte WAV header; 30 ms leading silence (1440 samples); 16 preamble symbols;
  // body symbol 128 (packet byte 32 = payload byte 24).
  const symbolStartSample = 1440 + (16 + 128) * symbolSamples;
  const byteOffset = 44 + 2 * symbolStartSample;
  const damaged = Buffer.from(wav);
  for (let i = 0; i < 2 * symbolSamples; i++) damaged[byteOffset + i] = 0;
  assert.throws(() => decodeVamlFrameFromWav(damaged), /CRC|preamble|magic|Truncated/);

  // Analog-tolerance case: 512 zeroed bytes mid-file damage two adjacent symbols
  // partially. The receiver may still decide them correctly, in which case the frame
  // is recovered bit-for-bit and no error is the correct outcome. The decoder must
  // never return a frame different from the transmitted one without throwing.
  for (let n = 0; n < 5; n++) {
    const randomFrame = randomBytes(48);
    const clean = encodeVamlFrameToWav(randomFrame);
    const midpoint = Math.floor(clean.length / 2);
    const flaky = Buffer.from(clean);
    for (let i = 0; i < 512 && midpoint + i < flaky.length; i++) flaky[midpoint + i] = 0;
    try {
      const decoded = decodeVamlFrameFromWav(flaky);
      assert.deepEqual(decoded, randomFrame, "decoder silently returned a corrupted frame");
    } catch (error) {
      assert.match(error instanceof Error ? error.message : String(error), /CRC|preamble|magic|Truncated|WAV/);
    }
  }
});
