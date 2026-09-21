import { createReadStream, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { makePack, unb64, type ConceptSourceRecord } from "../src/index.js";

async function main(): Promise<void> {
  const [, , inputPath, outputPrefix, chunkArg] = process.argv;
  if (!inputPath || !outputPrefix) {
    throw new Error("Usage: tsx tools/build-private-lexicon.ts <private.jsonl> <output-prefix> [chunk-size]");
  }

  const semanticKeyRaw = process.env.VAML_SEMANTIC_KEY;
  const packKeyRaw = process.env.VAML_PACK_KEY;
  if (!semanticKeyRaw || !packKeyRaw) {
    throw new Error("VAML_SEMANTIC_KEY and VAML_PACK_KEY must be set as base64url 32-byte secrets");
  }
  const semanticKey = unb64(semanticKeyRaw);
  const packKey = unb64(packKeyRaw);
  if (semanticKey.length !== 32 || packKey.length !== 32) {
    throw new Error("VAML_SEMANTIC_KEY and VAML_PACK_KEY must each decode to 32 bytes");
  }

  const chunkSize = chunkArg ? Number.parseInt(chunkArg, 10) : 50_000;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error("Invalid chunk size");

  await fs.mkdir(dirname(resolve(outputPrefix)), { recursive: true });

  const reader = createInterface({
    input: createReadStream(inputPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let shard = 0;
  let total = 0;
  let records: ConceptSourceRecord[] = [];
  const manifest: Array<{ shard: number; file: string; packId: string; records: number }> = [];

  async function flush(): Promise<void> {
    if (records.length === 0) return;
    const pack = makePack(records, semanticKey, packKey);
    const file = `${outputPrefix}.${String(shard).padStart(5, "0")}.vocab.json`;
    await fs.writeFile(file, JSON.stringify(pack), { encoding: "utf8", mode: 0o600 });
    manifest.push({ shard, file, packId: pack.packId, records: records.length });
    total += records.length;
    records = [];
    shard += 1;
  }

  for await (const line of reader) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = JSON.parse(trimmed) as ConceptSourceRecord;
    if (!("semantic" in record)) throw new Error(`Missing semantic field near source record ${total + records.length + 1}`);
    records.push(record);
    if (records.length >= chunkSize) await flush();
  }
  await flush();

  const manifestPath = `${outputPrefix}.manifest.json`;
  await fs.writeFile(
    manifestPath,
    JSON.stringify({ format: "vaml-vocab-shards", version: "0.2", totalRecords: total, shards: manifest }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );

  console.log(`Built ${manifest.length} encrypted shard(s), ${total} source records total.`);
  console.log(`Manifest: ${manifestPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
