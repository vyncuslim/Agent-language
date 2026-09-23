import { promises as fs } from "node:fs";
import {
  encodeSymbolCalibration,
  measureSymbolRound,
  deriveTxAmplitudes,
  loadChannelCalibrationV2,
} from "../src/acoustic-calibration.js";

function makeElement(): Record<string, unknown> {
  return new Proxy(
    { files: null },
    {
      get(t, p: string | symbol) {
        if (p === "addEventListener") return () => undefined;
        if (p === "files") return null;
        if (p === "className" || p === "textContent" || p === "hidden" || p === "disabled" || p === "href" || p === "download") return "";
        return (...args: unknown[]) => undefined;
      },
      set() { return true; },
    },
  );
}
const sandboxDocument = { getElementById: () => makeElement() };

async function main() {
  const html = await fs.readFile(new URL("../../tools/two-computer-acoustic-evidence.html", import.meta.url), "utf8");
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error("no script");
  let src = m[1];
  // Cut UI wiring tail; export DSP hooks instead.
  const cutAt = src.indexOf('armR1Btn.addEventListener');
  if (cutAt < 0) throw new Error("tail not found");
  src = src.slice(0, cutAt) + `
globalThis.__page = { encodeSymbols, encodeCalRound, calSequence, findCalOnset, decodeCalSymbols, measureRound, deriveTx, assembleV2, goertzel };
})();
`;
  const document = sandboxDocument;
  const window = {};
  const navigator = {};
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const run = new Function("document", "window", "navigator", "globalThis", src as string) as (
    ...args: unknown[]
  ) => void;
  run(document, window, navigator, globalThis);
  const page = (globalThis as Record<string, unknown>).__page as Record<string, (...args: never[]) => never> & {
    encodeSymbols: (symbols: number[], sr: number, amps: [number, number, number, number], leadMs: number, tailMs: number) => { pcm: Float32Array; lead: number };
    measureRound: (x: Float32Array, sr: number, symbols: number[], label: string) => {
      diagonal: number[];
      gains: number[];
    };
    deriveTx: (gains: number[]) => { tx: number[] };
  };

  const SR = 48000;
  const ROUNDS = 16;
  // 1. Encoder equivalence (float32 vs float64 tolerance).
  const seq = [];
  for (let r = 0; r < ROUNDS; r++) for (let c = 0; c < 4; c++) seq.push(c);
  const mod = encodeSymbolCalibration(SR, [0.72, 0.72, 0.72, 0.72], ROUNDS);
  // page encodeCalRound uses fixed V2.rounds=40; emulate by direct encodeSymbols call
  const pg = page.encodeSymbols(seq, SR, [0.72, 0.72, 0.72, 0.72], 250, 250);
  let maxDiff = 0;
  for (let i = 0; i < mod.samples.length; i++) maxDiff = Math.max(maxDiff, Math.abs(mod.samples[i] - pg.pcm[i]));
  console.log(`encoder maxDiff=${maxDiff.toExponential(2)} (lengths ${mod.samples.length} vs ${pg.pcm.length})`);
  if (!(maxDiff < 1e-6) || mod.samples.length !== pg.pcm.length) throw new Error("encoder mismatch");

  // 2. Measurement equivalence on a hum-room round.
  function mulberry(seed: number): () => number {
    let a = seed >>> 0;
    return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const g = [1.1, 0.6, 1.8, 0.22];
  const SPS = Math.round((SR * 26) / 1000);
  const LEAD = Math.round(SR * 0.25);
  const content = Float64Array.from(mod.samples);
  for (let i = 0; i < seq.length; i++) { const at = LEAD + i * SPS; for (let k = 0; k < SPS; k++) content[at + k] *= g[seq[i]]; }
  const rng = mulberry(4242);
  for (let i = 0; i < content.length; i++) content[i] += (rng() * 2 - 1) * 0.02;
  for (let i = 0; i < content.length; i++) content[i] += Math.sin((2 * Math.PI * 800 * i) / SR) * 0.2;
  const pre = new Float64Array(Math.round(SR * 0.3));
  const file = new Float64Array(pre.length + content.length + pre.length);
  file.set(pre, 0); file.set(content, pre.length); file.set(pre, pre.length + content.length);
  const pageFloat = new Float32Array(file);
  const modM = measureSymbolRound(file, SR, seq);
  const pageM = page.measureRound(pageFloat, SR, seq, "round1");
  console.log("module diag:", modM.diagonal.map((d) => d.toFixed(3)).join(","));
  console.log("page   diag:", pageM.diagonal.map((d) => d.toFixed(3)).join(","));
  console.log("module gains:", modM.symbolGains.map((x) => x.toFixed(3)).join(","));
  console.log("page   gains:", pageM.gains.map((x) => x.toFixed(3)).join(","));
  for (let s = 0; s < 4; s++) {
    if (Math.abs(modM.diagonal[s] - pageM.diagonal[s]) > 1e-9) throw new Error(`diagonal ${s} mismatch`);
    const rel = Math.abs(modM.symbolGains[s] - pageM.gains[s]) / modM.symbolGains[s];
    // Float32 capture (page) vs Float64 (module) Goertzel accumulation noise.
    if (!(rel < 0.05)) throw new Error(`gain ${s} mismatch: ${rel}`);
  }
  const modTx = deriveTxAmplitudes(modM.symbolGains, 0.72);
  const pageTx = page.deriveTx(pageM.gains);
  console.log("module tx:", modTx.txAmplitudes.map((a) => a.toFixed(4)).join(","));
  console.log("page   tx:", pageTx.tx.map((a) => a.toFixed(4)).join(","));
  for (let s = 0; s < 4; s++) {
    if (Math.abs(modTx.txAmplitudes[s] - pageTx.tx[s]) > 0.02) throw new Error(`tx ${s} mismatch`);
  }
  // 3. Page v2-shaped output loads in the strict loader (shape probe).
  console.log("page/measure equivalence OK");
  await main2();
}

async function main2(): Promise<void> {
  const page = (globalThis as Record<string, unknown>).__page as {
    encodeSymbols: (symbols: number[], sr: number, amps: number[], leadMs: number, tailMs: number) => { pcm: Float32Array; lead: number };
    measureRound: (x: Float32Array, sr: number, symbols: number[], label: string) => Record<string, never> & {
      gains: number[];
      quality: { status: string; blockSend: boolean };
    };
    deriveTx: (gains: number[]) => { tx: number[]; scale: number; clamped: boolean[] };
    assembleV2: (
      r1m: unknown,
      r1sha: string,
      r1tx: number[],
      r1scale: number,
      r1clamped: boolean[],
      m2: unknown,
      sha2: string,
      sr: number,
    ) => unknown;
  };
  const SR = 48000;
  const ROUNDS = 40;
  const seq: number[] = [];
  for (let r = 0; r < ROUNDS; r++) for (let c = 0; c < 4; c++) seq.push(c);
  const SPS = Math.round((SR * 26) / 1000);
  const LEAD = Math.round(SR * 0.25);
  const synth = (amps: number[]): Float32Array => {
    const { pcm } = page.encodeSymbols(seq, SR, amps, 250, 250);
    const pre = new Float64Array(Math.round(SR * 0.3));
    const file = new Float64Array(pre.length + pcm.length + pre.length);
    file.set(pre, 0); file.set(pcm, pre.length); file.set(pre, pre.length + pcm.length);
    return new Float32Array(file);
  };
  const r1 = page.measureRound(synth([0.72, 0.72, 0.72, 0.72]), SR, seq, "round1");
  const tx = page.deriveTx(r1.gains);
  const r2 = page.measureRound(synth(tx.tx), SR, seq, "round2");
  const sha1 = "a".repeat(64);
  const sha2 = "b".repeat(64);
  const v2 = page.assembleV2(r1, sha1, tx.tx, tx.scale, tx.clamped, r2, sha2, SR);
  const loaded = loadChannelCalibrationV2(JSON.stringify(v2));
  if (loaded.round1Sha256 !== sha1 || loaded.round2Sha256 !== sha2) throw new Error("SHA mismatch");
  if (loaded.rounds !== ROUNDS) throw new Error("rounds mismatch");
  console.log("page v2 JSON loads through strict loader OK");
}
main().catch((e) => { console.error("PAGE XCHECK FAILED:", e instanceof Error ? e.message : e); process.exitCode = 1; });
