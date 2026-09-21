import { createReadStream, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import {
  WorldSemanticCorpusAssembler,
  makePack,
  sha256,
  unb64,
  canonicalJson,
  type ConceptSourceRecord,
  type CorpusRow,
  type CorpusSourceDescriptor,
} from "../src/index.js";

interface SourceManifestFile {
  format: "vaml-corpus-sources";
  version: "0.1";
  sources: CorpusSourceDescriptor[];
}

interface ShardEntry {
  shard: number;
  file: string;
  packId: string;
  concepts: number;
}

function usage(): never {
  throw new Error(
    "Usage: tsx tools/build-world-semantic-corpus.ts <private-sources.json> <private-corpus.sorted.jsonl> <output-prefix> [chunk-size]",
  );
}

async function main(): Promise<void> {
  const [, , sourceManifestPath, corpusPath, outputPrefix, chunkArg] = process.argv;
  if (!sourceManifestPath || !corpusPath || !outputPrefix) usage();

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

  const sourceManifest = JSON.parse(await fs.readFile(sourceManifestPath, "utf8")) as SourceManifestFile;
  if (sourceManifest.format !== "vaml-corpus-sources" || sourceManifest.version !== "0.1") {
    throw new Error("Invalid VAML corpus source manifest");
  }
  if (!Array.isArray(sourceManifest.sources) || sourceManifest.sources.length === 0) {
    throw new Error("Corpus source manifest must contain at least one source");
  }

  const sourcePolicyDigest = Buffer.from(
    sha256(canonicalJson(sourceManifest)),
  ).toString("base64url");
  const assembler = new WorldSemanticCorpusAssembler(sourceManifest.sources);

  await fs.mkdir(dirname(resolve(outputPrefix)), { recursive: true });
  const reader = createInterface({
    input: createReadStream(corpusPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let shard = 0;
  let records: ConceptSourceRecord[] = [];
  let writtenConcepts = 0;
  const shards: ShardEntry[] = [];

  async function flush(): Promise<void> {
    if (records.length === 0) return;
    const pack = makePack(records, semanticKey, packKey);
    const file = `${outputPrefix}.${String(shard).padStart(5, "0")}.vocab.json`;
    await fs.writeFile(file, JSON.stringify(pack), { encoding: "utf8", mode: 0o600 });
    shards.push({ shard, file, packId: pack.packId, concepts: records.length });
    writtenConcepts += records.length;
    records = [];
    shard += 1;
  }

  function accept(record: ConceptSourceRecord | undefined): void {
    if (!record) return;
    records.push(record);
  }

  for await (const line of reader) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const row = JSON.parse(trimmed) as CorpusRow;
    if (row.kind !== "lexeme" && row.kind !== "agent-native") {
      throw new Error("Corpus row kind must be lexeme or agent-native");
    }
    accept(assembler.push(row));
    if (records.length >= chunkSize) await flush();
  }

  accept(assembler.finish());
  await flush();

  const stats = assembler.stats();
  if (stats.concepts !== writtenConcepts) {
    throw new Error(`Corpus accounting mismatch: assembled=${stats.concepts} written=${writtenConcepts}`);
  }

  const manifestPath = `${outputPrefix}.corpus.manifest.json`;
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        format: "vaml-world-semantic-corpus",
        version: "0.1",
        createdAt: new Date().toISOString(),
        protocol: "VAML-0.2",
        sourcePolicyDigest,
        stats,
        shards,
      },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  );

  console.log(`Built ${shards.length} encrypted corpus shard(s).`);
  console.log(`Concepts: ${stats.concepts}; rows: ${stats.sourceRows}; languages: ${stats.languages}.`);
  console.log(`Agent-native rows: ${stats.agentNativeRows}; lexical rows: ${stats.lexicalRows}.`);
  console.log(`Private manifest: ${manifestPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
