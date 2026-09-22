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
  // Deterministic corruption: zero two complete 10 ms symbol windows in the body.
  // The decoder trial-decodes a run of preamble candidate offsets (tone windows are
  // phase-invariant, so a shifted grid can survive a single zeroed window and recover
  // the frame bit-for-bit - a legitimate outcome). Two adjacent zeroed windows exceed
  // every candidate grid's recovery margin, so the CRC must fail.
  const frame = Buffer.alloc(48, 0xab);
  const wav = encodeVamlFrameToWav(frame);
  const symbolSamples = 480; // 10 ms @ 48 kHz
  // 44-byte WAV header; 30 ms leading silence (1440 samples); 16 preamble symbols;
  // body symbols 128-129 (packet bytes 32-33 = payload bytes 24-25).
  const symbolStartSample = 1440 + (16 + 128) * symbolSamples;
  const byteOffset = 44 + 2 * symbolStartSample;
  const damaged = Buffer.from(wav);
  for (let i = 0; i < 4 * symbolSamples; i++) damaged[byteOffset + i] = 0;
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

test("acoustic transport decodes through 40 dB white noise (deterministic preamble false-lock guard)", () => {
  // Goertzel tone decisions are phase-invariant, so a preamble candidate offset
  // one ramp early also scores a full 16/16 match. With quiet pre-preamble noise
  // the old decoder could lock that early offset, misalign the symbol grid, and
  // fail the CRC. This test uses the exact seed that reproduced the CRC failure
  // before the fix: the frame must now decode byte-for-byte.
  function mulberry32(seed: number) {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const frame = randomBytes(256);
  const wav = encodeVamlFrameToWav(frame);
  const n = (wav.length - 44) / 2;
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const clean = new Int16Array(n);
  for (let i = 0; i < n; i++) clean[i] = view.getInt16(44 + 2 * i, true);
  let energy = 0;
  for (const sample of clean) energy += sample * sample;
  const sigma = Math.sqrt(energy / n) / 100; // 40 dB SNR
  const rand = mulberry32(1);
  let spare: number | null = null;
  const gauss = () => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    let u = 0;
    while (u === 0) u = rand();
    const v = rand();
    const m = Math.sqrt(-2 * Math.log(u));
    spare = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  };
  const noisy = new Int16Array(n);
  for (let i = 0; i < n; i++)
    noisy[i] = Math.max(-32768, Math.min(32767, Math.round(clean[i] + gauss() * sigma)));
  const damaged = Buffer.from(wav);
  const outView = new DataView(damaged.buffer, damaged.byteOffset, damaged.byteLength);
  for (let i = 0; i < n; i++) outView.setInt16(44 + 2 * i, noisy[i], true);
  assert.deepEqual(decodeVamlFrameFromWav(damaged), frame);
});
