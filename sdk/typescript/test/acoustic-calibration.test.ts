/**
 * Physical acoustic channel calibration + equalization tests.
 * Deterministic and seeded: an imbalanced frequency-selective channel with
 * fixed-seed noise reproduces the real-room symptom class (weak carriers
 * systematically outvoted), and calibration must fix it without touching
 * CRC rules or the VERIFIED PASS definition.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeEvidenceWav,
  EVIDENCE_PAYLOAD_HEX,
  expectedPacketSymbols,
} from "../src/acoustic-evidence.js";
import {
  CALIBRATION_MAX_COMPENSATION,
  CALIBRATION_MAX_TX_PEAK,
  CALIBRATION_MIN_COMPENSATION,
  encodeCalibratedEvidenceBurst,
  loadChannelCalibration,
  measureChannelCalibration,
  serializeChannelCalibration,
  synthesizeCalibrationTones,
  toEvidenceEqualization,
  CALIBRATION_SILENCE_MS,
  CALIBRATION_TONE_MS,
  CALIBRATION_LEAD_MS,
  type ChannelCalibration,
} from "../src/acoustic-calibration.js";

const SAMPLE_RATE = 48_000;
const SYMBOL_MS = 26;
const SPS = Math.round((SAMPLE_RATE * SYMBOL_MS) / 1000);
const LEAD = Math.round(SAMPLE_RATE * 0.25);
const FREQS = [800, 1200, 1600, 2000];
const PAYLOAD = Buffer.from(EVIDENCE_PAYLOAD_HEX, "hex");
const PREAMBLE = [0, 3, 1, 2, 0, 3, 1, 2, 3, 0, 2, 1, 3, 0, 2, 1, 0, 2, 3, 1, 0, 2, 3, 1, 2, 0, 1, 3, 2, 0, 1, 3];
const PACKET_SYMBOLS = expectedPacketSymbols();
const ALL_SYMBOLS = [...PREAMBLE, ...PACKET_SYMBOLS];

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

/** Continuous narrowband room interference (e.g. resonance/hum) at one carrier. */
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

/** Apply per-carrier amplitude gains to burst symbol regions (flat channel). */
function applyBurstChannel(content: Float64Array, gains: readonly [number, number, number, number]): Float64Array {
  const out = Float64Array.from(content);
  for (let i = 0; i < ALL_SYMBOLS.length; i++) {
    const at = LEAD + i * SPS;
    const g = gains[ALL_SYMBOLS[i]];
    for (let k = 0; k < SPS && at + k < out.length; k++) out[at + k] *= g;
  }
  return out;
}

/** Apply per-carrier gains to calibration tone regions. */
function applyToneChannel(tones: Float64Array, gains: readonly [number, number, number, number]): Float64Array {
  const out = Float64Array.from(tones);
  const tone = Math.round((SAMPLE_RATE * CALIBRATION_TONE_MS) / 1000);
  const silenceGap = Math.round((SAMPLE_RATE * CALIBRATION_SILENCE_MS) / 1000);
  const lead = Math.round((SAMPLE_RATE * CALIBRATION_LEAD_MS) / 1000);
  for (let k = 0; k < 4; k++) {
    const at = lead + k * (tone + silenceGap);
    for (let i = 0; i < tone && at + i < out.length; i++) out[at + i] *= gains[k];
  }
  return out;
}

function calibrateThroughChannel(gains: readonly [number, number, number, number], seed = 0xca11b): ChannelCalibration {
  const capture = addWhiteNoise(applyToneChannel(synthesizeCalibrationTones(SAMPLE_RATE), gains), 0.02, seed);
  return measureChannelCalibration(capture, SAMPLE_RATE);
}

test("calibration recovers simulated channel gains and passes a flat channel", () => {
  const cal = calibrateThroughChannel([1.0, 1.0, 1.0, 1.0]);
  assert.equal(cal.quality.status, "CALIBRATION PASS");
  assert.equal(cal.quality.blockSend, false);
  for (const c of cal.carriers) {
    assert.ok(Math.abs(c.gain - 1) < 0.15, `carrier ${c.nominalHz} gain ${c.gain}`);
    assert.ok(Math.abs(c.offsetHz) <= 5, `carrier ${c.nominalHz} offset ${c.offsetHz}`);
    assert.ok(c.snrDb > 15, `carrier ${c.nominalHz} SNR ${c.snrDb}`);
    assert.equal(c.dominantCarrier, c.carrier);
  }
});

test("calibration recovers imbalanced gains with correct ratios", () => {
  const truth: [number, number, number, number] = [1.1, 0.45, 1.9, 0.5];
  const cal = calibrateThroughChannel(truth);
  // Ratios against carrier 0 must match within 15%.
  for (let c = 1; c < 4; c++) {
    const expected = (truth[c] * truth[c]) / (truth[0] * truth[0]);
    const actual = cal.carriers[c].gain / cal.carriers[0].gain;
    assert.ok(Math.abs(actual - expected) / expected < 0.15, `carrier ${c}: ${actual} vs ${expected}`);
  }
});

test("TX compensation is clamped and peak-guarded", () => {
  const cal = calibrateThroughChannel([8, 0.05, 1, 1]);
  const raw = [1 / 8, 1 / 0.05, 1, 1];
  for (let c = 0; c < 4; c++) {
    const clamped = Math.min(CALIBRATION_MAX_COMPENSATION, Math.max(CALIBRATION_MIN_COMPENSATION, raw[c]));
    const wasClamped = clamped !== raw[c];
    assert.equal(cal.txClamped[c], wasClamped, `carrier ${c} clamp flag`);
  }
  for (const a of cal.txAmplitudes) {
    assert.ok(a > 0 && a <= CALIBRATION_MAX_TX_PEAK + 1e-9, `TX amplitude ${a}`);
  }
  // Weakest carrier gets the strongest (clamped) drive.
  assert.ok(cal.txAmplitudes[1] >= cal.txAmplitudes[0]);
  assert.ok(cal.txAmplitudes[1] >= cal.txAmplitudes[2]);
});

test("quality gate degrades on clipping and blocks on a missing carrier", () => {
  const loud = Float64Array.from(synthesizeCalibrationTones(SAMPLE_RATE), (v) => v * 1.5);
  const clipped = measureChannelCalibration(loud, SAMPLE_RATE);
  assert.equal(clipped.quality.status, "CALIBRATION DEGRADED");
  assert.ok(clipped.quality.checks.some((c) => c.name === "clipping" && !c.ok));
  assert.equal(clipped.quality.blockSend, true);

  const missing = applyToneChannel(synthesizeCalibrationTones(SAMPLE_RATE), [1, 0, 1, 1]);
  const gone = measureChannelCalibration(addWhiteNoise(missing, 0.02, 99), SAMPLE_RATE);
  assert.equal(gone.quality.status, "CALIBRATION DEGRADED");
  assert.equal(gone.quality.blockSend, true);
  assert.ok(gone.carriers[1].snrDb < 6);
});

test("frequency offset is measured per carrier", () => {
  const tones = synthesizeCalibrationTones(SAMPLE_RATE);
  // Shift only the 2000 Hz tone by -15 Hz.
  const tone = Math.round((SAMPLE_RATE * CALIBRATION_TONE_MS) / 1000);
  const silenceGap = Math.round((SAMPLE_RATE * CALIBRATION_SILENCE_MS) / 1000);
  const lead = Math.round((SAMPLE_RATE * CALIBRATION_LEAD_MS) / 1000);
  const at = lead + 3 * (tone + silenceGap);
  const shifted = Float64Array.from(tones);
  let phase = 0;
  const step = (2 * Math.PI * (FREQS[3] - 15)) / SAMPLE_RATE;
  const ramp = Math.min(Math.round(SAMPLE_RATE * 0.02), Math.floor(tone / 8));
  for (let i = 0; i < tone; i++) {
    const edge = Math.min(1, i / Math.max(1, ramp), (tone - 1 - i) / Math.max(1, ramp));
    shifted[at + i] = Math.sin(phase) * 0.72 * Math.max(0, edge);
    phase += step;
    if (phase > Math.PI * 2) phase -= Math.PI * 2;
  }
  const cal = measureChannelCalibration(addWhiteNoise(shifted, 0.02, 7), SAMPLE_RATE);
  assert.ok(Math.abs(cal.carriers[3].offsetHz - -15) <= 5, `offset ${cal.carriers[3].offsetHz}`);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(cal.carriers[c].offsetHz) <= 5);
  const eq = toEvidenceEqualization(cal);
  assert.ok(Math.abs(eq.frequenciesHz[3] - 1985) <= 5);
});

test("room hum plus weak carrier reproduces 0x43/0x40; RX equalization restores PASS", () => {
  // Observed room class: 1600 Hz dominant, 2000 Hz nulled, in-band hum near
  // 800 Hz outvotes the weak 2000 Hz symbols (VAC1 0x43 -> 0x40), length 8
  // still recovered, CRC fails. RX normalization must restore VERIFIED PASS
  // without touching CRC rules.
  const channel: [number, number, number, number] = [1.1, 0.6, 1.8, 0.22];
  const content = applyBurstChannel(
    encodeCalibratedEvidenceBurst(PAYLOAD, SAMPLE_RATE, [0.72, 0.72, 0.72, 0.72]),
    channel,
  );
  const file = concat([silence(0.5), addHum(addWhiteNoise(content, 0.02, 4242), 0.2, 800), silence(0.5)]);

  const plain = analyzeEvidenceWav(floatToWav(file));
  assert.equal(plain.verdict, "VERIFIED PARTIAL");
  assert.ok(plain.bursts.length > 0);
  for (const b of plain.bursts) assert.equal(b.passed, false);
  assert.ok(!plain.combined || !plain.combined.passed);
  // The exact observed confusion: VAC1 byte 0x43 recovered as 0x40.
  assert.ok(plain.bursts[0].rawHeaderHex.startsWith("564140"), `header ${plain.bursts[0].rawHeaderHex}`);
  assert.equal(plain.bursts[0].decodedLength, 8);

  const calTones = addHum(addWhiteNoise(applyToneChannel(synthesizeCalibrationTones(SAMPLE_RATE), channel), 0.02, 0xca11b), 0.2, 800);
  const cal = measureChannelCalibration(calTones, SAMPLE_RATE);
  const eq = toEvidenceEqualization(cal);
  const fixed = analyzeEvidenceWav(floatToWav(file), {
    frequenciesHz: eq.frequenciesHz,
    rxGains: eq.rxGains,
  }, "test-calibration");
  assert.equal(fixed.verdict, "VERIFIED PASS");
  assert.equal(fixed.equalization?.applied, true);
  // Encoder/analyzer preamble agreement (guards against profile drift).
  assert.equal(fixed.bursts[0].preambleMatches, 32);
  // Raw powers still show the physical imbalance; normalized shares recover.
  const raw = fixed.bursts[0].carriers.map((c) => c.relativePower);
  assert.ok(Math.max(...raw) > 0.4, `raw imbalance preserved: ${raw.map((v) => v.toFixed(2)).join(",")}`);
  for (const c of fixed.bursts[0].carriers) {
    assert.ok(c.normalizedRelativePower > 0.1 && c.normalizedRelativePower < 0.4,
      `carrier ${c.frequency} normalized share ${c.normalizedRelativePower}`);
  }
});

test("TX-compensated probe balances carriers and verifies as VERIFIED PASS", () => {
  // Mild imbalance without in-band interference: uniform TX already passes
  // but leaves carriers imbalanced; calibrated TX must balance them.
  const channel: [number, number, number, number] = [1.2, 0.5, 2.2, 0.6];
  const uniform = applyBurstChannel(
    encodeCalibratedEvidenceBurst(PAYLOAD, SAMPLE_RATE, [0.72, 0.72, 0.72, 0.72]),
    channel,
  );
  const plain = analyzeEvidenceWav(floatToWav(concat([silence(0.5), addWhiteNoise(uniform, 0.03, 4242), silence(0.5)])));
  assert.equal(plain.verdict, "VERIFIED PASS");
  const plainShares = plain.bursts[0].carriers.map((c) => c.relativePower);
  assert.ok(Math.max(...plainShares) > 0.4, `imbalanced without compensation: ${plainShares.map((v) => v.toFixed(2)).join(",")}`);

  const cal = calibrateThroughChannel(channel);
  // Weak carriers get the strongest drive (within clamp limits).
  assert.ok(cal.txAmplitudes[2] <= cal.txAmplitudes[0]);
  assert.ok(cal.txAmplitudes[1] >= cal.txAmplitudes[0]);
  const content = applyBurstChannel(
    encodeCalibratedEvidenceBurst(PAYLOAD, SAMPLE_RATE, cal.txAmplitudes),
    channel,
  );
  const file = concat([silence(0.5), addWhiteNoise(content, 0.03, 4242), silence(0.5)]);
  const report = analyzeEvidenceWav(floatToWav(file));
  assert.equal(report.verdict, "VERIFIED PASS");
  assert.equal(report.equalization, null);
  assert.equal(report.bursts[0].preambleMatches, 32);
  for (const c of report.bursts[0].carriers) {
    assert.ok(c.relativePower > 0.18 && c.relativePower < 0.32,
      `carrier ${c.frequency} balanced share ${c.relativePower}`);
  }
});

test("calibration JSON round-trips and rejects invalid files", () => {
  const cal = calibrateThroughChannel([1, 1, 1, 1]);
  const back = loadChannelCalibration(serializeChannelCalibration(cal));
  assert.deepEqual(back.txAmplitudes, cal.txAmplitudes);
  assert.deepEqual(back.rxGains, cal.rxGains);
  assert.equal(back.quality.status, "CALIBRATION PASS");
  assert.throws(() => loadChannelCalibration("not json"), /Invalid calibration JSON/);
  assert.throws(() => loadChannelCalibration(JSON.stringify({ version: "nope" })), /version/i);
  const tampered = JSON.parse(serializeChannelCalibration(cal));
  tampered.rxGains = [1, 0, 1, 1];
  assert.throws(() => loadChannelCalibration(JSON.stringify(tampered)), /RX gain/);
  const negative = JSON.parse(serializeChannelCalibration(cal));
  (negative.carriers[2] as { gain: number }).gain = -3;
  assert.throws(() => loadChannelCalibration(JSON.stringify(negative)), /gain/i);
});
