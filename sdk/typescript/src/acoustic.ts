import { createHash } from "node:crypto";

const MAGIC = Buffer.from("VAC1");
const WAV_RIFF = Buffer.from("RIFF");
const WAV_WAVE = Buffer.from("WAVE");
const WAV_FMT = Buffer.from("fmt ");
const WAV_DATA = Buffer.from("data");

export interface AcousticProfile {
  sampleRate: number;
  symbolMs: number;
  frequencies: readonly [number, number, number, number];
  amplitude: number;
  preamble: readonly number[];
}

export const AUDIBLE_4FSK_PROFILE: AcousticProfile = Object.freeze({
  sampleRate: 48_000,
  symbolMs: 10,
  frequencies: [1_200, 1_800, 2_400, 3_000] as const,
  amplitude: 0.55,
  preamble: Object.freeze([0, 3, 1, 2, 0, 3, 1, 2, 3, 0, 2, 1, 3, 0, 2, 1]),
});

export interface AcousticEncodeOptions {
  profile?: AcousticProfile;
  leadingSilenceMs?: number;
  trailingSilenceMs?: number;
}

export interface AcousticDecodeOptions {
  profile?: AcousticProfile;
  maxFrameBytes?: number;
}

/**
 * Encode one already-encrypted VAML frame as a mono PCM16 WAV sound.
 *
 * This is transport modulation only. Frequencies never represent words or
 * concepts. The payload is the existing encrypted/authenticated VAML frame.
 */
export function encodeVamlFrameToWav(
  frame: Uint8Array,
  options: AcousticEncodeOptions = {},
): Buffer {
  const profile = validateProfile(options.profile ?? AUDIBLE_4FSK_PROFILE);
  const payload = Buffer.from(frame);
  if (!payload.length || payload.length > 1_048_576) throw new Error("Acoustic frame size limit");

  const packet = Buffer.alloc(4 + 4 + payload.length + 4);
  MAGIC.copy(packet, 0);
  packet.writeUInt32BE(payload.length, 4);
  payload.copy(packet, 8);
  packet.writeUInt32BE(crc32(packet.subarray(0, 8 + payload.length)), 8 + payload.length);

  const symbols = [
    ...profile.preamble,
    ...bytesToSymbols(packet),
  ];
  const symbolSamples = Math.round(profile.sampleRate * profile.symbolMs / 1000);
  const leadingSamples = Math.round(profile.sampleRate * (options.leadingSilenceMs ?? 30) / 1000);
  const trailingSamples = Math.round(profile.sampleRate * (options.trailingSilenceMs ?? 30) / 1000);
  if (symbolSamples < 32) throw new Error("Acoustic symbol too short");
  if (leadingSamples < 0 || trailingSamples < 0) throw new Error("Invalid acoustic silence");

  const pcm = new Int16Array(leadingSamples + symbols.length * symbolSamples + trailingSamples);
  let cursor = leadingSamples;
  let phase = 0;
  const rampSamples = Math.max(1, Math.min(Math.floor(symbolSamples / 8), 48));

  for (const symbol of symbols) {
    const frequency = profile.frequencies[symbol];
    const step = 2 * Math.PI * frequency / profile.sampleRate;
    for (let i = 0; i < symbolSamples; i++) {
      const edge = Math.min(1, i / rampSamples, (symbolSamples - 1 - i) / rampSamples);
      const sample = Math.sin(phase) * profile.amplitude * Math.max(0, edge);
      pcm[cursor++] = Math.round(sample * 32767);
      phase += step;
      if (phase > Math.PI * 2) phase -= Math.PI * 2;
    }
  }

  return pcm16ToWav(pcm, profile.sampleRate);
}

/**
 * Decode an audible VAML WAV produced by encodeVamlFrameToWav().
 *
 * The reference decoder tolerates leading silence and small amplitude changes.
 * Real microphone deployments should add AGC/noise filtering around this codec.
 */
export function decodeVamlFrameFromWav(
  wav: Uint8Array,
  options: AcousticDecodeOptions = {},
): Buffer {
  const profile = validateProfile(options.profile ?? AUDIBLE_4FSK_PROFILE);
  const maxFrameBytes = options.maxFrameBytes ?? 1_048_576;
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > 16_777_216) {
    throw new Error("Invalid acoustic max frame size");
  }
  const { samples, sampleRate } = wavToPcm16(Buffer.from(wav));
  if (sampleRate !== profile.sampleRate) throw new Error("Unexpected acoustic sample rate");
  const symbolSamples = Math.round(profile.sampleRate * profile.symbolMs / 1000);

  const candidates = findPreambleCandidates(samples, profile, symbolSamples);
  if (candidates.length === 0) throw new Error("Acoustic preamble not found");
  let lastError: Error | undefined;
  for (const start of candidates) {
    try {
      return decodeAtPreamble(samples, start, profile, symbolSamples, maxFrameBytes);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("Acoustic preamble not found");
}

function decodeAtPreamble(
  samples: Int16Array,
  start: number,
  profile: AcousticProfile,
  symbolSamples: number,
  maxFrameBytes: number,
): Buffer {
  let cursor = start + profile.preamble.length * symbolSamples;

  const headerSymbols = 8 * 4; // 8 bytes, four 2-bit symbols per byte
  if (cursor + headerSymbols * symbolSamples > samples.length) throw new Error("Truncated acoustic header");
  const header = decodeSymbolsToBytes(samples, cursor, headerSymbols, profile, symbolSamples);
  cursor += headerSymbols * symbolSamples;
  if (!header.subarray(0, 4).equals(MAGIC)) throw new Error("Invalid acoustic packet magic");
  const frameLength = header.readUInt32BE(4);
  if (frameLength < 1 || frameLength > maxFrameBytes) throw new Error("Acoustic frame size limit");

  const remainingBytes = frameLength + 4;
  const remainingSymbols = remainingBytes * 4;
  if (cursor + remainingSymbols * symbolSamples > samples.length) throw new Error("Truncated acoustic payload");
  const body = decodeSymbolsToBytes(samples, cursor, remainingSymbols, profile, symbolSamples);
  const packet = Buffer.concat([header, body]);
  const expected = packet.readUInt32BE(packet.length - 4);
  const actual = crc32(packet.subarray(0, packet.length - 4));
  if (expected !== actual) throw new Error("Acoustic CRC mismatch");
  return Buffer.from(packet.subarray(8, 8 + frameLength));
}

export function acousticFingerprint(wav: Uint8Array): string {
  return createHash("sha256").update(wav).digest("hex");
}

function validateProfile(profile: AcousticProfile): AcousticProfile {
  if (!Number.isInteger(profile.sampleRate) || profile.sampleRate < 8_000 || profile.sampleRate > 192_000) {
    throw new Error("Invalid acoustic sample rate");
  }
  if (!Number.isFinite(profile.symbolMs) || profile.symbolMs < 2 || profile.symbolMs > 1000) {
    throw new Error("Invalid acoustic symbol duration");
  }
  if (!Number.isFinite(profile.amplitude) || profile.amplitude <= 0 || profile.amplitude > 1) {
    throw new Error("Invalid acoustic amplitude");
  }
  if (profile.frequencies.length !== 4) throw new Error("4-FSK requires four frequencies");
  const nyquist = profile.sampleRate / 2;
  for (const frequency of profile.frequencies) {
    if (!Number.isFinite(frequency) || frequency < 100 || frequency >= nyquist - 100) {
      throw new Error("Invalid acoustic frequency");
    }
  }
  if (!profile.preamble.length || profile.preamble.some((symbol) => !Number.isInteger(symbol) || symbol < 0 || symbol > 3)) {
    throw new Error("Invalid acoustic preamble");
  }
  return profile;
}

function bytesToSymbols(data: Uint8Array): number[] {
  const symbols: number[] = [];
  for (const byte of data) {
    symbols.push((byte >>> 6) & 3, (byte >>> 4) & 3, (byte >>> 2) & 3, byte & 3);
  }
  return symbols;
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

function countPreambleMatches(
  samples: Int16Array,
  offset: number,
  profile: AcousticProfile,
  symbolSamples: number,
): number {
  let matches = 0;
  for (let i = 0; i < profile.preamble.length; i++) {
    const symbol = detectSymbol(samples, offset + i * symbolSamples, profile, symbolSamples);
    if (symbol === profile.preamble[i]) matches++;
    else if (i < 4) break;
  }
  return matches;
}

/**
 * Collect preamble candidate offsets.
 *
 * Tone windows are phase-invariant: an offset up to a few ramps away from the
 * true start also scores a full preamble match (its windows are tail+head mixes
 * of the true symbols that still decide correctly). Locking the first such
 * offset misaligns the symbol grid, so candidates are returned as a list and
 * the caller trial-decodes each until the CRC authenticates a packet.
 */
function findPreambleCandidates(
  samples: Int16Array,
  profile: AcousticProfile,
  symbolSamples: number,
  limit = 12,
): number[] {
  const maxLeading = Math.min(samples.length - profile.preamble.length * symbolSamples, profile.sampleRate * 2);
  if (maxLeading < 0) return [];
  const stride = Math.max(1, Math.floor(symbolSamples / 8));
  const partialThreshold = Math.floor(profile.preamble.length * 0.9);
  const candidates: number[] = [];
  let bestPartial = -1;
  let bestPartialMatches = -1;
  for (let offset = 0; offset <= maxLeading; offset += stride) {
    const matches = countPreambleMatches(samples, offset, profile, symbolSamples);
    if (matches === profile.preamble.length) {
      let next = offset;
      while (next <= maxLeading && candidates.length < limit) {
        if (countPreambleMatches(samples, next, profile, symbolSamples) < profile.preamble.length) break;
        candidates.push(next);
        next += stride;
      }
      // The encrypted payload cannot re-host the preamble, so the first
      // full-match run is the only run that matters; stop scanning.
      return candidates;
    }
    if (matches >= partialThreshold && matches > bestPartialMatches) {
      bestPartialMatches = matches;
      bestPartial = offset;
    }
  }
  return bestPartial >= 0 ? [bestPartial] : [];
}

function decodeSymbolsToBytes(
  samples: Int16Array,
  start: number,
  symbolCount: number,
  profile: AcousticProfile,
  symbolSamples: number,
): Buffer {
  const symbols = new Array<number>(symbolCount);
  for (let i = 0; i < symbolCount; i++) {
    symbols[i] = detectSymbol(samples, start + i * symbolSamples, profile, symbolSamples);
  }
  return symbolsToBytes(symbols);
}

function detectSymbol(
  samples: Int16Array,
  start: number,
  profile: AcousticProfile,
  symbolSamples: number,
): number {
  if (start < 0 || start + symbolSamples > samples.length) throw new Error("Truncated acoustic symbol");
  let best = 0;
  let bestPower = -Infinity;
  for (let symbol = 0; symbol < 4; symbol++) {
    const power = goertzelPower(samples, start, symbolSamples, profile.frequencies[symbol], profile.sampleRate);
    if (power > bestPower) {
      bestPower = power;
      best = symbol;
    }
  }
  return best;
}

function goertzelPower(
  samples: Int16Array,
  start: number,
  count: number,
  frequency: number,
  sampleRate: number,
): number {
  const omega = 2 * Math.PI * frequency / sampleRate;
  const coefficient = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < count; i++) {
    const x = samples[start + i] / 32768;
    s0 = x + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coefficient * s1 * s2;
}

function pcm16ToWav(samples: Int16Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  WAV_RIFF.copy(wav, 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  WAV_WAVE.copy(wav, 8);
  WAV_FMT.copy(wav, 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  WAV_DATA.copy(wav, 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) wav.writeInt16LE(samples[i], 44 + i * 2);
  return wav;
}

function wavToPcm16(wav: Buffer): { samples: Int16Array; sampleRate: number } {
  if (wav.length < 44 || !wav.subarray(0, 4).equals(WAV_RIFF) || !wav.subarray(8, 12).equals(WAV_WAVE)) {
    throw new Error("Invalid WAV container");
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let format = 0;
  let data: Buffer | undefined;
  while (offset + 8 <= wav.length) {
    const id = wav.subarray(offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + size > wav.length) throw new Error("Truncated WAV chunk");
    if (id.equals(WAV_FMT)) {
      if (size < 16) throw new Error("Invalid WAV fmt chunk");
      format = wav.readUInt16LE(offset);
      channels = wav.readUInt16LE(offset + 2);
      sampleRate = wav.readUInt32LE(offset + 4);
      bits = wav.readUInt16LE(offset + 14);
    } else if (id.equals(WAV_DATA)) {
      data = wav.subarray(offset, offset + size);
    }
    offset += size + (size & 1);
  }
  if (format !== 1 || channels !== 1 || bits !== 16 || !data || !sampleRate) {
    throw new Error("Expected mono PCM16 WAV");
  }
  if (data.length % 2) throw new Error("Invalid WAV PCM length");
  const samples = new Int16Array(data.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);
  return { samples, sampleRate };
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
