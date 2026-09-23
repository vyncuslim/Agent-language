/**
 * Offline acoustic evidence analyzer tests (deterministic, seeded).
 *
 * Synthesizes evidence-probe WAVs in memory with the exact probe profile
 * (26 ms, 800/1200/1600/2000 Hz 4-FSK, 32-symbol preamble, fixed payload
 * a34f912c770de851, VAC1 + length + payload + CRC32) and checks the
 * analyzer verdicts. No randomness without a fixed seed; no real
 * recordings are committed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeEvidenceWav,
  EVIDENCE_FREQUENCIES,
  EVIDENCE_PAYLOAD_HEX,
  EVIDENCE_PREAMBLE,
  expectedPacketSymbols,
} from "../src/acoustic-evidence.js";

const SAMPLE_RATE = 48_000;
const SYMBOL_MS = 26;
const SPS = Math.round((SAMPLE_RATE * SYMBOL_MS) / 1000); // 1248
const PREAMBLE = [...EVIDENCE_PREAMBLE];
const FREQS = [...EVIDENCE_FREQUENCIES];
const AMPLITUDE = 0.72;
const PAYLOAD = Buffer.from(EVIDENCE_PAYLOAD_HEX, "hex");

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function packetFor(payload: Buffer): Buffer {
  const packet = Buffer.alloc(4 + 4 + payload.length + 4);
  packet.write("VAC1", 0, "ascii");
  packet.writeUInt32BE(payload.length, 4);
  payload.copy(packet, 8);
  packet.writeUInt32BE(crc32(packet.subarray(0, 8 + payload.length)), 8 + payload.length);
  return packet;
}

function bytesToSymbols(data: Uint8Array): number[] {
  const out: number[] = [];
  for (const byte of data) out.push((byte >>> 6) & 3, (byte >>> 4) & 3, (byte >>> 2) & 3, byte & 3);
  return out;
}

function encodeBurstFloat(payload: Buffer, sampleRate = SAMPLE_RATE): Float64Array {
  const symbols = [...PREAMBLE, ...bytesToSymbols(packetFor(payload))];
  const sps = Math.round((sampleRate * SYMBOL_MS) / 1000);
  const lead = Math.round(sampleRate * 0.25);
  const tail = Math.round(sampleRate * 0.25);
  const ramp = Math.max(1, Math.min(Math.floor(sps / 10), 64));
  const out = new Float64Array(lead + symbols.length * sps + tail);
  let cursor = lead;
  let phase = 0;
  for (const sym of symbols) {
    const step = (2 * Math.PI * FREQS[sym]) / sampleRate;
    for (let i = 0; i < sps; i++) {
      const edge = Math.min(1, i / ramp, (sps - 1 - i) / ramp);
      out[cursor++] = Math.sin(phase) * AMPLITUDE * Math.max(0, edge);
      phase += step;
      if (phase > Math.PI * 2) phase -= Math.PI * 2;
    }
  }
  return out;
}

function floatToWav(samples: Float64Array, sampleRate = SAMPLE_RATE): Buffer {
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + samples.length * 2, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    wav.writeInt16LE(Math.round(v * (v < 0 ? 32768 : 32767)), 44 + i * 2);
  }
  return wav;
}

function silence(seconds: number): Float64Array {
  return new Float64Array(Math.round(SAMPLE_RATE * seconds));
}

function concatFloat(parts: Float64Array[]): Float64Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float64Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function addWhiteNoise(samples: Float64Array, amplitude: number, seed: number): Float64Array {
  const rng = mulberry32(seed);
  const out = Float64Array.from(samples);
  for (let i = 0; i < out.length; i++) out[i] += (rng() * 2 - 1) * amplitude;
  return out;
}

/** Overwrite one full packet symbol with a loud wrong tone (deterministic damage).
 *  The replacement symbol is guaranteed to differ from the expected one, so a
 *  zeroed-symbol "lucky recovery" (all-zero input decodes as symbol 0) cannot
 *  silently pass: a wrong carrier always decodes wrong. contentStart is the
 *  sample index of the first burst symbol (after lead-in silence). */
function overwritePacketSymbol(file: Float64Array, contentStart: number, packetSymbolIndex: number): void {
  const expected = bytesToSymbols(packetFor(PAYLOAD))[packetSymbolIndex];
  const replacement = (expected + 1) % 4;
  const at = contentStart + (PREAMBLE.length + packetSymbolIndex) * SPS;
  const ramp = Math.max(1, Math.min(Math.floor(SPS / 10), 64));
  let phase = 0;
  const step = (2 * Math.PI * FREQS[replacement]) / SAMPLE_RATE;
  for (let i = 0; i < SPS && at + i < file.length; i++) {
    const edge = Math.min(1, i / ramp, (SPS - 1 - i) / ramp);
    file[at + i] = Math.sin(phase) * 0.9 * Math.max(0, edge);
    phase += step;
    if (phase > Math.PI * 2) phase -= Math.PI * 2;
  }
}

function stretchLinear(samples: Float64Array, factor: number): Float64Array {
  const outLength = Math.max(2, Math.round(samples.length * factor));
  const out = new Float64Array(outLength);
  const scale = (samples.length - 1) / (outLength - 1);
  for (let i = 0; i < outLength; i++) {
    const p = i * scale;
    const left = Math.floor(p);
    const frac = p - left;
    const right = Math.min(samples.length - 1, left + 1);
    out[i] = samples[left] * (1 - frac) + samples[right] * frac;
  }
  return out;
}

const LEAD_SAMPLES = Math.round(SAMPLE_RATE * 0.25);

/** Encode one burst with surrounding silence; returns content (symbol) start. */
function encodeFile(payload: Buffer, preSec = 0.5, postSec = 0.5): { file: Float64Array; contentStart: number } {
  const burst = encodeBurstFloat(payload);
  const pre = Math.round(SAMPLE_RATE * preSec);
  const file = concatFloat([silence(preSec), burst, silence(postSec)]);
  return { file, contentStart: pre + LEAD_SAMPLES };
}

function singleBurstWav(): Buffer {
  return floatToWav(encodeFile(PAYLOAD).file);
}

function threeBurstFile(): { wav: Buffer; contentStarts: number[]; contentLength: number } {
  const burst = encodeBurstFloat(PAYLOAD);
  const content = burst.slice(LEAD_SAMPLES, burst.length - LEAD_SAMPLES);
  const gap = silence(0.65);
  const pre = silence(0.5);
  const parts: Float64Array[] = [pre];
  const starts: number[] = [];
  let cursor = pre.length;
  for (let i = 0; i < 3; i++) {
    starts.push(cursor);
    parts.push(content);
    cursor += content.length;
    if (i < 2) { parts.push(gap); cursor += gap.length; }
  }
  parts.push(silence(0.5));
  return { wav: floatToWav(concatFloat(parts)), contentStarts: starts, contentLength: content.length };
}

test("clean synthetic evidence WAV verifies as VERIFIED PASS", () => {
  const report = analyzeEvidenceWav(singleBurstWav());
  assert.equal(report.wav.valid, true);
  assert.equal(report.wav.sampleRate, SAMPLE_RATE);
  assert.equal(report.wav.channels, 1);
  assert.equal(report.wav.bitsPerSample, 16);
  assert.equal(report.wav.sha256.length, 64);
  assert.equal(report.verdict, "VERIFIED PASS");
  assert.equal(report.bursts.length, 1);
  const burst = report.bursts[0];
  assert.equal(burst.preambleMatches, 32);
  assert.equal(burst.preamble.length, 32);
  assert.equal(burst.packetSymbols.length, expectedPacketSymbols().length);
  assert.equal(burst.magicOk, true);
  assert.equal(burst.decodedLength, PAYLOAD.length);
  assert.equal(burst.receivedPayloadHex, EVIDENCE_PAYLOAD_HEX);
  assert.equal(burst.byteErrors, 0);
  assert.equal(burst.bitErrors, 0);
  assert.equal(burst.crcOk, true);
  assert.equal(burst.payloadMatch, true);
  assert.equal(burst.carriers.length, 4);
});

test("leading silence does not prevent VERIFIED PASS", () => {
  const { file } = encodeFile(PAYLOAD, 2.0, 0.5);
  const report = analyzeEvidenceWav(floatToWav(file));
  assert.equal(report.verdict, "VERIFIED PASS");
  assert.ok(report.bursts[0].timing.startSeconds > 1.5);
});

test("moderate fixed-seed noise still verifies as VERIFIED PASS", () => {
  const { file } = encodeFile(PAYLOAD);
  const noisy = addWhiteNoise(file, 0.05, 0xe71d1ce5);
  const report = analyzeEvidenceWav(floatToWav(noisy));
  assert.equal(report.verdict, "VERIFIED PASS");
  assert.equal(report.bursts[0].payloadMatch, true);
});

test("sample-clock drift is recovered and reported in ppm", () => {
  const { file } = encodeFile(PAYLOAD);
  const drifted = stretchLinear(file, 1.005);
  const report = analyzeEvidenceWav(floatToWav(drifted));
  assert.equal(report.verdict, "VERIFIED PASS");
  const drift = report.bursts[0].timing.clockDriftPpm;
  assert.ok(Math.abs(drift) <= 25_000, `drift ${drift} outside +-25000 ppm`);
  assert.ok(Math.abs(drift - 5000) < 2000, `expected ~+5000 ppm, got ${drift}`);
});

test("one corrupted packet symbol fails CRC and never passes silently", () => {
  const { file, contentStart } = encodeFile(PAYLOAD);
  overwritePacketSymbol(file, contentStart, 10);
  const report = analyzeEvidenceWav(floatToWav(file));
  assert.equal(report.verdict, "VERIFIED PARTIAL");
  assert.equal(report.bursts[0].crcOk, false);
  // Symbol 10 sits in the VAC1 header, so the damage must be localizable
  // at the symbol layer even though the payload bytes are untouched.
  const damaged = report.bursts[0].packetSymbols[10];
  assert.notEqual(damaged.decoded, damaged.expected);
  assert.ok(damaged.confidence > 0);
  for (const b of report.bursts) assert.equal(b.passed, false);
  assert.ok(!report.combined || !report.combined.passed);
});

test("pure random noise is VERIFIED FAIL", () => {
  const seeded = mulberry32(123456789);
  const noise = new Float64Array(Math.round(SAMPLE_RATE * 3));
  for (let i = 0; i < noise.length; i++) noise[i] = (seeded() * 2 - 1) * 0.3;
  const report = analyzeEvidenceWav(floatToWav(noise));
  assert.equal(report.verdict, "VERIFIED FAIL");
  assert.equal(report.combined, null);
});

test("unrelated single tone is VERIFIED FAIL", () => {
  const tone = new Float64Array(Math.round(SAMPLE_RATE * 3));
  for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 0.5;
  const report = analyzeEvidenceWav(floatToWav(tone));
  assert.equal(report.verdict, "VERIFIED FAIL");
});

test("corrupted VAC1 magic never verifies as PASS", () => {
  const { file, contentStart } = encodeFile(PAYLOAD);
  overwritePacketSymbol(file, contentStart, 0);
  overwritePacketSymbol(file, contentStart, 1);
  const report = analyzeEvidenceWav(floatToWav(file));
  assert.equal(report.verdict, "VERIFIED PARTIAL");
  assert.equal(report.bursts[0].magicOk, false);
  for (const b of report.bursts) assert.equal(b.passed, false);
});

test("three bursts with one intact burst verify as VERIFIED PASS", () => {
  const { wav, contentStarts, contentLength } = threeBurstFile();
  const raw = Buffer.from(wav);
  // Overwrite burst 1 and burst 3 symbol regions with fixed-seed noise.
  const pcm = new Int16Array(raw.buffer, raw.byteOffset + 44, (raw.length - 44) / 2);
  const rng = mulberry32(777);
  for (const burstIndex of [0, 2]) {
    for (let i = 0; i < contentLength; i++) {
      const at = contentStarts[burstIndex] + i;
      if (at >= 0 && at < pcm.length) pcm[at] = Math.round((rng() * 2 - 1) * 12000);
    }
  }
  const report = analyzeEvidenceWav(raw);
  assert.equal(report.verdict, "VERIFIED PASS");
  assert.ok(report.bursts.some((b) => b.passed));
});

test("three differently-damaged bursts soft-combine to VERIFIED PASS", () => {
  const gap = silence(0.65);
  const damaged = [20, 50, 70].map((symbol) => {
    const { file, contentStart } = encodeFile(PAYLOAD);
    overwritePacketSymbol(file, contentStart, symbol);
    return file.slice(contentStart, contentStart + (PREAMBLE.length + expectedPacketSymbols().length) * SPS);
  });
  const file = concatFloat([silence(0.5), damaged[0], gap, damaged[1], gap, damaged[2], silence(0.5)]);
  const report = analyzeEvidenceWav(floatToWav(file));
  assert.equal(report.verdict, "VERIFIED PASS");
  assert.ok(report.bursts.every((b) => !b.passed), "individual damaged bursts must not pass alone");
  assert.ok(report.combined && report.combined.passed, "strict soft combination must recover the exact frame");
  assert.equal(report.combined!.payloadHex, EVIDENCE_PAYLOAD_HEX);
});
