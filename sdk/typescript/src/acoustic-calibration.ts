/**
 * VAML physical acoustic channel calibration + carrier equalization.
 *
 * Real speaker -> air -> microphone paths do not have a flat frequency
 * response. One deployment showed ~51% of preamble energy on 1600 Hz but
 * only ~12% on 1200 Hz, with systematic 2000 Hz -> 800 Hz symbol confusion
 * (VAC1 byte 0x43 recovered as 0x40). This module measures that imbalance
 * with a fixed calibration sequence and derives bounded TX compensation and
 * RX normalization so neither side has to guess.
 *
 * What this module does NOT do:
 * - weaken CRC or change the VERIFIED PASS definition (see acoustic-evidence);
 * - invent "close enough" success modes;
 * - store or handle any secrets (calibration data is channel physics, and the
 *   JSON report must never contain keys).
 */

import { EVIDENCE_FREQUENCIES, EVIDENCE_MAGIC, EVIDENCE_PREAMBLE, EVIDENCE_SYMBOL_MS } from "./acoustic-evidence.js";

export const CALIBRATION_VERSION = "vaml-acoustic-calibration/1";
export const CALIBRATION_JSON_FILENAME = "vaml-acoustic-calibration.json";

/** Fixed calibration sequence: tone order is always 800/1200/1600/2000 Hz. */
export const CALIBRATION_ORDER = [0, 1, 2, 3] as const;
export const CALIBRATION_TONE_MS = 750;
export const CALIBRATION_SILENCE_MS = 350;
export const CALIBRATION_LEAD_MS = 500;
export const CALIBRATION_TAIL_MS = 500;
/** Reference send amplitude for calibration tones (same volume as probes). */
export const CALIBRATION_AMPLITUDE = 0.72;

/** Bounded TX compensation: never boost/cut beyond [+12 dB, -12 dB]. */
export const CALIBRATION_MIN_COMPENSATION = 0.25;
export const CALIBRATION_MAX_COMPENSATION = 4.0;
/** TX peak ceiling so equalization never drives the waveform into clipping. */
export const CALIBRATION_MAX_TX_PEAK = 0.9;

/** Quality-gate thresholds (documented, fixed). */
export const CALIBRATION_MIN_SNR_DB = 6;
export const CALIBRATION_MISSING_SNR_DB = 3;
export const CALIBRATION_MAX_IMBALANCE_DB = 12;
export const CALIBRATION_MAX_OFFSET_HZ = 40;
export const CALIBRATION_MAX_CLIPPING_RATIO = 0.01;
export const CALIBRATION_PEAK_SCAN_HZ = 80;
export const CALIBRATION_PEAK_STEP_HZ = 5;

export interface CalibrationToneMeasurement {
  carrier: number;
  nominalHz: number;
  peakHz: number;
  offsetHz: number;
  /** Narrow-band Goertzel power per sample of the tone window. */
  power: number;
  /** Narrow-band noise power per sample at the same frequency (silence gaps). */
  noiseFloor: number;
  snrDb: number;
  /** Dominant carrier actually observed in this tone window. */
  dominantCarrier: number;
  /** Channel gain relative to the median carrier (median == 1). */
  gain: number;
}

export interface CalibrationQualityCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CalibrationQuality {
  status: "CALIBRATION PASS" | "CALIBRATION DEGRADED";
  /** Severe anomaly: the operator should not send a calibrated probe. */
  blockSend: boolean;
  checks: CalibrationQualityCheck[];
}

export interface ChannelCalibration {
  version: typeof CALIBRATION_VERSION;
  sampleRate: number;
  toneMs: number;
  silenceMs: number;
  order: number[];
  baseAmplitude: number;
  carriers: CalibrationToneMeasurement[];
  referenceGain: number;
  /** Per-carrier TX amplitude (index == symbol), peak-guarded. */
  txAmplitudes: [number, number, number, number];
  txPeakScale: number;
  txClamped: boolean[];
  /** Per-carrier RX channel gain; decisions use measuredPower / rxGains. */
  rxGains: [number, number, number, number];
  quality: CalibrationQuality;
  sourceSha256?: string;
  createdAt: string;
}

// ------------------------------------------------------------ synthesis ---

/** Reference calibration signal (Computer A): equal-amplitude tones. */
export function synthesizeCalibrationTones(sampleRate: number, amplitude = CALIBRATION_AMPLITUDE): Float64Array {
  validateSampleRate(sampleRate);
  const tone = Math.round((sampleRate * CALIBRATION_TONE_MS) / 1000);
  const silence = Math.round((sampleRate * CALIBRATION_SILENCE_MS) / 1000);
  const lead = Math.round((sampleRate * CALIBRATION_LEAD_MS) / 1000);
  const tail = Math.round((sampleRate * CALIBRATION_TAIL_MS) / 1000);
  const total = lead + CALIBRATION_ORDER.length * tone + (CALIBRATION_ORDER.length - 1) * silence + tail;
  const out = new Float64Array(total);
  const ramp = Math.min(Math.round(sampleRate * 0.02), Math.floor(tone / 8));
  let cursor = lead;
  for (let k = 0; k < CALIBRATION_ORDER.length; k++) {
    const frequency = carrierFrequency(CALIBRATION_ORDER[k]);
    let phase = 0;
    const step = (2 * Math.PI * frequency) / sampleRate;
    for (let i = 0; i < tone; i++) {
      const edge = Math.min(1, i / Math.max(1, ramp), (tone - 1 - i) / Math.max(1, ramp));
      out[cursor++] = Math.sin(phase) * amplitude * Math.max(0, edge);
      phase += step;
      if (phase > Math.PI * 2) phase -= Math.PI * 2;
    }
    cursor += k < CALIBRATION_ORDER.length - 1 ? silence : 0;
  }
  return out;
}

/**
 * Evidence burst encoder with per-carrier TX amplitudes.
 * symbol s uses carrierAmplitudes[s]; uniform amplitudes reproduce the
 * default probe exactly. Modulation, packet, preamble, lead/tail and ramps
 * match the fixed evidence probe.
 */
export function encodeCalibratedEvidenceBurst(
  payload: Buffer,
  sampleRate: number,
  carrierAmplitudes: readonly [number, number, number, number],
): Float64Array {
  validateSampleRate(sampleRate);
  for (const a of carrierAmplitudes) {
    if (!Number.isFinite(a) || a <= 0 || a > 1) throw new Error("Invalid carrier amplitude");
  }
  const packet = buildPacket(payload);
  const symbols = [...EVIDENCE_PREAMBLE, ...bytesToSymbols(packet)];
  const sps = Math.round((sampleRate * EVIDENCE_SYMBOL_MS) / 1000);
  const lead = Math.round(sampleRate * 0.25);
  const tail = Math.round(sampleRate * 0.25);
  const ramp = Math.max(1, Math.min(Math.floor(sps / 10), 64));
  const out = new Float64Array(lead + symbols.length * sps + tail);
  let cursor = lead;
  let phase = 0;
  for (const sym of symbols) {
    const amplitude = carrierAmplitudes[sym];
    const step = (2 * Math.PI * carrierFrequency(sym)) / sampleRate;
    for (let i = 0; i < sps; i++) {
      const edge = Math.min(1, i / ramp, (sps - 1 - i) / ramp);
      out[cursor++] = Math.sin(phase) * amplitude * Math.max(0, edge);
      phase += step;
      if (phase > Math.PI * 2) phase -= Math.PI * 2;
    }
  }
  return out;
}

// ---------------------------------------------------------- measurement ---

export interface MeasureCalibrationOptions {
  baseAmplitude?: number;
  sourceSha256?: string;
}

/**
 * Measure the physical channel from a calibration recording.
 * Narrow-band Goertzel measurement only; broadband RMS is used solely to
 * locate the sequence onset, never to judge carriers.
 */
export function measureChannelCalibration(
  samples: Float64Array,
  sampleRate: number,
  options: MeasureCalibrationOptions = {},
): ChannelCalibration {
  validateSampleRate(sampleRate);
  if (!(samples instanceof Float64Array) || samples.length < sampleRate * 2) {
    throw new Error("Calibration recording too short");
  }
  const tone = Math.round((sampleRate * CALIBRATION_TONE_MS) / 1000);
  const silence = Math.round((sampleRate * CALIBRATION_SILENCE_MS) / 1000);
  const sequenceLength = CALIBRATION_ORDER.length * tone + (CALIBRATION_ORDER.length - 1) * silence;
  // Onset is the estimated start of the first tone; tone k then starts at
  // onset + k * (tone + silence) by the fixed known layout.
  const onset = findSequenceOnset(samples, sampleRate);
  if (onset < 0) throw new Error("Calibration tones not found");
  const base = onset;
  if (base + sequenceLength > samples.length) throw new Error("Calibration recording truncated");

  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
  }
  const clippingRatio = clipped / samples.length;

  const carriers: CalibrationToneMeasurement[] = [];
  for (let k = 0; k < CALIBRATION_ORDER.length; k++) {
    const carrier = CALIBRATION_ORDER[k];
    const nominal = carrierFrequency(carrier);
    const toneStart = base + k * (tone + silence);
    // Middle 60% of the tone avoids edge ramps; middle 50% of the
    // neighboring silences estimates the narrow-band noise floor.
    const mStart = toneStart + Math.round(tone * 0.2);
    const mCount = Math.round(tone * 0.6);
    const centerPowers = [0, 1, 2, 3].map((c) => goertzelPower(samples, mStart, mCount, carrierFrequency(c), sampleRate));
    let dominant = 0;
    for (let c = 1; c < 4; c++) if (centerPowers[c] > centerPowers[dominant]) dominant = c;
    // Noise floor and peak are both narrow-band; the tone power is measured
    // at the detected peak (see below).
    const peakHz = findSpectralPeak(samples, mStart, mCount, nominal, sampleRate);
    // Channel gain is arriving energy regardless of exact frequency, so the
    // tone power is measured at the detected peak, not the nominal center.
    const power = goertzelPower(samples, mStart, mCount, peakHz, sampleRate) / mCount;
    const peakNoise = silenceNoiseFloor(samples, sampleRate, toneStart, tone, silence, peakHz);
    const snrDb = 10 * Math.log10(Math.max(1e-12, power) / Math.max(1e-12, peakNoise));
    carriers.push({
      carrier,
      nominalHz: nominal,
      peakHz,
      offsetHz: peakHz - nominal,
      power,
      noiseFloor: peakNoise,
      snrDb,
      dominantCarrier: dominant,
      gain: 0, // filled after median is known
    });
  }

  const sorted = [...carriers].map((c) => c.power).sort((a, b) => a - b);
  const median = (sorted[1] + sorted[2]) / 2;
  const referenceGain = median > 0 ? median : 1e-12;
  for (const c of carriers) c.gain = c.power / referenceGain;

  const baseAmplitude = options.baseAmplitude ?? CALIBRATION_AMPLITUDE;
  // Amplitude-domain compensation: power gain g_p corresponds to amplitude
  // gain sqrt(g_p), so the TX drive is 1/sqrt(g_p). Using 1/g_p would square
  // the correction and unbalance the channel in the opposite direction.
  const txClamped: boolean[] = [];
  const rawTx = carriers.map((c) => {
    const raw = 1 / Math.sqrt(Math.max(1e-9, c.gain));
    const clamped = Math.min(CALIBRATION_MAX_COMPENSATION, Math.max(CALIBRATION_MIN_COMPENSATION, raw));
    txClamped.push(clamped !== raw);
    return baseAmplitude * clamped;
  });
  const txPeakScale = Math.min(1, CALIBRATION_MAX_TX_PEAK / Math.max(...rawTx, 1e-9));
  const txAmplitudes = rawTx.map((a) => a * txPeakScale) as [number, number, number, number];

  const quality = gateCalibration(carriers, clippingRatio);
  return {
    version: CALIBRATION_VERSION,
    sampleRate,
    toneMs: CALIBRATION_TONE_MS,
    silenceMs: CALIBRATION_SILENCE_MS,
    order: [...CALIBRATION_ORDER],
    baseAmplitude,
    carriers,
    referenceGain,
    txAmplitudes,
    txPeakScale,
    txClamped,
    rxGains: carriers.map((c) => c.gain) as [number, number, number, number],
    quality,
    ...(options.sourceSha256 ? { sourceSha256: options.sourceSha256 } : {}),
    createdAt: new Date().toISOString(),
  };
}

function gateCalibration(carriers: CalibrationToneMeasurement[], clippingRatio: number): CalibrationQuality {
  const checks: CalibrationQualityCheck[] = [];
  for (const c of carriers) {
    checks.push({
      name: `carrier-${c.nominalHz}-snr`,
      ok: c.snrDb >= CALIBRATION_MIN_SNR_DB,
      detail: `${c.nominalHz} Hz SNR ${c.snrDb.toFixed(1)} dB (need >= ${CALIBRATION_MIN_SNR_DB} dB)`,
    });
    checks.push({
      name: `carrier-${c.nominalHz}-order`,
      ok: c.dominantCarrier === c.carrier,
      detail: `${c.nominalHz} Hz window dominated by ${carrierFrequency(c.dominantCarrier)} Hz`,
    });
    checks.push({
      name: `carrier-${c.nominalHz}-offset`,
      ok: Math.abs(c.offsetHz) <= CALIBRATION_MAX_OFFSET_HZ,
      detail: `${c.nominalHz} Hz offset ${c.offsetHz >= 0 ? "+" : ""}${c.offsetHz.toFixed(0)} Hz (limit ${CALIBRATION_MAX_OFFSET_HZ} Hz)`,
    });
  }
  const gainsDb = carriers.map((c) => 10 * Math.log10(Math.max(1e-9, c.gain)));
  const imbalance = Math.max(...gainsDb) - Math.min(...gainsDb);
  checks.push({
    name: "gain-imbalance",
    ok: imbalance <= CALIBRATION_MAX_IMBALANCE_DB,
    detail: `max-min carrier gain spread ${imbalance.toFixed(1)} dB (limit ${CALIBRATION_MAX_IMBALANCE_DB} dB)`,
  });
  checks.push({
    name: "clipping",
    ok: clippingRatio <= CALIBRATION_MAX_CLIPPING_RATIO,
    detail: `clipping ${(clippingRatio * 100).toFixed(3)}% (limit ${(CALIBRATION_MAX_CLIPPING_RATIO * 100).toFixed(1)}%)`,
  });
  const missingCarriers = carriers.filter((c) => c.snrDb < CALIBRATION_MISSING_SNR_DB || c.gain < 0.01);
  if (missingCarriers.length) {
    checks.push({
      name: "carrier-present",
      ok: false,
      detail: `carrier(s) missing: ${missingCarriers.map((c) => `${c.nominalHz} Hz (SNR ${c.snrDb.toFixed(1)} dB, gain ${c.gain.toFixed(4)})`).join(", ")}`,
    });
  }
  const blockSend = missingCarriers.length > 0 || clippingRatio > CALIBRATION_MAX_CLIPPING_RATIO;
  const allOk = checks.every((c) => c.ok);
  return { status: allOk ? "CALIBRATION PASS" : "CALIBRATION DEGRADED", blockSend, checks };
}

// ---------------------------------------------------------- JSON codec ----

export function serializeChannelCalibration(calibration: ChannelCalibration): string {
  return JSON.stringify(calibration, null, 2);
}

/** Parse + validate a calibration file. Never accepts secrets; throws when invalid. */
export function loadChannelCalibration(json: string): ChannelCalibration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid calibration JSON");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid calibration file");
  const cal = parsed as Record<string, unknown>;
  if (cal["version"] !== CALIBRATION_VERSION) throw new Error(`Unsupported calibration version`);
  if (!Number.isInteger(cal["sampleRate"] as number) || (cal["sampleRate"] as number) < 8000 || (cal["sampleRate"] as number) > 192000) {
    throw new Error("Invalid calibration sample rate");
  }
  if (!Array.isArray(cal["carriers"]) || cal["carriers"].length !== 4) throw new Error("Calibration needs four carriers");
  const carriers = (cal["carriers"] as unknown[]).map((entry, index) => {
    if (typeof entry !== "object" || entry === null) throw new Error(`Invalid carrier ${index}`);
    const e = entry as Record<string, unknown>;
    for (const key of ["nominalHz", "peakHz", "offsetHz", "power", "noiseFloor", "snrDb", "gain"]) {
      if (!Number.isFinite(e[key] as number)) throw new Error(`Invalid carrier ${index} field ${key}`);
    }
    const gain = e["gain"] as number;
    if (!(gain > 0)) throw new Error(`Invalid carrier ${index} gain`);
    if (!Number.isInteger(e["dominantCarrier"] as number)) throw new Error(`Invalid carrier ${index} dominant`);
    if ((e["nominalHz"] as number) !== carrierFrequency(index)) throw new Error(`Unexpected carrier ${index} frequency`);
    return {
      carrier: index,
      nominalHz: e["nominalHz"] as number,
      peakHz: e["peakHz"] as number,
      offsetHz: e["offsetHz"] as number,
      power: e["power"] as number,
      noiseFloor: e["noiseFloor"] as number,
      snrDb: e["snrDb"] as number,
      dominantCarrier: e["dominantCarrier"] as number,
      gain,
    } satisfies CalibrationToneMeasurement;
  });
  if (!Array.isArray(cal["txAmplitudes"]) || (cal["txAmplitudes"] as unknown[]).length !== 4) {
    throw new Error("Invalid TX amplitudes");
  }
  const txAmplitudes = (cal["txAmplitudes"] as unknown[]).map((a) => {
    if (!Number.isFinite(a as number) || (a as number) <= 0 || (a as number) > 1) throw new Error("Invalid TX amplitude");
    return a as number;
  }) as [number, number, number, number];
  if (!Array.isArray(cal["rxGains"]) || (cal["rxGains"] as unknown[]).length !== 4) throw new Error("Invalid RX gains");
  const rxGains = (cal["rxGains"] as unknown[]).map((g) => {
    if (!Number.isFinite(g as number) || !((g as number) > 0)) throw new Error("Invalid RX gain");
    return g as number;
  }) as [number, number, number, number];
  const quality = cal["quality"] as CalibrationQuality | undefined;
  if (!quality || (quality.status !== "CALIBRATION PASS" && quality.status !== "CALIBRATION DEGRADED")) {
    throw new Error("Invalid calibration quality gate");
  }
  return {
    version: CALIBRATION_VERSION,
    sampleRate: cal["sampleRate"] as number,
    toneMs: CALIBRATION_TONE_MS,
    silenceMs: CALIBRATION_SILENCE_MS,
    order: [0, 1, 2, 3],
    baseAmplitude: Number.isFinite(cal["baseAmplitude"] as number) ? (cal["baseAmplitude"] as number) : CALIBRATION_AMPLITUDE,
    carriers,
    referenceGain: Number.isFinite(cal["referenceGain"] as number) ? (cal["referenceGain"] as number) : 1,
    txAmplitudes,
    txPeakScale: Number.isFinite(cal["txPeakScale"] as number) ? (cal["txPeakScale"] as number) : 1,
    txClamped: Array.isArray(cal["txClamped"]) ? (cal["txClamped"] as boolean[]).map(Boolean).slice(0, 4) : [false, false, false, false],
    rxGains,
    quality: { status: quality.status, blockSend: quality.blockSend === true, checks: Array.isArray(quality.checks) ? quality.checks : [] },
    ...(typeof cal["sourceSha256"] === "string" ? { sourceSha256: cal["sourceSha256"] } : {}),
    ...(typeof cal["createdAt"] === "string" ? { createdAt: cal["createdAt"] } : { createdAt: new Date(0).toISOString() }),
  };
}

/** Analyzer view: calibration-derived centers + RX gains (bounded search stays). */
export function toEvidenceEqualization(calibration: ChannelCalibration): {
  frequenciesHz: [number, number, number, number];
  rxGains: [number, number, number, number];
} {
  return {
    frequenciesHz: calibration.carriers.map((c) =>
      clamp(c.nominalHz + c.offsetHz, c.nominalHz - 100, c.nominalHz + 100),
    ) as [number, number, number, number],
    rxGains: [...calibration.rxGains] as [number, number, number, number],
  };
}

// ------------------------------------------------------------------ DSP ---

function carrierFrequency(carrier: number): number {
  return EVIDENCE_FREQUENCIES[carrier] ?? 0;
}

function buildPacket(payload: Buffer): Buffer {
  const packet = Buffer.alloc(4 + 4 + payload.length + 4);
  Buffer.from(EVIDENCE_MAGIC).copy(packet, 0);
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

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function goertzelPower(samples: Float64Array, start: number, count: number, frequency: number, sampleRate: number): number {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const coefficient = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < count; i++) {
    const x = samples[Math.round(start) + i] ?? 0;
    s0 = x + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coefficient * s1 * s2;
}

function findSpectralPeak(samples: Float64Array, start: number, count: number, nominal: number, sampleRate: number): number {
  let bestHz = nominal;
  let bestPower = -Infinity;
  for (let df = -CALIBRATION_PEAK_SCAN_HZ; df <= CALIBRATION_PEAK_SCAN_HZ; df += CALIBRATION_PEAK_STEP_HZ) {
    const p = goertzelPower(samples, start, count, nominal + df, sampleRate);
    if (p > bestPower) { bestPower = p; bestHz = nominal + df; }
  }
  return bestHz;
}

function silenceNoiseFloor(
  samples: Float64Array,
  sampleRate: number,
  toneStart: number,
  tone: number,
  silence: number,
  frequency: number,
): number {
  const gaps: Array<[number, number]> = [];
  const before = toneStart - silence;
  if (before >= 0) {
    const s = before + Math.round(silence * 0.25);
    gaps.push([s, Math.round(silence * 0.5)]);
  }
  const after = toneStart + tone;
  if (after + silence <= samples.length) {
    const s = after + Math.round(silence * 0.25);
    gaps.push([s, Math.round(silence * 0.5)]);
  }
  if (!gaps.length) return 1e-12;
  let total = 0;
  for (const [s, count] of gaps) total += goertzelPower(samples, s, count, frequency, sampleRate) / Math.max(1, count);
  return Math.max(1e-12, total / gaps.length);
}

/**
 * Locate the calibration sequence with a matched 4-tone pattern search.
 * Scores every candidate base by the narrow-band energy of each expected
 * tone at its known offset; the true alignment wins even under continuous
 * narrowband room hum, where an absolute broadband threshold would either
 * miss a phase-cancelled first tone or lock onto the hum itself.
 * Returns the estimated start of the first tone, or -1 when no sequence
 * stands out from the background.
 */
function findSequenceOnset(samples: Float64Array, sampleRate: number): number {
  const tone = Math.round((sampleRate * CALIBRATION_TONE_MS) / 1000);
  const silence = Math.round((sampleRate * CALIBRATION_SILENCE_MS) / 1000);
  const period = tone + silence;
  const sequence = CALIBRATION_ORDER.length * tone + (CALIBRATION_ORDER.length - 1) * silence;
  if (samples.length < sequence + tone) return -1;
  const step = Math.max(64, Math.round(sampleRate * 0.05));
  const window = Math.round(tone * 0.6);
  const scores: Array<{ base: number; score: number }> = [];
  for (let base = 0; base + sequence <= samples.length; base += step) {
    let score = 0;
    for (let k = 0; k < CALIBRATION_ORDER.length; k++) {
      const at = base + k * period + Math.round(tone * 0.2);
      score += goertzelPower(samples, at, window, carrierFrequency(CALIBRATION_ORDER[k]), sampleRate);
    }
    scores.push({ base, score });
  }
  if (!scores.length) return -1;
  let max = -Infinity;
  for (const s of scores) if (s.score > max) max = s.score;
  if (!(max > 0)) return -1;
  // The peak is typically a plateau (wide windows, small steps); the middle
  // of the plateau is the most centered alignment. Tones that are truly
  // absent (digital silence) score exactly zero and are rejected above;
  // near-silent recordings still produce a base, but the per-carrier SNR
  // quality gate then reports missing carriers and blocks sending.
  const plateau = scores.filter((s) => s.score >= max * 0.999).map((s) => s.base).sort((a, b) => a - b);
  return plateau[Math.floor(plateau.length / 2)];
}

function validateSampleRate(sampleRate: number): void {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new Error("Invalid sample rate");
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
