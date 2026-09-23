/**
 * Symbol-domain closed-loop calibration v2 tests (deterministic, seeded).
 *
 * v2 measures the channel IN the 26 ms symbol domain through the same
 * encodeAcousticSymbols generator as the evidence probe: Round 1 (uniform)
 * yields per-symbol gains g_s plus the confusion matrix, TX amplitudes are
 * derived, and Round 2 (compensated) yields MEASURED effective gains e_s.
 * The receiver uses only e_s; theory (g_s x t_s^2) is diagnostic-only.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  analyzeEvidenceWav,
  EVIDENCE_PAYLOAD_HEX,
  expectedPacketSymbols,
} from "../src/acoustic-evidence.js";
import {
  buildCalibrationV2,
  deriveTxAmplitudes,
  encodeAcousticSymbols,
  encodeCalibratedEvidenceBurst,
  encodeSymbolCalibration,
  loadChannelCalibrationV2,
  measureSymbolRound,
  serializeChannelCalibrationV2,
  SYMBOL_CAL_PATTERN,
  toEvidenceEqualizationV2,
} from "../src/acoustic-calibration.js";

const SAMPLE_RATE = 48000;
const SYMBOL_MS = 26;
const SPS = Math.round((SAMPLE_RATE * SYMBOL_MS) / 1000);
const LEAD = Math.round(SAMPLE_RATE * 0.25);
const PAYLOAD = Buffer.from(EVIDENCE_PAYLOAD_HEX, "hex");
const PREAMBLE = [0, 3, 1, 2, 0, 3, 1, 2, 3, 0, 2, 1, 3, 0, 2, 1, 0, 2, 3, 1, 0, 2, 3, 1, 2, 0, 1, 3, 2, 0, 1, 3];
const PACKET_SYMBOLS = expectedPacketSymbols();
const ALL_SYMBOLS = [...PREAMBLE, ...PACKET_SYMBOLS];
const ROUNDS = 16;

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

function silence(seconds: number): Float64Array {
  return new Float64Array(Math.round(SAMPLE_RATE * seconds));
}

function concat(parts: Float64Array[]): Float64Array {
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

function addHum(samples: Float64Array, amplitude: number, frequency: number): Float64Array {
  const out = Float64Array.from(samples);
  for (let i = 0; i < out.length; i++) out[i] += Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE) * amplitude;
  return out;
}

function floatToWav(samples: Float64Array): Buffer {
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + samples.length * 2, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
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

const sha256 = (wav: Buffer): string => createHash("sha256").update(wav).digest("hex");

function calSequence(rounds = ROUNDS): number[] {
  const symbols: number[] = [];
  for (let r = 0; r < rounds; r++) for (const s of SYMBOL_CAL_PATTERN) symbols.push(s);
  return symbols;
}

/** Flat per-carrier amplitude gains over symbol regions. */
function applyBurstGains(content: Float64Array, contentStart: number, symbols: number[], gains: readonly number[]): Float64Array {
  const out = Float64Array.from(content);
  for (let i = 0; i < symbols.length; i++) {
    const at = contentStart + i * SPS;
    for (let k = 0; k < SPS && at + k < out.length; k++) out[at + k] *= gains[symbols[i]];
  }
  return out;
}

/**
 * Deterministic nonlinear physical channel: flat per-carrier gains are
 * applied separately, then per-band saturation (weak/high paths compress
 * first, like small drivers at excursion limits) plus mild AGC pumping.
 * Boosting a carrier into its knee changes its effective gain, which is
 * exactly what linear theory cannot predict.
 */
function nonlinearChannel(
  samples: Float64Array,
  symbols: number[] | null,
  contentStart: number,
  drives: readonly number[],
  agcDepth: number,
): Float64Array {
  const attack = Math.exp(-1 / (SAMPLE_RATE * 0.005));
  const release = Math.exp(-1 / (SAMPLE_RATE * 0.2));
  const out = new Float64Array(samples.length);
  let env = 0;
  for (let i = 0; i < samples.length; i++) {
    let drive = 1.2;
    if (symbols) {
      const idx = Math.floor((i - contentStart) / SPS);
      if (idx >= 0 && idx < symbols.length) drive = drives[symbols[idx]];
    }
    const ax = Math.abs(samples[i]);
    env = ax > env ? attack * env + (1 - attack) * ax : release * env + (1 - release) * ax;
    const agc = 1 / (1 + agcDepth * env);
    const v = samples[i] * agc;
    out[i] = (Math.tanh(v * drive) / drive) * agc;
  }
  return out;
}

test("symbol calibration shares the probe encoder and sequence layout", () => {
  const seq = encodeSymbolCalibration(SAMPLE_RATE, [0.72, 0.72, 0.72, 0.72], ROUNDS);
  assert.equal(seq.symbols.length, ROUNDS * 4);
  for (let i = 0; i < seq.symbols.length; i++) assert.equal(seq.symbols[i], i % 4);
  const sps = Math.round((SAMPLE_RATE * SYMBOL_MS) / 1000);
  assert.equal(seq.samples.length, LEAD + seq.symbols.length * sps + LEAD);
  assert.equal(seq.contentStart, LEAD);
  // Same generator as the probe: identical inputs produce identical outputs.
  const again = encodeAcousticSymbols(seq.symbols, SAMPLE_RATE, [0.72, 0.72, 0.72, 0.72]);
  assert.deepEqual(Buffer.from(again.buffer), Buffer.from(seq.samples.buffer));
});

test("Round 1 detects hum-room confusion in the symbol domain", () => {
  const channel = [1.1, 0.6, 1.8, 0.22];
  const seq = encodeSymbolCalibration(SAMPLE_RATE, [0.72, 0.72, 0.72, 0.72], ROUNDS);
  const channeled = applyBurstGains(seq.samples, seq.contentStart, seq.symbols, channel);
  const file = concat([silence(0.3), addHum(addWhiteNoise(channeled, 0.02, 4242), 0.2, 800), silence(0.3)]);
  const round1 = measureSymbolRound(file, SAMPLE_RATE, calSequence());
  // The 2000 Hz symbols collapse onto 800 Hz, exactly the observed class.
  assert.ok(round1.confusion[3][0] > 0.5, `C[3][0] = ${round1.confusion[3][0]}`);
  assert.ok(round1.diagonal[0] > 0.9, `diagonal[0] = ${round1.diagonal[0]}`);
  // Hum also clips a few 1200/1600 Hz symbols (14/16 here): the gate must
  // flag exactly this, not hide it.
  assert.ok(round1.diagonal[1] > 0.8, `diagonal[1] = ${round1.diagonal[1]}`);
  assert.ok(round1.diagonal[2] > 0.8, `diagonal[2] = ${round1.diagonal[2]}`);
  // Gains track the physical imbalance.
  assert.ok(round1.symbolGains[2] > round1.symbolGains[0]);
  assert.ok(round1.symbolGains[0] > round1.symbolGains[3]);
});

test("confusion is independently recomputable from winners (R3)", () => {
  const seq = encodeSymbolCalibration(SAMPLE_RATE, [0.72, 0.72, 0.72, 0.72], ROUNDS);
  const file = concat([silence(0.3), addWhiteNoise(seq.samples, 0.03, 7), silence(0.3)]);
  const round = measureSymbolRound(file, SAMPLE_RATE, calSequence());
  for (let s = 0; s < 4; s++) {
    for (let r = 0; r < 4; r++) {
      const recomputed = round.decisions.filter((d) => d.expected === s && d.winner === r).length;
      assert.equal(recomputed, round.confusionCounts[s][r], `C[${s}][${r}]`);
      assert.ok(round.decisions.every((d) => d.rawPowers.length === 4 && d.normalizedPowers.length === 4));
    }
  }
});

test("v2 provenance is enforced: SHAs and structure reject tampering", () => {
  const channel = [1.1, 0.6, 1.8, 0.22];
  const v2 = buildClosedLoopV2(channel, { hum: 0.2, nonlinear: false });
  const serialized = serializeChannelCalibrationV2(v2);
  const back = loadChannelCalibrationV2(serialized);
  assert.equal(back.version, "vaml-acoustic-calibration/2");
  assert.equal(back.round1Sha256, v2.round1Sha256);
  assert.deepEqual(back.effectiveRxGains, v2.effectiveRxGains);

  const noSha = JSON.parse(serialized);
  delete noSha.round1Sha256;
  assert.throws(() => loadChannelCalibrationV2(JSON.stringify(noSha)), /round1Sha256/);
  const badSha = JSON.parse(serialized);
  badSha.round2Sha256 = "not-a-hash";
  assert.throws(() => loadChannelCalibrationV2(JSON.stringify(badSha)), /round2Sha256/);
  const badCounts = JSON.parse(serialized);
  badCounts.round1.confusionCounts[3][0] += 1;
  assert.throws(() => loadChannelCalibrationV2(JSON.stringify(badCounts)), /row total|mismatch/);
  const badWinner = JSON.parse(serialized);
  const flip = badWinner.round1.decisions.find((d: { expected: number; winner: number }) => d.expected === 0);
  flip.winner = (flip.winner + 1) % 4;
  assert.throws(() => loadChannelCalibrationV2(JSON.stringify(badWinner)), /mismatch/);
  assert.throws(() => loadChannelCalibrationV2(JSON.stringify({ version: "vaml-acoustic-calibration/1" })), /v2/);

  // Closed-loop integrity: Round 2 must use the derived TX amplitudes.
  const wrongTx = [...v2.txAmplitudes] as [number, number, number, number];
  wrongTx[0] = Math.min(1, wrongTx[0] + 0.01);
  assert.throws(
    () =>
      buildCalibrationV2({
        sampleRate: SAMPLE_RATE,
        rounds: ROUNDS,
        round1Samples: v2round1Samples(channel),
        round1Sha256: v2.round1Sha256,
        round2TxAmplitudes: wrongTx,
        round2Samples: v2round2Samples(channel, v2.txAmplitudes),
        round2Sha256: v2.round2Sha256,
      }),
    /closed loop broken/,
  );
});

test("nonlinear channel: theory FAILs while measured Round-2 e_s PASSes (same test)", () => {
  // Per-band saturation (weak/high path compresses first) + mild AGC.
  const channel = [1.0, 0.5, 1.6, 0.3];
  const drives = [1.2, 1.5, 1.2, 10.0];
  const v2 = buildClosedLoopV2(channel, { nonlinear: true, drives, hum: 0.12 });
  // Theory and measurement genuinely diverge here.
  const predicted = v2.diagnosticComparison.predictedEffectiveGains;
  const measured = v2.diagnosticComparison.measuredEffectiveGains;
  const divergence = Math.max(...predicted.map((p, i) => Math.abs(p - measured[i])));
  assert.ok(divergence > 0.2, `predicted vs measured diverge by ${divergence.toFixed(3)}`);

  const evidence = nonlinearEvidence(channel, drives, v2.txAmplitudes);
  const theory = analyzeEvidenceWav(evidence, {
    frequenciesHz: [800, 1200, 1600, 2000],
    rxGains: [...predicted],
  }, "theoretical-gains");
  assert.notEqual(theory.verdict, "VERIFIED PASS");
  assert.ok(!theory.bursts.some((b) => b.passed));
  assert.ok(!theory.combined || !theory.combined.passed);

  const view = toEvidenceEqualizationV2(v2);
  const fixed = analyzeEvidenceWav(evidence, {
    frequenciesHz: view.frequenciesHz,
    rxGains: view.rxGains,
    provenance: view.provenance,
  }, "v2-closed-loop");
  assert.equal(fixed.verdict, "VERIFIED PASS");
  assert.equal(fixed.equalization?.applied, true);
  assert.equal((fixed.equalization as { kind: string }).kind, "v2-measured");
  assert.equal(fixed.equalization?.round1Sha256, v2.round1Sha256);
  assert.equal(fixed.equalization?.round2Sha256, v2.round2Sha256);
  assert.equal(fixed.bursts[0].preambleMatches, 32);
});

test("hum-room v2 regression: legacy PARTIAL, Round-2 e_s PASS, source labeled", () => {
  const channel = [1.1, 0.6, 1.8, 0.22];
  const v2 = buildClosedLoopV2(channel, { hum: 0.2, nonlinear: false });

  const evidence = humEvidence(channel, v2.txAmplitudes);
  const legacy = analyzeEvidenceWav(evidence);
  assert.equal(legacy.verdict, "VERIFIED PARTIAL");
  assert.ok(legacy.bursts[0].rawHeaderHex.startsWith("564140"));
  assert.equal(legacy.bursts[0].decodedLength, 8);

  const view = toEvidenceEqualizationV2(v2);
  const fixed = analyzeEvidenceWav(evidence, {
    frequenciesHz: view.frequenciesHz,
    rxGains: view.rxGains,
    provenance: view.provenance,
  }, "v2-closed-loop");
  assert.equal(fixed.verdict, "VERIFIED PASS");
  assert.equal((fixed.equalization as { kind: string }).kind, "v2-measured");
});

// ---------------------------------------------------------------- helpers ---

function v2round1Samples(channel: readonly number[]): Float64Array {
  const seq = encodeSymbolCalibration(SAMPLE_RATE, [0.72, 0.72, 0.72, 0.72], ROUNDS);
  const channeled = applyBurstGains(seq.samples, seq.contentStart, seq.symbols, channel);
  return concat([silence(0.3), addHum(addWhiteNoise(channeled, 0.02, 4242), 0.2, 800), silence(0.3)]);
}

function v2round2Samples(channel: readonly number[], tx: readonly [number, number, number, number]): Float64Array {
  const seq = encodeSymbolCalibration(SAMPLE_RATE, tx, ROUNDS);
  const channeled = applyBurstGains(seq.samples, seq.contentStart, seq.symbols, channel);
  return concat([silence(0.3), addHum(addWhiteNoise(channeled, 0.02, 4343), 0.2, 800), silence(0.3)]);
}

function buildClosedLoopV2(
  channel: readonly number[],
  opts: { hum: number; nonlinear: boolean; drives?: readonly number[] },
): ReturnType<typeof buildCalibrationV2> {
  const seq = encodeSymbolCalibration(SAMPLE_RATE, [0.72, 0.72, 0.72, 0.72], ROUNDS);
  let r1 = applyBurstGains(seq.samples, seq.contentStart, seq.symbols, channel);
  if (opts.nonlinear) r1 = nonlinearChannel(r1, seq.symbols, seq.contentStart, opts.drives ?? [1.2, 1.5, 1.2, 10.0], 0.5);
  const r1file = concat([silence(0.3), addHum(addWhiteNoise(r1, 0.02, 4242), opts.hum, 800), silence(0.3)]);
  const r1wav = floatToWav(r1file);
  const r1measured = measureSymbolRound(r1file, SAMPLE_RATE, calSequence());
  const derived = deriveTxAmplitudes(r1measured.symbolGains, 0.72);
  const seq2 = encodeSymbolCalibration(SAMPLE_RATE, derived.txAmplitudes, ROUNDS);
  let r2 = applyBurstGains(seq2.samples, seq2.contentStart, seq2.symbols, channel);
  if (opts.nonlinear) r2 = nonlinearChannel(r2, seq2.symbols, seq2.contentStart, opts.drives ?? [1.2, 1.5, 1.2, 10.0], 0.5);
  const r2file = concat([silence(0.3), addHum(addWhiteNoise(r2, 0.02, 4343), opts.hum, 800), silence(0.3)]);
  const r2wav = floatToWav(r2file);
  return buildCalibrationV2({
    sampleRate: SAMPLE_RATE,
    rounds: ROUNDS,
    round1Samples: r1file,
    round1Sha256: sha256(r1wav),
    round2TxAmplitudes: derived.txAmplitudes,
    round2Samples: r2file,
    round2Sha256: sha256(r2wav),
  });
}

function humEvidence(channel: readonly number[], tx: readonly [number, number, number, number]): Buffer {
  const content = encodeCalibratedEvidenceBurst(PAYLOAD, SAMPLE_RATE, tx);
  const channeled = applyBurstGains(content, LEAD, ALL_SYMBOLS, channel);
  return floatToWav(concat([silence(0.5), addHum(addWhiteNoise(channeled, 0.02, 4444), 0.2, 800), silence(0.5)]));
}

function nonlinearEvidence(
  channel: readonly number[],
  drives: readonly number[],
  tx: readonly [number, number, number, number],
): Buffer {
  const content = encodeCalibratedEvidenceBurst(PAYLOAD, SAMPLE_RATE, tx);
  const channeled = applyBurstGains(content, LEAD, ALL_SYMBOLS, channel);
  const pumped = nonlinearChannel(channeled, ALL_SYMBOLS, LEAD, drives, 0.5);
  return floatToWav(concat([silence(0.5), addHum(addWhiteNoise(pumped, 0.02, 4444), 0.12, 800), silence(0.5)]));
}
