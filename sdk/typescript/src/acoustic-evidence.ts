/**
 * Offline VAML acoustic evidence analyzer (two-computer probe).
 *
 * Analyzes a raw WAV captured on Computer B via
 * tools/two-computer-acoustic-evidence.html WITHOUT trusting the
 * browser page PASS/FAIL indicator.
 *
 * Known evidence probe profile:
 * - 26 ms symbols, 4-FSK 800/1200/1600/2000 Hz, 2 bits/symbol
 * - 32-symbol preamble, 3 repetitions, 650 ms gap
 * - fixed payload a34f912c770de851, packet VAC1 + length + payload + CRC32
 *
 * CRC32 here is transport corruption detection only. It is NOT
 * cryptographic authentication (that belongs to the VAML session).
 *
 * Detection is matched (carrier-energy scan -> known-preamble
 * correlation -> candidate peaks -> NMS/minimum separation -> timing
 * refinement), never a bare RMS threshold. Symbol timing uses a
 * preamble-derived global samples-per-symbol plus a small bounded
 * per-symbol correction; per-symbol timing never random-walks.
 */

import { createHash } from "node:crypto";

export const EVIDENCE_SYMBOL_MS = 26;
export const EVIDENCE_FREQUENCIES = [800, 1200, 1600, 2000] as const;
export const EVIDENCE_PREAMBLE = Object.freeze([
  0, 3, 1, 2, 0, 3, 1, 2, 3, 0, 2, 1, 3, 0, 2, 1,
  0, 2, 3, 1, 0, 2, 3, 1, 2, 0, 1, 3, 2, 0, 1, 3,
]);
export const EVIDENCE_REPETITIONS = 3;
export const EVIDENCE_GAP_MS = 650;
export const EVIDENCE_PAYLOAD_HEX = "a34f912c770de851";
export const EVIDENCE_MAGIC = [86, 65, 67, 49]; // "VAC1"
export const EVIDENCE_PAYLOAD = Buffer.from(EVIDENCE_PAYLOAD_HEX, "hex");
export const EVIDENCE_FRAME_LENGTH = EVIDENCE_PAYLOAD.length;

const EXPECTED_PACKET = buildExpectedPacket();
const EXPECTED_PACKET_SYMBOLS = bytesToSymbols([...EXPECTED_PACKET]);

function buildExpectedPacket(): Buffer {
  const packet = Buffer.alloc(4 + 4 + EVIDENCE_PAYLOAD.length + 4);
  Buffer.from(EVIDENCE_MAGIC).copy(packet, 0);
  packet.writeUInt32BE(EVIDENCE_PAYLOAD.length, 4);
  EVIDENCE_PAYLOAD.copy(packet, 8);
  packet.writeUInt32BE(crc32(packet.subarray(0, 8 + EVIDENCE_PAYLOAD.length)), 8 + EVIDENCE_PAYLOAD.length);
  return packet;
}

export function expectedPacketSymbols(): number[] {
  return [...EXPECTED_PACKET_SYMBOLS];
}

/**
 * Receiver equalization derived from a channel calibration.
 * - frequenciesHz: calibration-derived Goertzel centers (nominal + offset).
 *   The bounded ±45 Hz Doppler search around them is retained.
 * - rxGains: per-carrier channel gains (> 0). Symbol decisions compare
 *   measuredPower[f] / rxGains[f]; raw powers are always preserved alongside.
 */
export interface EvidenceEqualization {
  frequenciesHz: readonly [number, number, number, number];
  rxGains: readonly [number, number, number, number];
  /**
   * Where the gains came from. v2-measured = Round-2 recording (formal
   * path); v1-legacy = long-tone diagnostic (never the formal path).
   * Absent means the caller did not declare provenance.
   */
  provenance?: {
    kind: "v1-legacy" | "v2-measured";
    source: string;
    round1Sha256?: string;
    round2Sha256?: string;
  };
}

function eqCenter(eq: EvidenceEqualization | undefined, carrier: number): number {
  return eq ? eq.frequenciesHz[carrier] : EVIDENCE_FREQUENCIES[carrier];
}

function eqGain(eq: EvidenceEqualization | undefined, carrier: number): number {
  return eq ? eq.rxGains[carrier] : 1;
}

function validateEqualization(eq: EvidenceEqualization, sampleRate: number): void {
  if (!eq || eq.frequenciesHz.length !== 4 || eq.rxGains.length !== 4) {
    throw new Error("Invalid evidence equalization");
  }
  for (let s = 0; s < 4; s++) {
    const f = eq.frequenciesHz[s];
    const g = eq.rxGains[s];
    if (!Number.isFinite(f) || f <= 0 || f >= sampleRate / 2) throw new Error("Invalid equalized frequency");
    if (!Number.isFinite(g) || !(g > 0)) throw new Error("Invalid RX channel gain");
  }
}

// ---------------------------------------------------------------- WAV ----

export interface WavIntegrity {
  valid: boolean;
  format: string;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  sampleCount: number;
  durationSeconds: number;
  sha256: string;
  rms: number;
  peak: number;
  clippingRatio: number;
  error?: string;
}

export interface ParsedWav {
  integrity: WavIntegrity;
  /** Mono float samples in [-1, 1]. Empty when invalid. */
  samples: Float64Array;
}

export function parseEvidenceWav(wav: Uint8Array): ParsedWav {
  const bytes = Buffer.from(wav);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const fail = (error: string, partial?: Partial<WavIntegrity>): ParsedWav => ({
    integrity: {
      valid: false,
      format: "unknown",
      channels: 0,
      sampleRate: 0,
      bitsPerSample: 0,
      sampleCount: 0,
      durationSeconds: 0,
      sha256,
      rms: 0,
      peak: 0,
      clippingRatio: 0,
      error,
      ...partial,
    },
    samples: new Float64Array(0),
  });
  if (bytes.length < 44) return fail("File too small for WAV header");
  if (bytes.subarray(0, 4).toString("ascii") !== "RIFF") return fail("Missing RIFF marker");
  if (bytes.subarray(8, 12).toString("ascii") !== "WAVE") return fail("Missing WAVE marker");
  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: Buffer | undefined;
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + size > bytes.length) return fail("Truncated WAV chunk");
    if (id === "fmt ") {
      if (size < 16) return fail("Invalid fmt chunk");
      format = bytes.readUInt16LE(offset);
      channels = bytes.readUInt16LE(offset + 2);
      sampleRate = bytes.readUInt32LE(offset + 4);
      bits = bytes.readUInt16LE(offset + 14);
    } else if (id === "data") {
      data = bytes.subarray(offset, offset + size);
    }
    offset += size + (size & 1);
  }
  if (format !== 1) return fail(`Unsupported WAV format ${format} (need PCM 1)`, { format: `non-PCM:${format}` });
  if (!channels || !sampleRate || !data) return fail("Missing fmt/data chunk");
  if (bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32) {
    return fail(`Unsupported bit depth ${bits}`, { channels, sampleRate, bitsPerSample: bits });
  }
  const bytesPerSample = bits / 8;
  const frameCount = Math.floor(data.length / (bytesPerSample * channels));
  if (frameCount <= 0) return fail("Empty data chunk", { channels, sampleRate, bitsPerSample: bits });
  const mono = new Float64Array(frameCount);
  let peak = 0;
  let sum = 0;
  let clipped = 0;
  for (let f = 0; f < frameCount; f++) {
    let acc = 0;
    for (let ch = 0; ch < channels; ch++) {
      const at = (f * channels + ch) * bytesPerSample;
      let v: number;
      if (bits === 16) v = data.readInt16LE(at) / 32768;
      else if (bits === 8) v = (data[at] - 128) / 128;
      else if (bits === 24) v = data.readIntLE(at, 3) / 8388608;
      else v = data.readInt32LE(at) / 2147483648;
      acc += v;
    }
    const m = acc / channels;
    mono[f] = m;
    const a = Math.abs(m);
    if (a > peak) peak = a;
    sum += m * m;
    if (a >= 0.999) clipped++;
  }
  const rms = Math.sqrt(sum / frameCount);
  return {
    integrity: {
      valid: true,
      format: "PCM",
      channels,
      sampleRate,
      bitsPerSample: bits,
      sampleCount: frameCount,
      durationSeconds: frameCount / sampleRate,
      sha256,
      rms,
      peak,
      clippingRatio: clipped / frameCount,
    },
    samples: mono,
  };
}

// ------------------------------------------------------------- DSP core ---

interface SymbolPowers {
  symbol: number;
  start: number;
  quality: number;
  /** Raw narrow-band powers (never scaled). */
  powers: [number, number, number, number];
  /** Decision powers: raw divided by RX channel gains (== raw when unequalized). */
  normalizedPowers: [number, number, number, number];
}

function goertzel(samples: Float64Array, start: number, count: number, frequency: number, sampleRate: number): number {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const coefficient = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < count; i++) {
    const x = samples[start + i] ?? 0;
    s0 = x + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coefficient * s1 * s2;
}

/** Fine per-symbol decision with bounded local timing search. */
function decideFine(
  samples: Float64Array,
  predictedStart: number,
  samplesPerSymbol: number,
  sampleRate: number,
  searchRadius: number,
  eq?: EvidenceEqualization,
): SymbolPowers | undefined {
  const guard = Math.max(2, Math.round(samplesPerSymbol * 0.22));
  const window = Math.max(64, Math.round(samplesPerSymbol) - guard * 2);
  const base = Math.round(predictedStart);
  const step = searchRadius > 4 ? 2 : 1;
  let best: SymbolPowers | undefined;
  for (let dt = -searchRadius; dt <= searchRadius; dt += step) {
    const start = base + dt;
    const a = start + guard;
    if (a < 0 || a + window > samples.length) continue;
    const powers: [number, number, number, number] = [0, 0, 0, 0];
    const normalized: [number, number, number, number] = [0, 0, 0, 0];
    for (let s = 0; s < 4; s++) {
      let p = 0;
      for (const df of [-45, 0, 45]) {
        p = Math.max(p, goertzel(samples, a, window, eqCenter(eq, s) + df, sampleRate));
      }
      powers[s] = p;
      normalized[s] = p / eqGain(eq, s);
    }
    let winner = 0;
    for (let s = 1; s < 4; s++) if (normalized[s] > normalized[winner]) winner = s;
    let second = -Infinity;
    for (let s = 0; s < 4; s++) if (s !== winner && normalized[s] > second) second = normalized[s];
    const q = normalized[winner] > 0 ? Math.max(0, (normalized[winner] - Math.max(0, second)) / normalized[winner]) : 0;
    if (!best || q > best.quality) {
      best = { symbol: winner, start, quality: q, powers, normalizedPowers: normalized };
    }
  }
  return best;
}

/** Fast single-offset decision for preamble scoring (no Doppler probes). */
function decideFast(
  samples: Float64Array,
  predictedStart: number,
  samplesPerSymbol: number,
  sampleRate: number,
  eq?: EvidenceEqualization,
): { symbol: number; quality: number; start: number } | undefined {
  const guard = Math.max(2, Math.round(samplesPerSymbol * 0.22));
  const window = Math.max(64, Math.round(samplesPerSymbol) - guard * 2);
  const a = Math.round(predictedStart) + guard;
  if (a < 0 || a + window > samples.length) return undefined;
  let winner = 0;
  let best = -Infinity;
  let second = -Infinity;
  for (let s = 0; s < 4; s++) {
    const p = goertzel(samples, a, window, eqCenter(eq, s), sampleRate) / eqGain(eq, s);
    if (p > best) { second = best; best = p; winner = s; }
    else if (p > second) second = p;
  }
  const q = best > 0 ? Math.max(0, (best - Math.max(0, second)) / best) : 0;
  return { symbol: winner, quality: q, start: Math.round(predictedStart) };
}
function decideCoarse(samples: Float64Array, predictedStart: number, samplesPerSymbol: number, sampleRate: number, eq?: EvidenceEqualization): { symbol: number; quality: number } | undefined {
  const guard = Math.round(samplesPerSymbol * 0.25);
  const window = Math.max(96, Math.round(samplesPerSymbol * 0.5));
  const a = Math.round(predictedStart) + guard;
  if (a < 0 || a + window > samples.length) return undefined;
  let winner = 0;
  let best = -Infinity;
  let second = -Infinity;
  for (let s = 0; s < 4; s++) {
    const p = goertzel(samples, a, window, eqCenter(eq, s), sampleRate) / eqGain(eq, s);
    if (p > best) { second = best; best = p; winner = s; }
    else if (p > second) second = p;
  }
  const q = best > 0 ? Math.max(0, (best - Math.max(0, second)) / best) : 0;
  return { symbol: winner, quality: q };
}

function scorePreambleCoarse(samples: Float64Array, start: number, sps: number, sampleRate: number, probeLength: number, eq?: EvidenceEqualization): { matches: number; quality: number } | undefined {
  let matches = 0;
  let quality = 0;
  for (let i = 0; i < probeLength; i++) {
    const d = decideCoarse(samples, start + i * sps, sps, sampleRate, eq);
    if (!d) return undefined;
    if (d.symbol === EVIDENCE_PREAMBLE[i]) { matches++; quality += d.quality; }
    else quality -= 0.15;
  }
  return { matches, quality };
}

function scorePreambleFine(samples: Float64Array, start: number, sps: number, sampleRate: number, eq?: EvidenceEqualization): { matches: number; quality: number } | undefined {
  // Sequential cursor version (kept explicit for timing correctness).
  // Uses the fast single-offset decision: scoring runs over up to
  // 6 seeds x 11 clock hypotheses x ~13 timing offsets, so the
  // Doppler-probed decode is reserved for final per-symbol analysis.
  let cursor = start;
  let matches = 0;
  let quality = 0;
  for (const expected of EVIDENCE_PREAMBLE) {
    const d = decideFast(samples, cursor, sps, sampleRate, eq);
    if (!d) return undefined;
    if (d.symbol === expected) { matches++; quality += d.quality; }
    else quality -= 0.25;
    cursor = d.start + sps;
  }
  return { matches, quality };
}

// ------------------------------------------------------------ analysis ----

export interface SymbolAnalysis {
  index: number;
  expected: number;
  decoded: number;
  confidence: number;
  winnerPower: number;
  secondPower: number;
  margin: number;
  winnerFrequency: number;
  expectedFrequency: number;
}

export interface CarrierAnalysis {
  frequency: number;
  /** Goertzel center actually used (nominal, or calibration-derived). */
  appliedCenterHz: number;
  meanPower: number;
  relativePower: number;
  /** Mean power after RX gain normalization. */
  normalizedMeanPower: number;
  normalizedRelativePower: number;
  /** Absolute peak offset vs the nominal carrier frequency. */
  frequencyOffsetHz: number;
  snrDb: number;
  margin: number;
}

export interface TimingAnalysis {
  startSample: number;
  startSeconds: number;
  nominalSamplesPerSymbol: number;
  estimatedSamplesPerSymbol: number;
  clockDriftPpm: number;
  accumulatedErrorSamples: number;
  earlyLateError: number;
}

export interface BurstReport {
  burst: number;
  startSample: number;
  endSample: number;
  timing: TimingAnalysis;
  carriers: CarrierAnalysis[];
  /** Equalization actually applied to this burst (null fields when off). */
  equalization: {
    applied: boolean;
    centersHz: number[];
    rxGains: number[];
  };
  preamble: SymbolAnalysis[];
  preambleMatches: number;
  packetSymbols: SymbolAnalysis[];
  magicOk: boolean;
  decodedLength: number;
  rawHeaderHex: string;
  receivedPayloadHex: string;
  byteErrors: number | null;
  bitErrors: number | null;
  crcExpected: string;
  crcCalculated: string;
  crcOk: boolean;
  payloadMatch: boolean;
  passed: boolean;
}

export interface CombinedReport {
  payloadHex: string;
  magicOk: boolean;
  length: number;
  crcOk: boolean;
  payloadMatch: boolean;
  passed: boolean;
}

export type EvidenceVerdict = "VERIFIED PASS" | "VERIFIED PARTIAL" | "VERIFIED FAIL";

export interface EvidenceReport {
  wav: WavIntegrity;
  profile: { symbolMs: number; frequencies: number[]; preambleLength: number; repetitions: number; gapMs: number };
  expectedPayloadHex: string;
  /** Calibration applied to this analysis (null when unequalized). */
  equalization: {
    applied: boolean;
    source: string;
    kind: "v1-legacy" | "v2-measured" | "undeclared";
    centersHz: number[];
    rxGains: number[];
    round1Sha256?: string;
    round2Sha256?: string;
  } | null;
  bursts: BurstReport[];
  combined: CombinedReport | null;
  verdict: EvidenceVerdict;
  verdictReason: string;
}

function bytesToSymbols(data: number[] | Uint8Array | Buffer): number[] {
  const out: number[] = [];
  for (const byte of data) out.push((byte >>> 6) & 3, (byte >>> 4) & 3, (byte >>> 2) & 3, byte & 3);
  return out;
}

function symbolsToBytes(symbols: number[]): Buffer {
  const out = Buffer.alloc(Math.floor(symbols.length / 4));
  for (let i = 0; i < out.length; i++) {
    const p = i * 4;
    out[i] = (symbols[p] << 6) | (symbols[p + 1] << 4) | (symbols[p + 2] << 2) | symbols[p + 3];
  }
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

function hex(n: number): string {
  return (n >>> 0).toString(16).padStart(8, "0");
}

function countBitErrors(a: Buffer, b: Buffer): number | null {
  if (a.length !== b.length) return null;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    let v = a[i] ^ b[i];
    while (v) { n += v & 1; v >>>= 1; }
  }
  return n;
}

function countByteErrors(a: Buffer, b: Buffer): number | null {
  if (a.length !== b.length) return null;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

interface RefinedCandidate {
  start: number;
  samplesPerSymbol: number;
  preambleMatches: number;
  score: number;
}

/** Full-burst matched score: all 112 known symbols (preamble + expected
 *  packet). Clock error accumulates over the whole burst (1% drift shifts late
 *  symbols by more than a full symbol), so only the true clock scores near
 *  112 matches. This is what makes the ppm choice decisive. */
function scoreFullBurst(samples: Float64Array, start: number, sps: number, sampleRate: number, eq?: EvidenceEqualization): { matches: number; quality: number; preambleMatches: number } | undefined {
  let cursor = start;
  let matches = 0;
  let quality = 0;
  let preambleMatches = 0;
  const all = EVIDENCE_PREAMBLE.length + EXPECTED_PACKET_SYMBOLS.length;
  for (let i = 0; i < all; i++) {
    const expected = i < EVIDENCE_PREAMBLE.length ? EVIDENCE_PREAMBLE[i] : EXPECTED_PACKET_SYMBOLS[i - EVIDENCE_PREAMBLE.length];
    const d = decideFast(samples, cursor, sps, sampleRate, eq);
    if (!d) return undefined;
    if (d.symbol === expected) {
      matches++;
      quality += d.quality;
      if (i < EVIDENCE_PREAMBLE.length) preambleMatches++;
    } else {
      quality -= 0.25;
    }
    cursor = d.start + sps;
  }
  return { matches, quality, preambleMatches };
}

function refineSeed(samples: Float64Array, sampleRate: number, seedStart: number, eq?: EvidenceEqualization): RefinedCandidate | undefined {
  const nominal = (sampleRate * EVIDENCE_SYMBOL_MS) / 1000;
  const radius = Math.round(nominal * 0.55);
  const step = Math.max(2, Math.round(nominal / 12));
  // Stage A: timing-only search at nominal clock (preamble is short enough
  // that clock error barely matters here).
  let best: RefinedCandidate | undefined;
  for (let d = -radius; d <= radius; d += step) {
    const start = seedStart + d;
    if (start < 0) continue;
    const scored = scorePreambleFine(samples, start, nominal, sampleRate, eq);
    if (!scored) continue;
    const score = scored.matches * 8 + scored.quality;
    if (!best || score > best.score) {
      best = { start, samplesPerSymbol: nominal, preambleMatches: scored.matches, score };
    }
  }
  if (!best) return undefined;
  // Stage B: clock search (covers sound-card mismatch, up to +-25000 ppm)
  // scored over the full 112-symbol known burst so the true clock wins
  // decisively instead of tying on preamble quality noise.
  const ppmGrid = [0, -2000, 2000, -5000, 5000, -10000, 10000, -15000, 15000, -25000, 25000];
  const narrow = Math.max(step * 2, Math.round(nominal * 0.3));
  let refined: RefinedCandidate | undefined;
  for (const ppm of ppmGrid) {
    const sps = nominal * (1 + ppm / 1_000_000);
    for (let d = -narrow; d <= narrow; d += step) {
      const start = best.start + d;
      if (start < 0) continue;
      const scored = scoreFullBurst(samples, start, sps, sampleRate, eq);
      if (!scored) continue;
      const score = scored.matches * 8 + scored.quality;
      if (!refined || score > refined.score) {
        refined = { start, samplesPerSymbol: sps, preambleMatches: scored.preambleMatches, score };
      }
    }
  }
  return refined;
}

function analyzeTimingEarlyLate(samples: Float64Array, start: number, sps: number, sampleRate: number, eq?: EvidenceEqualization): number {
  const guard = Math.max(2, Math.round(sps * 0.22));
  const window = Math.max(64, Math.round(sps) - guard * 2);
  const delta = Math.max(1, Math.round(sps * 0.02));
  let acc = 0;
  let n = 0;
  for (let i = 0; i < EVIDENCE_PREAMBLE.length; i++) {
    const center = Math.round(start + i * sps) + guard;
    if (center - delta < 0 || center + delta + window > samples.length) continue;
    const expected = EVIDENCE_PREAMBLE[i];
    const early = goertzel(samples, center - delta, window, eqCenter(eq, expected), sampleRate);
    const late = goertzel(samples, center + delta, window, eqCenter(eq, expected), sampleRate);
    const denom = early + late;
    if (denom > 0) { acc += (late - early) / denom; n++; }
  }
  return n ? acc / n : 0;
}

function analyzeCarriers(preambleSymbols: SymbolAnalysis[], samples: Float64Array, start: number, sps: number, sampleRate: number, eq?: EvidenceEqualization): CarrierAnalysis[] {
  const offsets = [-80, -60, -40, -20, 0, 20, 40, 60, 80];
  return EVIDENCE_FREQUENCIES.map((freq, carrier) => {
    const center = eqCenter(eq, carrier);
    const relevant = preambleSymbols.filter((s) => s.expected === carrier);
    const meanPower = relevant.length
      ? relevant.reduce((a, s) => a + s.winnerPower, 0) / relevant.length
      : 0;
    let bestOffset = 0;
    let bestPower = -Infinity;
    const guard = Math.max(2, Math.round(sps * 0.25));
    const window = Math.max(96, Math.round(sps * 0.5));
    for (const df of offsets) {
      let total = 0;
      let count = 0;
      for (let i = 0; i < EVIDENCE_PREAMBLE.length; i++) {
        if (EVIDENCE_PREAMBLE[i] !== carrier) continue;
        const a = Math.round(start + i * sps) + guard;
        if (a < 0 || a + window > samples.length) continue;
        total += goertzel(samples, a, window, center + df, sampleRate);
        count++;
      }
      const avg = count ? total / count : 0;
      if (avg > bestPower) { bestPower = avg; bestOffset = df; }
    }
    // Approximate SNR: mean winner power vs mean strongest-loser power.
    let sig = 0;
    let noise = 0;
    let m = 0;
    for (const s of relevant) {
      sig += s.winnerPower;
      noise += s.secondPower;
      m += s.margin;
    }
    const snrDb = relevant.length && noise > 0 && sig > 0
      ? 10 * Math.log10(Math.max(1e-12, sig / relevant.length) / Math.max(1e-12, noise / relevant.length))
      : Number.NEGATIVE_INFINITY;
    const gain = eqGain(eq, carrier);
    return {
      frequency: freq,
      appliedCenterHz: center,
      meanPower,
      relativePower: 0, // filled by caller after totals are known
      normalizedMeanPower: meanPower / gain,
      normalizedRelativePower: 0, // filled by caller after totals are known
      frequencyOffsetHz: center + bestOffset - freq,
      snrDb,
      margin: relevant.length ? m / relevant.length : 0,
    };
  });
}

/**
 * Decode a known symbol sequence with the receiver's own pipeline.
 *
 * R3 hard requirement: the ground-truth `expectedSymbols` are attached
 * AFTER each decision for statistics only. The winner comes exclusively
 * from the same bounded-search argmax used for evidence packets — expected
 * symbols never change, retry, bias, or re-center a decision.
 */
export interface KnownSymbolDecision {
  index: number;
  expected: number;
  winner: number;
  /** Receiver sample offset chosen by the bounded timing search. */
  start: number;
  rawPowers: [number, number, number, number];
  normalizedPowers: [number, number, number, number];
  confidence: number;
  winnerFrequency: number;
  expectedFrequency: number;
}

export function decodeKnownSymbols(
  samples: Float64Array,
  sampleRate: number,
  startSample: number,
  samplesPerSymbol: number,
  expectedSymbols: readonly number[],
  eq?: EvidenceEqualization,
): KnownSymbolDecision[] {
  if (!(samples instanceof Float64Array) || samples.length === 0) throw new Error("Invalid evidence samples");
  if (!Number.isFinite(startSample) || !Number.isFinite(samplesPerSymbol) || samplesPerSymbol <= 0) {
    throw new Error("Invalid symbol timing");
  }
  if (eq !== undefined) validateEqualization(eq, sampleRate);
  const search = Math.max(4, Math.round(samplesPerSymbol * 0.02));
  const out: KnownSymbolDecision[] = [];
  let cursor = startSample;
  for (let i = 0; i < expectedSymbols.length; i++) {
    const expected = expectedSymbols[i];
    if (!Number.isInteger(expected) || expected < 0 || expected > 3) throw new Error("Invalid expected symbol");
    const d = decideFine(samples, cursor, samplesPerSymbol, sampleRate, search, eq);
    if (!d) throw new Error("Truncated symbol stream");
    out.push({
      index: i,
      expected,
      winner: d.symbol,
      start: d.start,
      rawPowers: [...d.powers] as [number, number, number, number],
      normalizedPowers: [...d.normalizedPowers] as [number, number, number, number],
      confidence: d.quality,
      winnerFrequency: EVIDENCE_FREQUENCIES[d.symbol],
      expectedFrequency: EVIDENCE_FREQUENCIES[expected],
    });
    cursor = d.start + samplesPerSymbol;
  }
  return out;
}

/** Least-squares slope of detected starts vs symbol index (samples/symbol). */
function fitSamplesPerSymbol(x: number[], y: number[], fallback: number): number {
  const n = x.length;
  if (n < 8) return fallback;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
  const denom = n * sxx - sx * sx;
  if (!(denom > 0)) return fallback;
  const slope = (n * sxy - sx * sy) / denom;
  return Number.isFinite(slope) && slope > 0 ? slope : fallback;
}

function decodeBurst(samples: Float64Array, sampleRate: number, candidate: RefinedCandidate, burstIndex: number, eq?: EvidenceEqualization): BurstReport {
  const nominal = (sampleRate * EVIDENCE_SYMBOL_MS) / 1000;
  // Single shared pipeline: preamble + packet both decode through
  // decodeKnownSymbols (same bounded-search argmax as calibration rounds).
  // Cursor chaining is preserved exactly: each packet symbol continues from
  // the previous decision (d.start + sps).
  const toAnalysis = (d: KnownSymbolDecision, index: number): SymbolAnalysis => {
    const sorted = [...d.rawPowers].sort((a, b) => b - a);
    const winner = sorted[0];
    const second = sorted[1] ?? 0;
    return {
      index,
      expected: d.expected,
      decoded: d.winner,
      confidence: d.confidence,
      winnerPower: winner,
      secondPower: Math.max(0, second),
      margin: winner > 0 ? Math.max(0, (winner - Math.max(0, second)) / winner) : 0,
      winnerFrequency: d.winnerFrequency,
      expectedFrequency: d.expectedFrequency,
    };
  };
  const preDecisions = decodeKnownSymbols(samples, sampleRate, candidate.start, candidate.samplesPerSymbol, EVIDENCE_PREAMBLE, eq);
  const preamble = preDecisions.map((d, i) => toAnalysis(d, i));
  const preambleMatches = preamble.filter((s) => s.expected === s.decoded).length;

  const packetStart = preDecisions.length
    ? preDecisions[preDecisions.length - 1].start + candidate.samplesPerSymbol
    : candidate.start;
  const packetDecisions = decodeKnownSymbols(samples, sampleRate, packetStart, candidate.samplesPerSymbol, EXPECTED_PACKET_SYMBOLS, eq);
  const packetSymbols = packetDecisions.map((d, i) => toAnalysis(d, EVIDENCE_PREAMBLE.length + i));
  const decodedSymbols = packetDecisions.map((d) => d.winner);
  const cursor = packetDecisions.length
    ? packetDecisions[packetDecisions.length - 1].start + candidate.samplesPerSymbol
    : packetStart;

  const raw = symbolsToBytes(decodedSymbols);
  const rawHeader = raw.length >= 8 ? raw.subarray(0, 8) : raw;
  const magicOk = raw.length >= 4 && EVIDENCE_MAGIC.every((v, i) => raw[i] === v);
  const decodedLength = raw.length >= 8 ? raw.readUInt32BE(4) : -1;
  const crcRead = raw.length >= 4 ? raw.readUInt32BE(raw.length - 4) : 0;
  const crcCalc = raw.length >= 4 ? crc32(raw.subarray(0, raw.length - 4)) : 0;
  const crcOk = raw.length >= 4 && crcRead === crcCalc;
  const payload = raw.length >= 12 ? raw.slice(8, 8 + EVIDENCE_FRAME_LENGTH) : Buffer.alloc(0);
  const payloadMatch = payload.length === EVIDENCE_PAYLOAD.length &&
    payload.equals(Buffer.from(EVIDENCE_PAYLOAD));
  const byteErrors = payload.length === EVIDENCE_PAYLOAD.length
    ? countByteErrors(payload, Buffer.from(EVIDENCE_PAYLOAD))
    : null;
  const bitErrors = payload.length === EVIDENCE_PAYLOAD.length
    ? countBitErrors(payload, Buffer.from(EVIDENCE_PAYLOAD))
    : null;
  const lengthValid = decodedLength === EVIDENCE_FRAME_LENGTH;
  const passed = magicOk && lengthValid && crcOk && payloadMatch;

  const carriers = analyzeCarriers(preamble, samples, candidate.start, candidate.samplesPerSymbol, sampleRate, eq);
  const totalPower = carriers.reduce((a, c) => a + c.meanPower, 0);
  const totalNormalized = carriers.reduce((a, c) => a + c.normalizedMeanPower, 0);
  for (const c of carriers) {
    c.relativePower = totalPower > 0 ? c.meanPower / totalPower : 0;
    c.normalizedRelativePower = totalNormalized > 0 ? c.normalizedMeanPower / totalNormalized : 0;
  }

  const totalSymbols = EVIDENCE_PREAMBLE.length + EXPECTED_PACKET_SYMBOLS.length;
  // Measured timing: least-squares fit of detected symbol starts. Each
  // per-symbol detection re-centers inside its bounded window (no random
  // walk), so the fitted slope tracks the true symbol rate over all 112
  // symbols instead of inheriting grid quantization or cursor-walk noise.
  const fitX = [...preDecisions.map((d) => d.index), ...packetDecisions.map((d) => EVIDENCE_PREAMBLE.length + d.index)];
  const fitY = [...preDecisions.map((d) => d.start), ...packetDecisions.map((d) => d.start)];
  const measuredSps = fitSamplesPerSymbol(fitX, fitY, candidate.samplesPerSymbol);
  const driftPpm = (measuredSps / nominal - 1) * 1_000_000;
  return {
    burst: burstIndex,
    startSample: Math.round(candidate.start),
    endSample: Math.round(cursor),
    timing: {
      startSample: Math.round(candidate.start),
      startSeconds: candidate.start / sampleRate,
      nominalSamplesPerSymbol: nominal,
      estimatedSamplesPerSymbol: measuredSps,
      clockDriftPpm: driftPpm,
      accumulatedErrorSamples: (measuredSps - nominal) * totalSymbols,
      earlyLateError: analyzeTimingEarlyLate(samples, candidate.start, candidate.samplesPerSymbol, sampleRate, eq),
    },
    carriers,
    equalization: {
      applied: eq !== undefined,
      centersHz: [0, 1, 2, 3].map((s) => eqCenter(eq, s)),
      rxGains: [0, 1, 2, 3].map((s) => eqGain(eq, s)),
    },
    preamble,
    preambleMatches,
    packetSymbols,
    magicOk,
    decodedLength,
    rawHeaderHex: rawHeader.toString("hex"),
    receivedPayloadHex: payload.toString("hex"),
    byteErrors,
    bitErrors,
    crcExpected: hex(crcRead),
    crcCalculated: hex(crcCalc),
    crcOk,
    payloadMatch,
    passed,
  };
}

/**
 * Analyze parsed evidence samples. Pure function used by the CLI and tests.
 * Never modifies its input. Pass a calibration-derived equalization to apply
 * measured carrier offsets + RX normalization; omit it for the default
 * unequalized path. Verdict rules are identical either way.
 */
export function analyzeEvidenceSamples(
  samples: Float64Array,
  sampleRate: number,
  integrity: WavIntegrity,
  eq?: EvidenceEqualization,
  eqSource = "inline",
): EvidenceReport {
  const nominal = (sampleRate * EVIDENCE_SYMBOL_MS) / 1000;
  if (eq !== undefined) validateEqualization(eq, sampleRate);
  const eqSummary = eq !== undefined
    ? {
      applied: true as const,
      source: eqSource,
      kind: (eq.provenance?.kind ?? "undeclared") as "v1-legacy" | "v2-measured" | "undeclared",
      centersHz: [0, 1, 2, 3].map((s) => eqCenter(eq, s)),
      rxGains: [0, 1, 2, 3].map((s) => eqGain(eq, s)),
      ...(eq.provenance?.round1Sha256 ? { round1Sha256: eq.provenance.round1Sha256 } : {}),
      ...(eq.provenance?.round2Sha256 ? { round2Sha256: eq.provenance.round2Sha256 } : {}),
    }
    : null;
  const profile = {
    symbolMs: EVIDENCE_SYMBOL_MS,
    frequencies: [...EVIDENCE_FREQUENCIES],
    preambleLength: EVIDENCE_PREAMBLE.length,
    repetitions: EVIDENCE_REPETITIONS,
    gapMs: EVIDENCE_GAP_MS,
  };
  const empty = (verdict: EvidenceVerdict, reason: string, bursts: BurstReport[] = [], combined: CombinedReport | null = null): EvidenceReport => ({
    wav: integrity,
    profile,
    expectedPayloadHex: EVIDENCE_PAYLOAD_HEX,
    equalization: eqSummary,
    bursts,
    combined,
    verdict,
    verdictReason: reason,
  });
  if (!integrity.valid) return empty("VERIFIED FAIL", `Invalid WAV: ${integrity.error ?? "unknown"}`);
  if (samples.length < Math.ceil((EVIDENCE_PREAMBLE.length + EXPECTED_PACKET_SYMBOLS.length) * nominal)) {
    return empty("VERIFIED FAIL", "Recording too short for one evidence burst");
  }

  // Stage 1: matched carrier-energy scan over the known preamble head.
  const probeLength = Math.min(12, EVIDENCE_PREAMBLE.length);
  const step = Math.max(32, Math.round(nominal * 0.25));
  const maxStart = samples.length - Math.ceil((EVIDENCE_PREAMBLE.length + EXPECTED_PACKET_SYMBOLS.length) * nominal * 0.9);
  const hits: Array<{ start: number; matches: number; score: number }> = [];
  for (let off = 0; off <= Math.max(0, maxStart); off += step) {
    const s = scorePreambleCoarse(samples, off, nominal, sampleRate, probeLength, eq);
    if (s) hits.push({ start: off, matches: s.matches, score: s.matches * 10 + s.quality });
  }
  hits.sort((a, b) => b.score - a.score);

  // Stage 2: non-maximum suppression / minimum separation.
  const minSeparation = Math.round(sampleRate * 1.8);
  const seeds: typeof hits = [];
  for (const h of hits) {
    if (seeds.every((s) => Math.abs(s.start - h.start) >= minSeparation)) {
      seeds.push(h);
      if (seeds.length >= 6) break;
    }
  }
  seeds.sort((a, b) => a.start - b.start);

  // Stage 3: timing refinement per candidate (global timing + clock search).
  const refined: RefinedCandidate[] = [];
  for (const seed of seeds) {
    const r = refineSeed(samples, sampleRate, seed.start, eq);
    // Gate well above the noise ceiling (random audio scores ~8/32 here).
    if (r && r.preambleMatches >= 20) refined.push(r);
  }
  refined.sort((a, b) => b.preambleMatches - a.preambleMatches);
  const top = refined.slice(0, EVIDENCE_REPETITIONS).sort((a, b) => a.start - b.start);

  if (!top.length) {
    return empty("VERIFIED FAIL", "No matched-preamble candidate reached the refinement threshold; no VAML packet structure recovered");
  }

  const bursts: BurstReport[] = [];
  for (let i = 0; i < top.length; i++) {
    try {
      bursts.push(decodeBurst(samples, sampleRate, top[i], i + 1, eq));
    } catch {
      // A truncated candidate is evidence of absence, not a silent decode.
    }
  }
  if (!bursts.length) return empty("VERIFIED FAIL", "Matched candidates found but no burst produced a complete symbol stream");

  // Stage 4: soft-decision combining across independent bursts.
  let combined: CombinedReport | null = null;
  const usable = bursts.filter((b) => b.packetSymbols.length === EXPECTED_PACKET_SYMBOLS.length);
  if (usable.length >= 2) {
    const out: number[] = [];
    for (let i = 0; i < EXPECTED_PACKET_SYMBOLS.length; i++) {
      const weights = [0, 0, 0, 0];
      for (const b of usable) {
        const sym = b.packetSymbols[i].decoded;
        const w = Math.max(0.02, b.packetSymbols[i].confidence);
        if (sym >= 0 && sym < 4) weights[sym] += w;
      }
      let winner = 0;
      for (let s = 1; s < 4; s++) if (weights[s] > weights[winner]) winner = s;
      out.push(winner);
    }
    const raw = symbolsToBytes(out);
    const magicOk = raw.length >= 4 && EVIDENCE_MAGIC.every((v, i) => raw[i] === v);
    const length = raw.length >= 8 ? raw.readUInt32BE(4) : -1;
    const crcOk = raw.length >= 4 && raw.readUInt32BE(raw.length - 4) === crc32(raw.subarray(0, raw.length - 4));
    const payload = raw.length >= 12 ? raw.slice(8, 8 + EVIDENCE_FRAME_LENGTH) : Buffer.alloc(0);
    const payloadMatch = payload.length === EVIDENCE_PAYLOAD.length && payload.equals(Buffer.from(EVIDENCE_PAYLOAD));
    combined = {
      payloadHex: payload.toString("hex"),
      magicOk,
      length,
      crcOk,
      payloadMatch,
      passed: magicOk && length === EVIDENCE_FRAME_LENGTH && crcOk && payloadMatch,
    };
  }

  const singlePass = bursts.find((b) => b.passed);
  if (singlePass) {
    return {
      wav: integrity, profile, expectedPayloadHex: EVIDENCE_PAYLOAD_HEX, equalization: eqSummary, bursts, combined,
      verdict: "VERIFIED PASS",
      verdictReason: `Burst ${singlePass.burst} recovered VAC1 + length ${EVIDENCE_FRAME_LENGTH} + CRC PASS + byte-exact payload ${EVIDENCE_PAYLOAD_HEX}`,
    };
  }
  if (combined?.passed) {
    return {
      wav: integrity, profile, expectedPayloadHex: EVIDENCE_PAYLOAD_HEX, equalization: eqSummary, bursts, combined,
      verdict: "VERIFIED PASS",
      verdictReason: `Strict soft-combined packet recovered VAC1 + length ${EVIDENCE_FRAME_LENGTH} + CRC PASS + byte-exact payload ${EVIDENCE_PAYLOAD_HEX}`,
    };
  }
  const maxPreamble = Math.max(...bursts.map((b) => b.preambleMatches));
  const anyHeader = bursts.some((b) => b.magicOk);
  const anyLengthOk = bursts.some((b) => b.decodedLength === EVIDENCE_FRAME_LENGTH);
  if (anyHeader || anyLengthOk || maxPreamble >= 24 || (combined?.magicOk ?? false)) {
    const detail = bursts.map((b) => `burst${b.burst}:preamble ${b.preambleMatches}/${EVIDENCE_PREAMBLE.length},VAC1 ${b.magicOk ? "ok" : "bad"},len ${b.decodedLength},CRC ${b.crcOk ? "PASS" : "FAIL"}`).join("; ");
    return {
      wav: integrity, profile, expectedPayloadHex: EVIDENCE_PAYLOAD_HEX, equalization: eqSummary, bursts, combined,
      verdict: "VERIFIED PARTIAL",
      verdictReason: `Packet structure partially recovered (${detail}) but no burst or strict combination reached CRC PASS + byte-exact match`,
    };
  }
  return {
    wav: integrity, profile, expectedPayloadHex: EVIDENCE_PAYLOAD_HEX, equalization: eqSummary, bursts, combined,
    verdict: "VERIFIED FAIL",
    verdictReason: "No burst recovered VAML packet structure (preamble/magic/length all below evidence thresholds)",
  };
}

/** Convenience entry point: parse bytes then analyze. Never modifies input. */
export function analyzeEvidenceWav(wav: Uint8Array, eq?: EvidenceEqualization, eqSource = "inline"): EvidenceReport {
  const parsed = parseEvidenceWav(wav);
  if (!parsed.integrity.valid || !parsed.samples.length) {
    return {
      wav: parsed.integrity,
      profile: {
        symbolMs: EVIDENCE_SYMBOL_MS,
        frequencies: [...EVIDENCE_FREQUENCIES],
        preambleLength: EVIDENCE_PREAMBLE.length,
        repetitions: EVIDENCE_REPETITIONS,
        gapMs: EVIDENCE_GAP_MS,
      },
      expectedPayloadHex: EVIDENCE_PAYLOAD_HEX,
      equalization: eq !== undefined
        ? {
          applied: true as const,
          source: eqSource,
          kind: (eq.provenance?.kind ?? "undeclared") as "v1-legacy" | "v2-measured" | "undeclared",
          centersHz: [0, 1, 2, 3].map((s) => eqCenter(eq, s)),
          rxGains: [0, 1, 2, 3].map((s) => eqGain(eq, s)),
          ...(eq.provenance?.round1Sha256 ? { round1Sha256: eq.provenance.round1Sha256 } : {}),
          ...(eq.provenance?.round2Sha256 ? { round2Sha256: eq.provenance.round2Sha256 } : {}),
        }
        : null,
      bursts: [],
      combined: null,
      verdict: "VERIFIED FAIL",
      verdictReason: `Invalid WAV: ${parsed.integrity.error ?? "unknown"}`,
    };
  }
  return analyzeEvidenceSamples(parsed.samples, parsed.integrity.sampleRate, parsed.integrity, eq, eqSource);
}

export function formatEvidenceReport(report: EvidenceReport): string {
  const lines: string[] = [];
  const w = report.wav;
  lines.push("VAML Acoustic Evidence Analyzer (offline, two-computer probe)");
  lines.push(`SHA-256: ${w.sha256}`);
  lines.push(`WAV: ${w.valid ? `PCM ${w.channels}ch ${w.sampleRate} Hz ${w.bitsPerSample}-bit` : `INVALID (${w.error ?? "unknown"})`}`);
  lines.push(`Samples: ${w.sampleCount}  Duration: ${w.durationSeconds.toFixed(3)} s`);
  lines.push(`RMS: ${w.rms.toFixed(6)}  Peak: ${w.peak.toFixed(6)}  Clipping: ${(w.clippingRatio * 100).toFixed(3)}%`);
  lines.push(`Profile: ${report.profile.symbolMs} ms symbols, ${report.profile.frequencies.join("/")} Hz 4-FSK, ${report.profile.preambleLength}-symbol preamble, ${report.profile.repetitions} bursts`);
  lines.push(`Expected payload: ${report.expectedPayloadHex}`);
  if (report.equalization?.applied) {
    const e = report.equalization;
    const kindLabel = e.kind === "v2-measured"
      ? "v2 closed-loop (MEASURED ROUND 2)"
      : e.kind === "v1-legacy"
        ? "v1 LEGACY DIAGNOSTIC (not the formal path)"
        : "undeclared provenance";
    lines.push(`Equalization: source ${e.source} [${kindLabel}]`);
    lines.push(`  Centers: ${e.centersHz.map((f) => `${f.toFixed(0)} Hz`).join(" / ")}`);
    lines.push(`  RX gains: ${e.rxGains.map((g) => g.toFixed(3)).join(" / ")}`);
    if (e.round1Sha256) lines.push(`  Round1 SHA256: ${e.round1Sha256}`);
    if (e.round2Sha256) lines.push(`  Round2 SHA256: ${e.round2Sha256}`);
  }
  lines.push(`Bursts detected: ${report.bursts.length}`);
  lines.push("");
  for (const b of report.bursts) {
    lines.push(`Burst ${b.burst}: @${b.timing.startSeconds.toFixed(3)}s (sample ${b.startSample})`);
    lines.push(`  Preamble ${b.preambleMatches}/${EVIDENCE_PREAMBLE.length}`);
    lines.push(`  VAC1 ${b.magicOk ? "PASS" : "FAIL"}  Length ${b.decodedLength}`);
    lines.push(`  Payload ${b.receivedPayloadHex || "(none)"}`);
    lines.push(`  Byte errors ${b.byteErrors ?? "n/a"}  Bit errors ${b.bitErrors ?? "n/a"}`);
    lines.push(`  CRC expected ${b.crcExpected} calculated ${b.crcCalculated} ${b.crcOk ? "PASS" : "FAIL"}`);
    lines.push(`  Timing sps ${b.timing.estimatedSamplesPerSymbol.toFixed(2)} (nominal ${b.timing.nominalSamplesPerSymbol.toFixed(2)}) drift ${b.timing.clockDriftPpm.toFixed(0)} ppm accum ${b.timing.accumulatedErrorSamples.toFixed(1)} samples early/late ${b.timing.earlyLateError.toFixed(4)}`);
    for (const c of b.carriers) {
      const snr = Number.isFinite(c.snrDb) ? `${c.snrDb.toFixed(1)} dB` : "-inf";
      lines.push(`  Carrier ${c.frequency} Hz: rel ${(c.relativePower * 100).toFixed(1)}% offset ${c.frequencyOffsetHz >= 0 ? "+" : ""}${c.frequencyOffsetHz} Hz SNR ${snr} margin ${(c.margin * 100).toFixed(1)}%`);
      if (b.equalization.applied) {
        lines.push(`    norm rel ${(c.normalizedRelativePower * 100).toFixed(1)}% (center ${c.appliedCenterHz.toFixed(0)} Hz, raw preserved above)`);
      }
    }
    lines.push(`  Burst verdict: ${b.passed ? "PASS (CRC + exact match)" : "not passed"}`);
  }
  if (report.combined) {
    const c = report.combined;
    lines.push("");
    lines.push(`Combined: VAC1 ${c.magicOk ? "PASS" : "FAIL"} Length ${c.length} Payload ${c.payloadHex} CRC ${c.crcOk ? "PASS" : "FAIL"} Match ${c.payloadMatch ? "YES" : "NO"}`);
  }
  lines.push("");
  lines.push(report.verdict);
  lines.push(report.verdictReason);
  lines.push("Note: CRC32 is transport corruption detection, not cryptographic authentication.");
  return lines.join("\n");
}
