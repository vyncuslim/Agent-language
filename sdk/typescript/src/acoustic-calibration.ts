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
 *
 * Two calibration generations exist:
 * - v1 (750 ms long tones) is a LEGACY DIAGNOSTIC. Its code and tests are
 *   retained, but it must not feed the formal evidence path: steady-state
 *   tone gains do not transfer to 26 ms symbols (ramps, guard/window, ISI,
 *   AGC attack), and re-applying long-tone rxGains after TX compensation is
 *   double correction.
 * - v2 (26 ms symbol-domain closed loop) is the formal path: Round 1 sends
 *   [0,1,2,3] x 40 through the SAME encodeAcousticSymbols generator as the
 *   evidence probe, measures per-symbol gains g_s plus the confusion matrix,
 *   derives TX amplitudes, and Round 2 re-sends the same sequence TX
 *   compensated and MEASURES the effective RX gains e_s. The receiver uses
 *   only measured e_s, never g_s x t_s squared.
 */

import { createHash } from "node:crypto";
import {
  decodeKnownSymbols,
  EVIDENCE_FREQUENCIES,
  EVIDENCE_MAGIC,
  EVIDENCE_PREAMBLE,
  EVIDENCE_SYMBOL_MS,
  type KnownSymbolDecision,
} from "./acoustic-evidence.js";

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
 * Shared底层 4-FSK symbol waveform generator.
 *
 * R2 hard requirement: the evidence probe and both symbol-calibration rounds
 * MUST use this single implementation (26 ms symbols, same ramp, same
 * profile, same pipeline). There is no second encoder that merely claims
 * "same parameters".
 */
export interface EncodeAcousticSymbolsOptions {
  leadingSilenceMs?: number;
  trailingSilenceMs?: number;
}

export function encodeAcousticSymbols(
  symbols: readonly number[],
  sampleRate: number,
  carrierAmplitudes: readonly [number, number, number, number],
  options: EncodeAcousticSymbolsOptions = {},
): Float64Array {
  validateSampleRate(sampleRate);
  if (carrierAmplitudes.length !== 4) throw new Error("Invalid carrier amplitudes");
  for (const a of carrierAmplitudes) {
    if (!Number.isFinite(a) || a <= 0 || a > 1) throw new Error("Invalid carrier amplitude");
  }
  for (const s of symbols) {
    if (!Number.isInteger(s) || s < 0 || s > 3) throw new Error("Invalid acoustic symbol");
  }
  const sps = Math.round((sampleRate * EVIDENCE_SYMBOL_MS) / 1000);
  const lead = Math.round((sampleRate * (options.leadingSilenceMs ?? 250)) / 1000);
  const tail = Math.round((sampleRate * (options.trailingSilenceMs ?? 250)) / 1000);
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

/**
 * Evidence burst encoder with per-carrier TX amplitudes.
 * symbol s uses carrierAmplitudes[s]; uniform amplitudes reproduce the
 * default probe exactly. Modulation, packet, preamble, lead/tail and ramps
 * match the fixed evidence probe. Shares encodeAcousticSymbols with the
 * symbol-calibration rounds (R2).
 */
export function encodeCalibratedEvidenceBurst(
  payload: Buffer,
  sampleRate: number,
  carrierAmplitudes: readonly [number, number, number, number],
): Float64Array {
  const packet = buildPacket(payload);
  const symbols = [...EVIDENCE_PREAMBLE, ...bytesToSymbols(packet)];
  return encodeAcousticSymbols(symbols, sampleRate, carrierAmplitudes);
}

/** Symbol-domain closed-loop calibration pattern: 0,1,2,3 repeated. */
export const SYMBOL_CAL_PATTERN = [0, 1, 2, 3] as const;
export const SYMBOL_CAL_ROUNDS = 40;
export const SYMBOL_CAL_SYMBOLS = SYMBOL_CAL_PATTERN.length * SYMBOL_CAL_ROUNDS; // 160

export interface SymbolCalibrationSequence {
  symbols: number[];
  samples: Float64Array;
  contentStart: number;
}

/**
 * Round 1/2 symbol-calibration signal: [0,1,2,3] x 40 through the SAME
 * encodeAcousticSymbols generator as the evidence probe. Round 1 uses
 * uniform amplitudes; Round 2 uses the Round-1 txAmplitudes.
 */
export function encodeSymbolCalibration(
  sampleRate: number,
  carrierAmplitudes: readonly [number, number, number, number],
  rounds = SYMBOL_CAL_ROUNDS,
): SymbolCalibrationSequence {
  if (!Number.isInteger(rounds) || rounds < 4 || rounds > 400) throw new Error("Invalid calibration rounds");
  const symbols: number[] = [];
  for (let r = 0; r < rounds; r++) for (const s of SYMBOL_CAL_PATTERN) symbols.push(s);
  const samples = encodeAcousticSymbols(symbols, sampleRate, carrierAmplitudes);
  return { symbols, samples, contentStart: Math.round((sampleRate * 250) / 1000) };
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
  const derived = deriveTxAmplitudes(
    carriers.map((c) => c.gain) as [number, number, number, number],
    baseAmplitude,
  );

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
    txAmplitudes: derived.txAmplitudes,
    txPeakScale: derived.txPeakScale,
    txClamped: derived.txClamped,
    rxGains: carriers.map((c) => c.gain) as [number, number, number, number],
    quality,
    ...(options.sourceSha256 ? { sourceSha256: options.sourceSha256 } : {}),
    createdAt: new Date().toISOString(),
  };
}

export interface DerivedTxAmplitudes {
  txAmplitudes: [number, number, number, number];
  txPeakScale: number;
  txClamped: boolean[];
}

/**
 * Shared TX compensation derivation (v1 long-tone and v2 symbol-domain).
 * Amplitude-domain: power gain g_p means amplitude gain sqrt(g_p), so the
 * TX drive is 1/sqrt(g_p), clamped to [MIN, MAX] compensation with a peak
 * ceiling so equalization never clips. Using 1/g_p would square the
 * correction and unbalance the channel in the opposite direction.
 */
export function deriveTxAmplitudes(
  powerGains: readonly [number, number, number, number],
  baseAmplitude = CALIBRATION_AMPLITUDE,
): DerivedTxAmplitudes {
  if (!Number.isFinite(baseAmplitude) || baseAmplitude <= 0 || baseAmplitude > 1) {
    throw new Error("Invalid base amplitude");
  }
  const txClamped: boolean[] = [];
  const rawTx = powerGains.map((gain) => {
    if (!Number.isFinite(gain) || !(gain > 0)) throw new Error("Invalid power gain");
    const raw = 1 / Math.sqrt(Math.max(1e-9, gain));
    const clamped = Math.min(CALIBRATION_MAX_COMPENSATION, Math.max(CALIBRATION_MIN_COMPENSATION, raw));
    txClamped.push(clamped !== raw);
    return baseAmplitude * clamped;
  });
  const txPeakScale = Math.min(1, CALIBRATION_MAX_TX_PEAK / Math.max(...rawTx, 1e-9));
  return {
    txAmplitudes: rawTx.map((a) => a * txPeakScale) as [number, number, number, number],
    txPeakScale,
    txClamped,
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

/** LEGACY v1 analyzer view (diagnostic only, not the formal path). */
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

// ------------------------------------------- v2 symbol-domain closed loop ---

export const CALIBRATION_V2_VERSION = "vaml-acoustic-calibration/2";
export const CALIBRATION_V2_JSON_FILENAME = "vaml-acoustic-calibration-v2.json";
/** Round-1 gate: any diagonal below this degrades the calibration. */
export const SYMBOL_CAL_MIN_DIAGONAL = 0.9;
/** Round-1 gate: per-symbol SNR below this blocks sending. */
export const SYMBOL_CAL_MISSING_SNR_DB = 3;
/** Round-1 gate: relative symbol gain below this blocks sending. */
export const SYMBOL_CAL_MISSING_GAIN = 0.01;

export interface SymbolRoundMeasurement {
  /** Full per-symbol records: expected is attached post-decision (R3). */
  decisions: KnownSymbolDecision[];
  /** Raw counts: counts[s][r] = times sent s decoded as r. */
  confusionCounts: number[][];
  /** Probabilities C[s][r] = P(winner = r | sent = s). */
  confusion: number[][];
  /** Diagonal C[s][s] per sent symbol. */
  diagonal: [number, number, number, number];
  /** Median-normalized mean narrow-band power at the SENT carrier. */
  symbolGains: [number, number, number, number];
  /** Per-sent-symbol SNR vs lead/tail silence (dB). */
  symbolSnrDb: [number, number, number, number];
  startSample: number;
  samplesPerSymbol: number;
}

export interface ChannelCalibrationV2 {
  version: typeof CALIBRATION_V2_VERSION;
  sampleRate: number;
  symbolMs: number;
  rounds: number;
  pattern: number[];
  round1Sha256: string;
  round2Sha256: string;
  round1: SymbolRoundMeasurement;
  /** g_s: Round-1 median-normalized symbol gains. */
  rawSymbolGains: [number, number, number, number];
  txAmplitudes: [number, number, number, number];
  txPeakScale: number;
  txClamped: boolean[];
  round2: SymbolRoundMeasurement;
  /** e_s: Round-2 MEASURED median-normalized effective RX gains. */
  effectiveRxGains: [number, number, number, number];
  /** Theory (decision-forbidden) vs measurement. */
  diagnosticComparison: {
    predictedEffectiveGains: [number, number, number, number];
    measuredEffectiveGains: [number, number, number, number];
  };
  quality: CalibrationQuality;
  createdAt: string;
}

/**
 * Locate a symbol-calibration round by matched [0,1,2,3] pattern energy.
 * The known pattern is used ONLY as a correlation template for SYNC (the
 * same role the preamble plays in evidence decoding). Winners still come
 * exclusively from the receiver argmax in decodeKnownSymbols (R3).
 */
export function findSymbolCalOnset(
  samples: Float64Array,
  sampleRate: number,
  symbols: readonly number[],
): number {
  validateSampleRate(sampleRate);
  if (!(samples instanceof Float64Array)) throw new Error("Invalid calibration samples");
  const sps = (sampleRate * EVIDENCE_SYMBOL_MS) / 1000;
  const head = Math.min(16, symbols.length);
  if (symbols.length < 32 || samples.length < symbols.length * sps) {
    throw new Error("Calibration recording too short");
  }
  const guard = Math.max(2, Math.round(sps * 0.22));
  const window = Math.max(64, Math.round(sps) - guard * 2);
  const scoreAt = (base: number): number => {
    let score = 0;
    for (let i = 0; i < head; i++) {
      const a = Math.round(base + i * sps) + guard;
      if (a < 0 || a + window > samples.length) return -Infinity;
      score += goertzelPower(samples, a, window, carrierFrequency(symbols[i]), sampleRate);
    }
    return score;
  };
  let best = -1;
  let bestScore = -Infinity;
  const coarseStep = Math.max(32, Math.round(sps / 4));
  const maxBase = samples.length - Math.ceil(symbols.length * sps);
  for (let base = 0; base <= Math.max(0, maxBase); base += coarseStep) {
    const score = scoreAt(base);
    if (score > bestScore) { bestScore = score; best = base; }
  }
  if (best < 0 || !(bestScore > 0)) return -1;
  const fineRadius = coarseStep;
  for (let d = -fineRadius; d <= fineRadius; d += 8) {
    const score = scoreAt(best + d);
    if (score > bestScore) { bestScore = score; best = best + d; }
  }
  return best;
}

/**
 * Measure one symbol-calibration round (Round 1 or Round 2).
 * Every symbol decodes through the receiver's own bounded-search argmax;
 * expected symbols are attached afterwards for statistics only (R3).
 */
export function measureSymbolRound(
  samples: Float64Array,
  sampleRate: number,
  symbols: readonly number[],
): SymbolRoundMeasurement {
  validateSampleRate(sampleRate);
  const sps = (sampleRate * EVIDENCE_SYMBOL_MS) / 1000;
  const startSample = findSymbolCalOnset(samples, sampleRate, symbols);
  if (startSample < 0) throw new Error("Symbol calibration sequence not found");
  if (startSample + symbols.length * sps > samples.length + sps) {
    throw new Error("Symbol calibration recording truncated");
  }
  const decisions = decodeKnownSymbols(samples, sampleRate, startSample, sps, symbols);
  const counts: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (const d of decisions) counts[d.expected][d.winner]++;
  const confusion: number[][] = counts.map((row) => {
    const total = row.reduce((a, b) => a + b, 0);
    return row.map((c) => (total > 0 ? c / total : 0));
  });
  const diagonal = [0, 1, 2, 3].map((s) => confusion[s][s]) as [number, number, number, number];

  // Per-sent-symbol narrow-band power at the SENT carrier (raw measurement,
  // independent of who won the decision).
  const guard = Math.max(2, Math.round(sps * 0.22));
  const window = Math.max(64, Math.round(sps) - guard * 2);
  const totals = [0, 0, 0, 0];
  const repertoires = [0, 0, 0, 0];
  for (const d of decisions) {
    const a = d.start + guard;
    if (a < 0 || a + window > samples.length) continue;
    totals[d.expected] += goertzelPower(samples, a, window, carrierFrequency(d.expected), sampleRate);
    repertoires[d.expected]++;
  }
  const perSample = totals.map((t, s) => (repertoires[s] > 0 ? t / repertoires[s] / window : 0));
  const sorted = [...perSample].sort((a, b) => a - b);
  const median = (sorted[1] + sorted[2]) / 2;
  const reference = median > 0 ? median : 1e-12;
  const symbolGains = perSample.map((p) => p / reference) as [number, number, number, number];

  // Narrow-band noise floor from lead/tail silence (first/last 0.2 s).
  const silenceN = Math.min(Math.round(sampleRate * 0.2), Math.floor(samples.length / 4));
  const noiseAt = (carrier: number): number => {
    const f = carrierFrequency(carrier);
    let total = 0;
    let n = 0;
    const blocks: Array<[number, number]> = [[0, silenceN], [samples.length - silenceN, silenceN]];
    for (const [at, count] of blocks) {
      if (at < 0 || at + count > samples.length || count < 64) continue;
      total += goertzelPower(samples, at, count, f, sampleRate) / count;
      n++;
    }
    return n > 0 ? Math.max(1e-12, total / n) : 1e-12;
  };
  const symbolSnrDb = [0, 1, 2, 3].map((s) =>
    10 * Math.log10(Math.max(1e-12, perSample[s]) / noiseAt(s)),
  ) as [number, number, number, number];

  return {
    decisions,
    confusionCounts: counts,
    confusion,
    diagonal,
    symbolGains,
    symbolSnrDb,
    startSample: Math.round(startSample),
    samplesPerSymbol: sps,
  };
}

function gateSymbolRound(measurement: SymbolRoundMeasurement, clippingRatio: number, label: string): CalibrationQuality {
  const checks: CalibrationQualityCheck[] = [];
  for (let s = 0; s < 4; s++) {
    checks.push({
      name: `${label}-symbol-${s}-diagonal`,
      ok: measurement.diagonal[s] >= SYMBOL_CAL_MIN_DIAGONAL,
      detail: `${label}: P(winner=${s}|sent=${s}) = ${measurement.diagonal[s].toFixed(3)} (need >= ${SYMBOL_CAL_MIN_DIAGONAL})`,
    });
    checks.push({
      name: `${label}-symbol-${s}-snr`,
      ok: measurement.symbolSnrDb[s] >= SYMBOL_CAL_MISSING_SNR_DB,
      detail: `${label}: symbol ${s} SNR ${measurement.symbolSnrDb[s].toFixed(1)} dB (need >= ${SYMBOL_CAL_MISSING_SNR_DB} dB)`,
    });
  }
  const gainsDb = measurement.symbolGains.map((g) => 10 * Math.log10(Math.max(1e-9, g)));
  const imbalance = Math.max(...gainsDb) - Math.min(...gainsDb);
  checks.push({
    name: `${label}-gain-imbalance`,
    ok: imbalance <= CALIBRATION_MAX_IMBALANCE_DB,
    detail: `${label}: symbol gain spread ${imbalance.toFixed(1)} dB (limit ${CALIBRATION_MAX_IMBALANCE_DB} dB)`,
  });
  checks.push({
    name: `${label}-clipping`,
    ok: clippingRatio <= CALIBRATION_MAX_CLIPPING_RATIO,
    detail: `${label}: clipping ${(clippingRatio * 100).toFixed(3)}% (limit ${(CALIBRATION_MAX_CLIPPING_RATIO * 100).toFixed(1)}%)`,
  });
  const missing = [0, 1, 2, 3].filter(
    (s) => measurement.symbolSnrDb[s] < SYMBOL_CAL_MISSING_SNR_DB || measurement.symbolGains[s] < SYMBOL_CAL_MISSING_GAIN,
  );
  if (missing.length) {
    checks.push({
      name: `${label}-symbol-present`,
      ok: false,
      detail: `${label}: symbol(s) missing: ${missing.join(", ")}`,
    });
  }
  const blockSend = missing.length > 0 || clippingRatio > CALIBRATION_MAX_CLIPPING_RATIO;
  return { status: checks.every((c) => c.ok) ? "CALIBRATION PASS" : "CALIBRATION DEGRADED", blockSend, checks };
}

function clippingRatioOf(samples: Float64Array): number {
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) >= 0.999) clipped++;
  return samples.length ? clipped / samples.length : 0;
}

export interface BuildCalibrationV2Input {
  sampleRate: number;
  rounds?: number;
  round1Samples: Float64Array;
  round1Sha256: string;
  /** TX amplitudes actually used for the Round-2 send (must equal derived). */
  round2TxAmplitudes: readonly [number, number, number, number];
  round2Samples: Float64Array;
  round2Sha256: string;
  baseAmplitude?: number;
}

/**
 * Closed-loop v2 builder: measure Round 1 (uniform), derive TX, verify the
 * Round-2 send used exactly those amplitudes, measure Round 2, and persist
 * MEASURED effective gains. Theory (g_s x t_s^2) is stored as a diagnostic
 * comparison only and must never feed decisions (R1).
 */
export function buildCalibrationV2(input: BuildCalibrationV2Input): ChannelCalibrationV2 {
  validateSampleRate(input.sampleRate);
  const rounds = input.rounds ?? SYMBOL_CAL_ROUNDS;
  if (!Number.isInteger(rounds) || rounds < 4 || rounds > 400) throw new Error("Invalid calibration rounds");
  assertSha256(input.round1Sha256, "round1Sha256");
  assertSha256(input.round2Sha256, "round2Sha256");
  const symbols: number[] = [];
  for (let r = 0; r < rounds; r++) for (const s of SYMBOL_CAL_PATTERN) symbols.push(s);

  const round1 = measureSymbolRound(input.round1Samples, input.sampleRate, symbols);
  const derived = deriveTxAmplitudes(round1.symbolGains, input.baseAmplitude ?? CALIBRATION_AMPLITUDE);
  for (let s = 0; s < 4; s++) {
    if (derived.txAmplitudes[s] !== input.round2TxAmplitudes[s]) {
      throw new Error(`Round-2 TX amplitude mismatch on carrier ${s}: closed loop broken`);
    }
  }
  const round2 = measureSymbolRound(input.round2Samples, input.sampleRate, symbols);

  const predicted = [0, 1, 2, 3].map((s) => round1.symbolGains[s] * derived.txAmplitudes[s] * derived.txAmplitudes[s]);
  const predictedEffectiveGains = normalizePowerGains(predicted);

  const round1Quality = gateSymbolRound(round1, clippingRatioOf(input.round1Samples), "round1");
  const round2Quality = gateSymbolRound(round2, clippingRatioOf(input.round2Samples), "round2");
  const checks = [...round1Quality.checks, ...round2Quality.checks];
  // blockSend is governed by Round 1 (TX decision gate). Round 2 either
  // confirms the fix or honestly reports that the channel cannot be saved;
  // evidence verdict rules (CRC + exact match) remain the final authority.
  const quality: CalibrationQuality = {
    status: checks.every((c) => c.ok) ? "CALIBRATION PASS" : "CALIBRATION DEGRADED",
    blockSend: round1Quality.blockSend,
    checks,
  };

  return {
    version: CALIBRATION_V2_VERSION,
    sampleRate: input.sampleRate,
    symbolMs: EVIDENCE_SYMBOL_MS,
    rounds,
    pattern: [...SYMBOL_CAL_PATTERN],
    round1Sha256: input.round1Sha256,
    round2Sha256: input.round2Sha256,
    round1,
    rawSymbolGains: [...round1.symbolGains] as [number, number, number, number],
    txAmplitudes: [...derived.txAmplitudes] as [number, number, number, number],
    txPeakScale: derived.txPeakScale,
    txClamped: [...derived.txClamped],
    round2,
    effectiveRxGains: [...round2.symbolGains] as [number, number, number, number],
    diagnosticComparison: {
      predictedEffectiveGains,
      measuredEffectiveGains: [...round2.symbolGains] as [number, number, number, number],
    },
    quality,
    createdAt: new Date().toISOString(),
  };
}

export function serializeChannelCalibrationV2(calibration: ChannelCalibrationV2): string {
  return JSON.stringify(calibration, null, 2);
}

/**
 * R4 hash linkage: prove the v2 profile was produced by THESE two raw round
 * recordings. Hashes cover the raw WAV bytes (the same bytes the recorder
 * saves and the analyzer would re-read). Any mismatch REJECTS.
 */
export function verifyCalibrationWavHashes(
  calibration: ChannelCalibrationV2,
  round1Wav: Uint8Array,
  round2Wav: Uint8Array,
): void {
  const round1 = createHash("sha256").update(round1Wav).digest("hex");
  const round2 = createHash("sha256").update(round2Wav).digest("hex");
  if (round1 !== calibration.round1Sha256) {
    throw new Error("Round-1 WAV SHA-256 mismatch: calibration does not match this recording");
  }
  if (round2 !== calibration.round2Sha256) {
    throw new Error("Round-2 WAV SHA-256 mismatch: calibration does not match this recording");
  }
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`Invalid ${field}: calibration v2 requires the 64-hex SHA-256 of the raw round WAV`);
  }
}

function medianOfFour(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const median = (sorted[1] + sorted[2]) / 2;
  return median > 0 ? median : 1e-12;
}

function normalizePowerGains(values: number[]): [number, number, number, number] {
  return values.map((v) => v / medianOfFour(values)) as [number, number, number, number];
}

/** Exactness bar for persisted-vs-recomputed gains (JSON round-trips doubles). */
const GAIN_CONSISTENCY_TOLERANCE = 1e-9;

function assertTupleClose(actual: readonly [number, number, number, number], expected: readonly [number, number, number, number], field: string): void {
  for (let i = 0; i < 4; i++) {
    if (!(Math.abs(actual[i] - expected[i]) <= GAIN_CONSISTENCY_TOLERANCE)) {
      throw new Error(`Invalid ${field}: does not match measured round data`);
    }
  }
}

/**
 * Strict v2 loader. Missing or malformed round1Sha256/round2Sha256 REJECTS
 * the file (never a warning): without recording provenance a v2 profile
 * cannot be trusted. v1 files are NOT accepted here; use the legacy v1
 * loader for diagnostics only.
 */
export function loadChannelCalibrationV2(json: string): ChannelCalibrationV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid calibration JSON");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid calibration file");
  const cal = parsed as Record<string, unknown>;
  if (cal["version"] !== CALIBRATION_V2_VERSION) throw new Error("Unsupported calibration version (formal path requires v2)");
  assertSha256(cal["round1Sha256"], "round1Sha256");
  assertSha256(cal["round2Sha256"], "round2Sha256");
  if (!Number.isInteger(cal["sampleRate"] as number) || (cal["sampleRate"] as number) < 8000 || (cal["sampleRate"] as number) > 192000) {
    throw new Error("Invalid calibration sample rate");
  }
  if (!Number.isInteger(cal["rounds"] as number) || (cal["rounds"] as number) < 4 || (cal["rounds"] as number) > 400) {
    throw new Error("Invalid calibration rounds");
  }
  if (!Array.isArray(cal["pattern"]) || (cal["pattern"] as unknown[]).join(",") !== "0,1,2,3") {
    throw new Error("Invalid calibration pattern");
  }
  const rounds = cal["rounds"] as number;
  const round1 = loadSymbolRound(cal["round1"], "round1", rounds);
  const round2 = loadSymbolRound(cal["round2"], "round2", rounds);
  const gains = loadGainTuple(cal["rawSymbolGains"], "rawSymbolGains");
  const txAmplitudes = (cal["txAmplitudes"] as unknown[]).map((a) => {
    if (!Number.isFinite(a as number) || (a as number) <= 0 || (a as number) > 1) throw new Error("Invalid TX amplitude");
    return a as number;
  });
  if (txAmplitudes.length !== 4) throw new Error("Invalid TX amplitudes");
  const effectiveRxGains = loadGainTuple(cal["effectiveRxGains"], "effectiveRxGains");
  const diagnostic = cal["diagnosticComparison"] as Record<string, unknown> | undefined;
  if (typeof diagnostic !== "object" || diagnostic === null) throw new Error("Invalid diagnostic comparison");
  const predicted = loadGainTuple(diagnostic["predictedEffectiveGains"], "predictedEffectiveGains");
  const measured = loadGainTuple(diagnostic["measuredEffectiveGains"], "measuredEffectiveGains");
  const quality = cal["quality"] as CalibrationQuality | undefined;
  if (!quality || (quality.status !== "CALIBRATION PASS" && quality.status !== "CALIBRATION DEGRADED")) {
    throw new Error("Invalid calibration quality gate");
  }
  // R1/R4 closed-loop integrity: persisted aggregates must equal the round
  // measurements they claim to summarize. Hand-edited gains are rejected
  // here, so the analyzer can never be fed swapped-in values.
  assertTupleClose(gains, round1.symbolGains, "rawSymbolGains");
  assertTupleClose(effectiveRxGains, round2.symbolGains, "effectiveRxGains");
  assertTupleClose(measured, round2.symbolGains, "measuredEffectiveGains");
  const recomputedPredicted = normalizePowerGains(
    [0, 1, 2, 3].map((s) => round1.symbolGains[s] * txAmplitudes[s] * txAmplitudes[s]),
  );
  assertTupleClose(predicted, recomputedPredicted, "predictedEffectiveGains");
  return {
    version: CALIBRATION_V2_VERSION,
    sampleRate: cal["sampleRate"] as number,
    symbolMs: 26,
    rounds,
    pattern: [0, 1, 2, 3],
    round1Sha256: cal["round1Sha256"] as string,
    round2Sha256: cal["round2Sha256"] as string,
    round1,
    rawSymbolGains: gains,
    txAmplitudes: txAmplitudes as [number, number, number, number],
    txPeakScale: Number.isFinite(cal["txPeakScale"] as number) ? (cal["txPeakScale"] as number) : 1,
    txClamped: Array.isArray(cal["txClamped"]) ? (cal["txClamped"] as boolean[]).map(Boolean).slice(0, 4) : [false, false, false, false],
    round2,
    effectiveRxGains,
    diagnosticComparison: { predictedEffectiveGains: predicted, measuredEffectiveGains: measured },
    quality: { status: quality.status, blockSend: quality.blockSend === true, checks: Array.isArray(quality.checks) ? quality.checks : [] },
    createdAt: typeof cal["createdAt"] === "string" ? cal["createdAt"] : new Date(0).toISOString(),
  };
}

function loadGainTuple(value: unknown, field: string): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) throw new Error(`Invalid ${field}`);
  return (value as unknown[]).map((g) => {
    if (!Number.isFinite(g as number) || !((g as number) > 0)) throw new Error(`Invalid ${field} gain`);
    return g as number;
  }) as [number, number, number, number];
}

function loadSymbolRound(value: unknown, field: string, rounds: number): SymbolRoundMeasurement {
  if (typeof value !== "object" || value === null) throw new Error(`Invalid ${field}`);
  const round = value as Record<string, unknown>;
  const counts = round["confusionCounts"] as unknown;
  if (!Array.isArray(counts) || counts.length !== 4) throw new Error(`Invalid ${field} confusion counts`);
  const parsedCounts: number[][] = (counts as unknown[]).map((row, s) => {
    if (!Array.isArray(row) || row.length !== 4) throw new Error(`Invalid ${field} confusion row ${s}`);
    const parsed = (row as unknown[]).map((c) => {
      if (!Number.isInteger(c as number) || (c as number) < 0) throw new Error(`Invalid ${field} confusion count`);
      return c as number;
    });
    // Each sent symbol appears exactly `rounds` times: structural proof the
    // confusion table matches the fixed calibration sequence.
    if (parsed.reduce((a, b) => a + b, 0) !== rounds) throw new Error(`Invalid ${field} confusion row total`);
    return parsed;
  });
  const confusion = parsedCounts.map((row) => {
    const total = row.reduce((a, b) => a + b, 0);
    return row.map((c) => c / total);
  });
  const decisions = round["decisions"] as unknown;
  if (!Array.isArray(decisions) || decisions.length !== rounds * 4) throw new Error(`Invalid ${field} decisions`);
  const parsedDecisions: KnownSymbolDecision[] = (decisions as unknown[]).map((entry, i) => {
    if (typeof entry !== "object" || entry === null) throw new Error(`Invalid ${field} decision ${i}`);
    const e = entry as Record<string, unknown>;
    const expected = e["expected"] as number;
    const winner = e["winner"] as number;
    if (!Number.isInteger(expected) || expected < 0 || expected > 3) throw new Error(`Invalid ${field} decision expected`);
    if (!Number.isInteger(winner) || winner < 0 || winner > 3) throw new Error(`Invalid ${field} decision winner`);
    if (expected !== (i % 4)) throw new Error(`Invalid ${field} decision order`);
    const raw = loadPowerTuple(e["rawPowers"], `${field} rawPowers`);
    const normalized = loadPowerTuple(e["normalizedPowers"], `${field} normalizedPowers`);
    if (!Number.isFinite(e["confidence"] as number)) throw new Error(`Invalid ${field} decision confidence`);
    return {
      index: i,
      expected,
      winner,
      start: Number.isFinite(e["start"] as number) ? (e["start"] as number) : 0,
      rawPowers: raw,
      normalizedPowers: normalized,
      confidence: e["confidence"] as number,
      winnerFrequency: EVIDENCE_FREQUENCIES[winner],
      expectedFrequency: EVIDENCE_FREQUENCIES[expected],
    };
  });
  // Cross-check: decisions must reproduce the confusion table exactly (R3).
  for (let s = 0; s < 4; s++) {
    for (let r = 0; r < 4; r++) {
      const recomputed = parsedDecisions.filter((d) => d.expected === s && d.winner === r).length;
      if (recomputed !== parsedCounts[s][r]) throw new Error(`Invalid ${field} confusion/decision mismatch`);
    }
  }
  const symbolGains = loadGainTuple(round["symbolGains"], `${field} symbolGains`);
  const symbolSnrDb = round["symbolSnrDb"] as unknown;
  if (!Array.isArray(symbolSnrDb) || symbolSnrDb.length !== 4 || !(symbolSnrDb as unknown[]).every((v) => Number.isFinite(v as number))) {
    throw new Error(`Invalid ${field} symbolSnrDb`);
  }
  return {
    decisions: parsedDecisions,
    confusionCounts: parsedCounts,
    confusion,
    diagonal: [0, 1, 2, 3].map((s) => confusion[s][s]) as [number, number, number, number],
    symbolGains,
    symbolSnrDb: symbolSnrDb as [number, number, number, number],
    startSample: Number.isFinite(round["startSample"] as number) ? (round["startSample"] as number) : 0,
    samplesPerSymbol: Number.isFinite(round["samplesPerSymbol"] as number) ? (round["samplesPerSymbol"] as number) : 0,
  };
}

function loadPowerTuple(value: unknown, field: string): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) throw new Error(`Invalid ${field}`);
  return (value as unknown[]).map((p) => {
    if (!Number.isFinite(p as number) || (p as number) < 0) throw new Error(`Invalid ${field} power`);
    return p as number;
  }) as [number, number, number, number];
}

/** Formal-path analyzer view: nominal centers + MEASURED Round-2 gains. */
export function toEvidenceEqualizationV2(calibration: ChannelCalibrationV2): {
  frequenciesHz: [number, number, number, number];
  rxGains: [number, number, number, number];
  provenance: {
    kind: "v2-measured";
    source: string;
    round1Sha256: string;
    round2Sha256: string;
  };
} {
  return {
    frequenciesHz: [...EVIDENCE_FREQUENCIES] as [number, number, number, number],
    rxGains: [...calibration.effectiveRxGains] as [number, number, number, number],
    provenance: {
      kind: "v2-measured",
      source: "vaml-acoustic-calibration-v2",
      round1Sha256: calibration.round1Sha256,
      round2Sha256: calibration.round2Sha256,
    },
  };
}

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
