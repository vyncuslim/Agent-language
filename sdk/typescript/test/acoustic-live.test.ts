import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  AcousticMicrophoneReceiver,
  decodeVamlFrameFromMicrophonePcm,
  encodeVamlFrameToWav,
} from "../src/index.js";

function wavPcm16(wav: Buffer): Int16Array {
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  const dataLength = wav.readUInt32LE(40);
  const output = new Int16Array(dataLength / 2);
  for (let i = 0; i < output.length; i++) output[i] = wav.readInt16LE(44 + i * 2);
  return output;
}

function resampleByLength(input: Int16Array, outputLength: number): Int16Array {
  const output = new Int16Array(outputLength);
  if (input.length < 2 || outputLength < 2) return output;
  const scale = (input.length - 1) / (outputLength - 1);
  for (let i = 0; i < output.length; i++) {
    const p = i * scale;
    const left = Math.floor(p);
    const frac = p - left;
    const right = Math.min(input.length - 1, left + 1);
    output[i] = Math.round(input[left] * (1 - frac) + input[right] * frac);
  }
  return output;
}

function stretchClock(input: Int16Array, factor: number): Int16Array {
  return resampleByLength(input, Math.max(2, Math.round(input.length * factor)));
}

test("adaptive microphone decoder recovers +0.5% and -0.5% sample-clock drift", () => {
  const frame = randomBytes(96);
  const original = wavPcm16(encodeVamlFrameToWav(frame, { leadingSilenceMs: 80, trailingSilenceMs: 80 }));

  for (const factor of [0.995, 1.005]) {
    const recorded = stretchClock(original, factor);
    const decoded = decodeVamlFrameFromMicrophonePcm(recorded, {
      maxClockDriftPpm: 10_000,
      clockSearchStepPpm: 250,
      timingSearchSamples: 12,
    });
    assert.deepEqual(decoded.frame, frame);
    assert.ok(Math.abs(decoded.diagnostics.estimatedClockDriftPpm) <= 10_000);
  }
});

test("streaming microphone receiver resamples 44.1 kHz input and survives arbitrary chunk boundaries", () => {
  const frame = randomBytes(64);
  const pcm48 = wavPcm16(encodeVamlFrameToWav(frame, { leadingSilenceMs: 120, trailingSilenceMs: 120 }));
  const pcm441 = resampleByLength(pcm48, Math.round(pcm48.length * 44_100 / 48_000));
  const seen: Buffer[] = [];
  const receiver = new AcousticMicrophoneReceiver({
    inputSampleRate: 44_100,
    maxClockDriftPpm: 10_000,
    onFrame: (decoded) => seen.push(decoded.frame),
  });

  const chunks = [257, 997, 4096, 701, 2048, 313];
  let offset = 0;
  let chunkIndex = 0;
  while (offset < pcm441.length) {
    const size = chunks[chunkIndex++ % chunks.length];
    const end = Math.min(pcm441.length, offset + size);
    receiver.pushPcm16(pcm441.subarray(offset, end));
    offset = end;
  }

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], frame);
});

test("microphone receiver decodes zero-gap back-to-back acoustic packets", () => {
  const first = randomBytes(32);
  const second = randomBytes(48);
  const a = wavPcm16(encodeVamlFrameToWav(first, { leadingSilenceMs: 50, trailingSilenceMs: 0 }));
  const b = wavPcm16(encodeVamlFrameToWav(second, { leadingSilenceMs: 0, trailingSilenceMs: 50 }));
  const stream = new Int16Array(a.length + b.length);
  stream.set(a, 0);
  stream.set(b, a.length);

  const seen: Buffer[] = [];
  const receiver = new AcousticMicrophoneReceiver({ onFrame: (decoded) => seen.push(decoded.frame) });
  for (let offset = 0; offset < stream.length; offset += 1536) {
    receiver.pushPcm16(stream.subarray(offset, Math.min(stream.length, offset + 1536)));
  }

  assert.deepEqual(seen, [first, second]);
});

test("microphone receiver resynchronizes after a corrupted acoustic packet", () => {
  const badFrame = randomBytes(32);
  const goodFrame = randomBytes(40);
  const damaged = wavPcm16(encodeVamlFrameToWav(badFrame, { leadingSilenceMs: 50, trailingSilenceMs: 0 }));
  const good = wavPcm16(encodeVamlFrameToWav(goodFrame, { leadingSilenceMs: 0, trailingSilenceMs: 50 }));
  const corruptionStart = Math.floor(damaged.length * 0.65);
  for (let i = 0; i < 5000 && corruptionStart + i < damaged.length; i++) {
    damaged[corruptionStart + i] = 0;
  }
  const stream = new Int16Array(damaged.length + good.length);
  stream.set(damaged, 0);
  stream.set(good, damaged.length);

  const seen: Buffer[] = [];
  const failures: string[] = [];
  const receiver = new AcousticMicrophoneReceiver({
    onFrame: (decoded) => seen.push(decoded.frame),
    onDecodeError: (error) => failures.push(error.message),
  });
  for (let offset = 0; offset < stream.length; offset += 1024) {
    receiver.pushPcm16(stream.subarray(offset, Math.min(stream.length, offset + 1024)));
  }

  assert.equal(failures.length, 1);
  assert.match(failures[0], /CRC|frame size/);
  assert.deepEqual(seen, [goodFrame]);
});
