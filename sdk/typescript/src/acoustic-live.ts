import { AUDIBLE_4FSK_PROFILE, type AcousticProfile } from "./acoustic.js";

const MAGIC = Buffer.from("VAC1");
const DEFAULT_MAX_FRAME_BYTES = 1_048_576;

export interface AcousticClockRecoveryOptions {
  profile?: AcousticProfile;
  maxFrameBytes?: number;
  maxClockDriftPpm?: number;
  clockSearchStepPpm?: number;
  timingSearchSamples?: number;
  preambleSearchSeconds?: number;
}

export interface AcousticClockDiagnostics {
  preambleStartSample: number;
  nominalSamplesPerSymbol: number;
  estimatedSamplesPerSymbol: number;
  estimatedClockDriftPpm: number;
  preambleMatches: number;
  preambleSymbols: number;
}

export interface AcousticDecodedFrame {
  frame: Buffer;
  diagnostics: AcousticClockDiagnostics;
  consumedSamples: number;
}

type DecodeAttempt =
  | { status: "frame"; value: AcousticDecodedFrame }
  | { status: "need-more"; lock?: ClockLock }
  | { status: "no-preamble" };

interface ClockLock {
  start: number;
  samplesPerSymbol: number;
  matches: number;
}

interface SymbolDecision {
  symbol: number;
  start: number;
  quality: number;
}

export function decodeVamlFrameFromMicrophonePcm(
  pcm: Int16Array,
  options: AcousticClockRecoveryOptions = {},
): AcousticDecodedFrame {
  const attempt = tryDecodeAdaptive(pcm, options);
  if (attempt.status === "frame") return attempt.value;
  if (attempt.status === "no-preamble") throw new Error("Acoustic preamble not found");
  throw new Error("Truncated acoustic microphone frame");
}

export interface AcousticMicrophoneReceiverOptions extends AcousticClockRecoveryOptions {
  inputSampleRate?: number;
  maxBufferedSeconds?: number;
  onFrame?: (frame: AcousticDecodedFrame) => void;
}

export class AcousticMicrophoneReceiver {
  private readonly profile: AcousticProfile;
  private readonly options: AcousticClockRecoveryOptions;
  private readonly inputSampleRate: number;
  private readonly maxBufferedSamples: number;
  private readonly onFrame?: (frame: AcousticDecodedFrame) => void;
  private readonly resampler: StreamingLinearResampler;
  private buffer = new Int16Array(0);
  private lock: ClockLock | undefined;
  private newSamplesSinceScan = 0;

  constructor(options: AcousticMicrophoneReceiverOptions = {}) {
    this.profile = validateProfile(options.profile ?? AUDIBLE_4FSK_PROFILE);
    this.inputSampleRate = options.inputSampleRate ?? this.profile.sampleRate;
    if (!Number.isInteger(this.inputSampleRate) || this.inputSampleRate < 8_000 || this.inputSampleRate > 192_000) {
      throw new Error("Invalid microphone sample rate");
    }
    const maxBufferedSeconds = options.maxBufferedSeconds ?? 90;
    if (!Number.isFinite(maxBufferedSeconds) || maxBufferedSeconds < 2 || maxBufferedSeconds > 600) {
      throw new Error("Invalid acoustic microphone buffer limit");
    }
    this.maxBufferedSamples = Math.ceil(this.profile.sampleRate * maxBufferedSeconds);
    this.onFrame = options.onFrame;
    this.options = {
      profile: this.profile,
      maxFrameBytes: options.maxFrameBytes,
      maxClockDriftPpm: options.maxClockDriftPpm,
      clockSearchStepPpm: options.clockSearchStepPpm,
      timingSearchSamples: options.timingSearchSamples,
      preambleSearchSeconds: options.preambleSearchSeconds,
    };
    this.resampler = new StreamingLinearResampler(this.inputSampleRate, this.profile.sampleRate);
  }

  pushFloat32(samples: Float32Array): AcousticDecodedFrame[] {
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const value = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = Math.round(value * (value < 0 ? 32768 : 32767));
    }
    return this.pushPcm16(pcm);
  }

  pushPcm16(samples: Int16Array): AcousticDecodedFrame[] {
    if (!(samples instanceof Int16Array)) throw new Error("Expected PCM16 microphone samples");
    const normalized = this.resampler.push(samples);
    if (normalized.length) {
      this.buffer = concatInt16(this.buffer, normalized);
      this.newSamplesSinceScan += normalized.length;
    }
    return this.drain();
  }

  reset(): void {
    this.buffer = new Int16Array(0);
    this.lock = undefined;
    this.newSamplesSinceScan = 0;
    this.resampler.reset();
  }

  bufferedSamples(): number {
    return this.buffer.length;
  }

  private drain(): AcousticDecodedFrame[] {
    const decoded: AcousticDecodedFrame[] = [];
    const nominal = this.profile.sampleRate * this.profile.symbolMs / 1000;
    const minimumScanIncrement = Math.max(1, Math.round(nominal * 2));

    while (true) {
      if (!this.lock && this.newSamplesSinceScan < minimumScanIncrement) break;
      const attempt = tryDecodeAdaptive(this.buffer, this.options, this.lock);
      this.newSamplesSinceScan = 0;

      if (attempt.status === "frame") {
        decoded.push(attempt.value);
        this.onFrame?.(attempt.value);
        const consumed = Math.min(this.buffer.length, Math.max(1, attempt.value.consumedSamples));
        this.buffer = this.buffer.slice(consumed);
        this.lock = undefined;
        this.newSamplesSinceScan = this.buffer.length;
        continue;
      }
      if (attempt.status === "need-more") {
        this.lock = attempt.lock ?? this.lock;
        break;
      }

      this.lock = undefined;
      const keep = Math.ceil(this.profile.sampleRate * (this.options.preambleSearchSeconds ?? 2));
      if (this.buffer.length > Math.min(this.maxBufferedSamples, keep)) {
        this.buffer = this.buffer.slice(this.buffer.length - Math.min(this.maxBufferedSamples, keep));
      }
      break;
    }

    if (this.buffer.length > this.maxBufferedSamples) {
      this.buffer = this.buffer.slice(this.buffer.length - this.maxBufferedSamples);
      this.lock = undefined;
    }
    return decoded;
  }
}

function tryDecodeAdaptive(
  samples: Int16Array,
  options: AcousticClockRecoveryOptions,
  existingLock?: ClockLock,
): DecodeAttempt {
  const profile = validateProfile(options.profile ?? AUDIBLE_4FSK_PROFILE);
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > 16_777_216) {
    throw new Error("Invalid acoustic max frame size");
  }

  const nominal = profile.sampleRate * profile.symbolMs / 1000;
  const minimum = Math.ceil((profile.preamble.length + 32) * nominal);
  if (samples.length < minimum) return { status: "need-more" };

  const lock = existingLock ?? acquireClockLock(samples, profile, options);
  if (!lock) return { status: "no-preamble" };

  const timingSearch = options.timingSearchSamples ?? Math.max(3, Math.round(nominal * 0.02));
  if (!Number.isInteger(timingSearch) || timingSearch < 0 || timingSearch > Math.round(nominal * 0.2)) {
    throw new Error("Invalid acoustic timing search");
  }

  let cursor = lock.start + profile.preamble.length * lock.samplesPerSymbol;
  const headerResult = decodeAdaptiveSymbols(samples, cursor, 32, profile, lock.samplesPerSymbol, timingSearch);
  if (!headerResult) return { status: "need-more", lock };
  cursor = headerResult.cursor;
  const header = symbolsToBytes(headerResult.symbols);
  if (!header.subarray(0, 4).equals(MAGIC)) return { status: "no-preamble" };
  const frameLength = header.readUInt32BE(4);
  if (frameLength < 1 || frameLength > maxFrameBytes) throw new Error("Acoustic frame size limit");

  const remainingSymbols = (frameLength + 4) * 4;
  const bodyResult = decodeAdaptiveSymbols(samples, cursor, remainingSymbols, profile, lock.samplesPerSymbol, timingSearch);
  if (!bodyResult) return { status: "need-more", lock };
  cursor = bodyResult.cursor;
  const body = symbolsToBytes(bodyResult.symbols);
  const packet = Buffer.concat([header, body]);
  const expected = packet.readUInt32BE(packet.length - 4);
  const actual = crc32(packet.subarray(0, packet.length - 4));
  if (expected !== actual) throw new Error("Acoustic CRC mismatch after clock recovery");

  const totalSymbols = profile.preamble.length + 32 + remainingSymbols;
  const observedSamplesPerSymbol = (cursor - lock.start) / totalSymbols;
  const diagnostics: AcousticClockDiagnostics = {
    preambleStartSample: lock.start,
    nominalSamplesPerSymbol: nominal,
    estimatedSamplesPerSymbol: observedSamplesPerSymbol,
    estimatedClockDriftPpm: ((observedSamplesPerSymbol / nominal) - 1) * 1_000_000,
    preambleMatches: lock.matches,
    preambleSymbols: profile.preamble.length,
  };
  return {
    status: "frame",
    value: {
      frame: Buffer.from(packet.subarray(8, 8 + frameLength)),
      diagnostics,
      consumedSamples: Math.ceil(cursor),
    },
  };
}

function acquireClockLock(samples: Int16Array, profile: AcousticProfile, options: AcousticClockRecoveryOptions): ClockLock | undefined {
  const nominal = profile.sampleRate * profile.symbolMs / 1000;
  const maxDriftPpm = options.maxClockDriftPpm ?? 10_000;
  const stepPpm = options.clockSearchStepPpm ?? 250;
  if (!Number.isFinite(maxDriftPpm) || maxDriftPpm < 0 || maxDriftPpm > 50_000) throw new Error("Invalid acoustic clock drift limit");
  if (!Number.isFinite(stepPpm) || stepPpm <= 0 || stepPpm > Math.max(1, maxDriftPpm || 1)) throw new Error("Invalid acoustic clock search step");

  const searchSamples = Math.min(
    samples.length - Math.ceil(profile.preamble.length * nominal * (1 + maxDriftPpm / 1_000_000)),
    Math.ceil(profile.sampleRate * (options.preambleSearchSeconds ?? 2)),
  );
  if (searchSamples < 0) return undefined;
  const coarseStride = Math.max(1, Math.round(nominal / 16));
  let coarseStart = -1;
  let coarseMatches = -1;
  for (let offset = 0; offset <= searchSamples; offset += coarseStride) {
    let matches = 0;
    for (let i = 0; i < profile.preamble.length; i++) {
      const decision = decideSymbol(samples, offset + i * nominal, nominal, profile, 0);
      if (!decision) break;
      if (decision.symbol === profile.preamble[i]) matches++;
    }
    if (matches > coarseMatches) { coarseMatches = matches; coarseStart = offset; }
    if (matches === profile.preamble.length) break;
  }
  if (coarseStart < 0 || coarseMatches < Math.floor(profile.preamble.length * 0.7)) return undefined;

  let best: { lock: ClockLock; score: number } | undefined;
  const fineRadius = coarseStride;
  const fineStep = Math.max(1, Math.floor(coarseStride / 6));
  const steps = Math.max(1, Math.ceil(maxDriftPpm / stepPpm));

  for (let clockStep = -steps; clockStep <= steps; clockStep++) {
    const ppm = Math.max(-maxDriftPpm, Math.min(maxDriftPpm, clockStep * stepPpm));
    const samplesPerSymbol = nominal * (1 + ppm / 1_000_000);
    for (let offset = Math.max(0, coarseStart - fineRadius); offset <= coarseStart + fineRadius; offset += fineStep) {
      let matches = 0;
      let quality = 0;
      let valid = true;
      for (let i = 0; i < profile.preamble.length; i++) {
        const decision = decideSymbol(samples, offset + i * samplesPerSymbol, samplesPerSymbol, profile, 0);
        if (!decision) { valid = false; break; }
        if (decision.symbol === profile.preamble[i]) { matches++; quality += decision.quality; }
        else quality -= 0.5;
      }
      if (!valid) continue;
      const score = matches * 10 + quality;
      if (!best || score > best.score) best = { lock: { start: offset, samplesPerSymbol, matches }, score };
    }
  }
  if (!best || best.lock.matches < Math.floor(profile.preamble.length * 0.9)) return undefined;
  return best.lock;
}

function decodeAdaptiveSymbols(samples: Int16Array, initialCursor: number, count: number, profile: AcousticProfile, samplesPerSymbol: number, timingSearch: number): { symbols: number[]; cursor: number } | undefined {
  const symbols = new Array<number>(count);
  let cursor = initialCursor;
  for (let i = 0; i < count; i++) {
    const decision = decideSymbol(samples, cursor, samplesPerSymbol, profile, timingSearch);
    if (!decision) return undefined;
    symbols[i] = decision.symbol;
    cursor = decision.start + samplesPerSymbol;
  }
  return { symbols, cursor };
}

function decideSymbol(samples: Int16Array, predictedStart: number, samplesPerSymbol: number, profile: AcousticProfile, searchRadius: number): SymbolDecision | undefined {
  const guard = Math.max(1, Math.round(samplesPerSymbol * 0.1));
  const window = Math.max(32, Math.round(samplesPerSymbol) - guard * 2);
  let bestDecision: SymbolDecision | undefined;
  const base = Math.round(predictedStart);
  for (let timing = -searchRadius; timing <= searchRadius; timing++) {
    const start = base + timing;
    const analysisStart = start + guard;
    if (analysisStart < 0 || analysisStart + window > samples.length) continue;
    let bestSymbol = 0;
    let bestPower = -Infinity;
    let secondPower = -Infinity;
    for (let symbol = 0; symbol < 4; symbol++) {
      const power = goertzelPower(samples, analysisStart, window, profile.frequencies[symbol], profile.sampleRate);
      if (power > bestPower) { secondPower = bestPower; bestPower = power; bestSymbol = symbol; }
      else if (power > secondPower) secondPower = power;
    }
    const quality = bestPower > 0 ? Math.max(0, (bestPower - Math.max(0, secondPower)) / bestPower) : 0;
    if (!bestDecision || quality > bestDecision.quality) bestDecision = { symbol: bestSymbol, start, quality };
  }
  return bestDecision;
}

class StreamingLinearResampler {
  private tail = new Int16Array(0);
  private position = 0;
  private readonly step: number;
  constructor(readonly inputRate: number, readonly outputRate: number) { this.step = inputRate / outputRate; }
  push(input: Int16Array): Int16Array {
    if (!input.length) return new Int16Array(0);
    if (this.inputRate === this.outputRate && !this.tail.length) return input.slice();
    const source = concatInt16(this.tail, input);
    const output: number[] = [];
    let p = this.position;
    while (p + 1 < source.length) {
      const i = Math.floor(p);
      const frac = p - i;
      output.push(Math.round(source[i] * (1 - frac) + source[i + 1] * frac));
      p += this.step;
    }
    const consumed = Math.max(0, Math.floor(p) - 1);
    this.tail = source.slice(consumed);
    this.position = p - consumed;
    return Int16Array.from(output);
  }
  reset(): void { this.tail = new Int16Array(0); this.position = 0; }
}

function validateProfile(profile: AcousticProfile): AcousticProfile {
  if (!Number.isInteger(profile.sampleRate) || profile.sampleRate < 8_000 || profile.sampleRate > 192_000) throw new Error("Invalid acoustic sample rate");
  if (!Number.isFinite(profile.symbolMs) || profile.symbolMs < 2 || profile.symbolMs > 1000) throw new Error("Invalid acoustic symbol duration");
  if (!Number.isFinite(profile.amplitude) || profile.amplitude <= 0 || profile.amplitude > 1) throw new Error("Invalid acoustic amplitude");
  if (profile.frequencies.length !== 4) throw new Error("4-FSK requires four frequencies");
  if (!profile.preamble.length || profile.preamble.some((symbol) => !Number.isInteger(symbol) || symbol < 0 || symbol > 3)) throw new Error("Invalid acoustic preamble");
  return profile;
}

function concatInt16(a: Int16Array, b: Int16Array): Int16Array {
  if (!a.length) return b.slice();
  if (!b.length) return a.slice();
  const output = new Int16Array(a.length + b.length);
  output.set(a, 0); output.set(b, a.length); return output;
}

function symbolsToBytes(symbols: readonly number[]): Buffer {
  if (symbols.length % 4) throw new Error("Invalid acoustic symbol count");
  const output = Buffer.alloc(symbols.length / 4);
  for (let i = 0; i < output.length; i++) {
    const p = i * 4;
    output[i] = (symbols[p] << 6) | (symbols[p + 1] << 4) | (symbols[p + 2] << 2) | symbols[p + 3];
  }
  return output;
}

function goertzelPower(samples: Int16Array, start: number, count: number, frequency: number, sampleRate: number): number {
  const omega = 2 * Math.PI * frequency / sampleRate;
  const coefficient = 2 * Math.cos(omega);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < count; i++) {
    const x = samples[start + i] / 32768;
    s0 = x + coefficient * s1 - s2; s2 = s1; s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coefficient * s1 * s2;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
