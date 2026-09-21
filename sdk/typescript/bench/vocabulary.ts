import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, cpus, platform, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  buildVocabulary,
  ShardedSemanticIndex,
  bucketOf,
} from "../src/vocabulary.js";
import { conceptId } from "../src/lexicon.js";
import {
  beginHandshake,
  defaultManifest,
  finishHandshake,
  verifyConfirmation,
} from "../src/negotiation.js";
import { VamlSessionRuntime } from "../src/runtime.js";
import { ValueType } from "../src/types.js";

const HOT_LOOKUP_SAMPLES = 10_000;
const ACTIVE_DERIVATION_SAMPLES = 128;
const FRAME_SAMPLES = 2_000;
const COLD_LOOKUP_SAMPLES = 64;

interface LatencyStats {
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) throw new Error("Cannot calculate an empty percentile");
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function latencyStats(samples: number[]): LatencyStats {
  if (samples.length === 0) throw new Error("Cannot calculate empty latency statistics");
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    mean: samples.reduce((total, value) => total + value, 0) / samples.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

async function measure(count: number) {
  const dir = await mkdtemp(join(tmpdir(), "vaml-bench-")),
    semanticKey = randomBytes(32),
    packKey = randomBytes(32);
  const active: string[] = [];
  let bucket: string | undefined;
  async function* records() {
    for (let i = 0; i < count; i++) {
      const record = {
        semantic: [i, (i % 997) / 997, (i % 577) / 577],
        embedding: [(i % 997) / 997, (i % 577) / 577],
        domains: ["01"],
      };
      const id = conceptId(semanticKey, record);
      bucket ??= bucketOf(id);
      if (active.length < 16 && bucketOf(id) === bucket) active.push(id);
      yield record;
    }
  }
  try {
    global.gc?.();
    const start = performance.now();
    const built = await buildVocabulary(records(), dir, semanticKey, packKey);
    const buildMs = performance.now() - start;
    global.gc?.();
    let t = performance.now();
    const index = new ShardedSemanticIndex(dir, packKey, built.catalogId, 1, 4);
    const catalogLoadMs = performance.now() - t;
    t = performance.now();
    const pa = beginHandshake("01", defaultManifest([built.catalogId])),
      pb = beginHandshake("02", defaultManifest([built.catalogId]));
    const a = finishHandshake(pa, pb.hello, index, packKey, "02"),
      b = finishHandshake(pb, pa.hello, index, packKey, "01");
    verifyConfirmation(a, b.confirmationTag);
    verifyConfirmation(b, a.confirmationTag);
    const handshakeMs = performance.now() - t,
      handshakeShards = index.loadedShards(),
      handshakeConcepts = a.conceptToCode.size;
    const coldLookupMsSamples: number[] = [];
    for (let i = 0; i < COLD_LOOKUP_SAMPLES; i++) {
      const coldIndex = new ShardedSemanticIndex(dir, packKey, built.catalogId, 1, 1);
      try {
        t = performance.now();
        coldIndex.semantic(active[0]);
        coldLookupMsSamples.push(performance.now() - t);
      } finally {
        coldIndex.close();
      }
    }
    const hotLookupUsSamples: number[] = [];
    index.semantic(active[0]);
    for (let i = 0; i < HOT_LOOKUP_SAMPLES; i++) {
      t = performance.now();
      index.semantic(active[i % active.length]);
      hotLookupUsSamples.push((performance.now() - t) * 1000);
    }
    const activeCodebookDerivationMsSamples: number[] = [];
    for (let i = 0; i < ACTIVE_DERIVATION_SAMPLES; i++) {
      const sampleA = beginHandshake("01", defaultManifest([built.catalogId]));
      const sampleB = beginHandshake("02", defaultManifest([built.catalogId]));
      const aSession = finishHandshake(sampleA, sampleB.hello, index, packKey, "02");
      const bSession = finishHandshake(sampleB, sampleA.hello, index, packKey, "01");
      verifyConfirmation(aSession, bSession.confirmationTag);
      verifyConfirmation(bSession, aSession.confirmationTag);
      t = performance.now();
      aSession.activate(active);
      activeCodebookDerivationMsSamples.push(performance.now() - t);
      t = performance.now();
      bSession.activate(active);
      activeCodebookDerivationMsSamples.push(performance.now() - t);
      for (const key of Object.values(aSession.context.keys)) key.fill(0);
      for (const key of Object.values(bSession.context.keys)) key.fill(0);
    }
    a.activate(active);
    b.activate(active);
    const ar = new VamlSessionRuntime(
        a.context,
        a.conceptToCode,
        a.codeToConcept,
      ),
      br = new VamlSessionRuntime(b.context, b.conceptToCode, b.codeToConcept);
    const fields = [
      { conceptId: active[0], valueType: ValueType.U64, value: 42n },
    ];
    const encodeUsSamples: number[] = [];
    const decodeUsSamples: number[] = [];
    let frameBytes = 0;
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      t = performance.now();
      const frame = ar.encode(fields);
      encodeUsSamples.push((performance.now() - t) * 1000);
      frameBytes = frame.length;
      t = performance.now();
      br.decode(frame);
      decodeUsSamples.push((performance.now() - t) * 1000);
    }
    t = performance.now();
    index.verify();
    const allShardsDecryptLoadMs = performance.now() - t;
    const memory = process.memoryUsage();
    ar.close();
    br.close();
    index.close();
    return {
      concepts: count,
      uniqueConcepts: built.count,
      buildMs,
      packBytes: built.bytes,
      catalogLoadMs,
      allShardsDecryptLoadMs,
      coldLookupMs: latencyStats(coldLookupMsSamples),
      hotLookupUs: latencyStats(hotLookupUsSamples),
      handshakeMs,
      handshakeLoadedShards: handshakeShards,
      handshakeDerivedConcepts: handshakeConcepts,
      activeConcepts: active.length,
      activeCodebookDerivationMs: latencyStats(activeCodebookDerivationMsSamples),
      encodeUs: latencyStats(encodeUsSamples),
      decodeUs: latencyStats(decodeUsSamples),
      frameBytes,
      rssMiB: memory.rss / 1048576,
      heapUsedMiB: memory.heapUsed / 1048576,
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    };
  } finally {
    semanticKey.fill(0);
    packKey.fill(0);
    await rm(dir, { recursive: true, force: true });
  }
}
const sizeIndex = process.argv.indexOf("--size");
if (sizeIndex >= 0) {
  const size = Number(process.argv[sizeIndex + 1]);
  if (![10000, 100000, 1000000].includes(size))
    throw new Error("Supported sizes: 10000 100000 1000000");
  console.log(JSON.stringify(await measure(size)));
} else {
  const results = [];
  for (const size of [10000, 100000, 1000000]) {
    console.error("Benchmark " + size + " concepts");
    const child = spawnSync(
      process.execPath,
      ["--expose-gc", fileURLToPath(import.meta.url), "--size", String(size)],
      {
        encoding: "utf8",
        timeout: 900000,
        maxBuffer: 1048576,
        windowsHide: true,
      },
    );
    if (child.status !== 0)
      throw new Error(child.stderr || "Benchmark child failed");
    const result = JSON.parse(child.stdout);
    results.push(result);
    console.error(JSON.stringify(result));
  }
  console.log(
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        node: process.version,
        platform: platform(),
        cpu: cpus()[0]?.model,
        totalMemoryGiB: totalmem() / 1073741824,
        method:
          "Synthetic numeric concept records; isolated process per size; 16 active concepts from one shard; latency samples report mean and linearly interpolated p50/p95/p99; 64 logical cold shard lookups, 10,000 hot lookups, 256 per-side active derivations, and 2,000 sequential encode/decode operations; local disk includes encrypted staging",
        results,
      },
      null,
      2,
    ),
  );
}
