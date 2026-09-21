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
    t = performance.now();
    index.semantic(active[0]);
    const coldLookupMs = performance.now() - t;
    t = performance.now();
    for (let i = 0; i < 10000; i++) index.semantic(active[i % active.length]);
    const lookupUs = ((performance.now() - t) * 1000) / 10000;
    t = performance.now();
    a.activate(active);
    b.activate(active);
    const deriveMs = (performance.now() - t) / 2;
    const ar = new VamlSessionRuntime(
        a.context,
        a.conceptToCode,
        a.codeToConcept,
      ),
      br = new VamlSessionRuntime(b.context, b.conceptToCode, b.codeToConcept);
    const fields = [
      { conceptId: active[0], valueType: ValueType.U64, value: 42n },
    ];
    let encodeMs = 0,
      decodeMs = 0,
      frameBytes = 0;
    for (let i = 0; i < 2000; i++) {
      t = performance.now();
      const frame = ar.encode(fields);
      encodeMs += performance.now() - t;
      frameBytes = frame.length;
      t = performance.now();
      br.decode(frame);
      decodeMs += performance.now() - t;
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
      coldLookupMs,
      hotLookupUs: lookupUs,
      handshakeMs,
      handshakeLoadedShards: handshakeShards,
      handshakeDerivedConcepts: handshakeConcepts,
      activeConcepts: active.length,
      activeCodebookDerivationMs: deriveMs,
      encodeUs: (encodeMs * 1000) / 2000,
      decodeUs: (decodeMs * 1000) / 2000,
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
          "Synthetic numeric concept records; isolated process per size; 16 active concepts from one shard; mean latencies; 2000 sequential encode/decode operations; local disk includes encrypted staging",
        results,
      },
      null,
      2,
    ),
  );
}
