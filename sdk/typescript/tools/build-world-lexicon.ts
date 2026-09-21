import { createReadStream, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { makePack, unb64, WorldConceptAssembler, type ConceptSourceRecord, type WorldLexemeInput } from "../src/index.js";

interface ShardManifestEntry {
  shard: number;
  file: string;
  packId: string;
  concepts: number;
}

async function main(): Promise<void> {
  const [, , inputPath, outputPrefix, chunkArg] = process.argv;
  if (!inputPath || !outputPrefix) {
    throw new Error(
      "Usage: tsx tools/build-world-lexicon.ts <sorted-private-world-lexicon.jsonl> <output-prefix> [concepts-per-shard]",
    );
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

  const conceptsPerShard = chunkArg ? Number.parseInt(chunkArg, 10) : 50_000;
  if (!Number.isInteger(conceptsPerShard) || conceptsPerShard < 1) {
    throw new Error("concepts-per-shard must be a positive integer");
  }

  await fs.mkdir(dirname(resolve(outputPrefix)), { recursive: true });

  const reader = createInterface({
    input: createReadStream(inputPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  const assembler = new WorldConceptAssembler();
  let shard = 0;
  let concepts: ConceptSourceRecord[] = [];
  let totalConcepts = 0;
  const shards: ShardManifestEntry[] = [];

  async function flush(): Promise<void> {
    if (concepts.length === 0) return;
    const pack = makePack(concepts, semanticKey, packKey);
    const file = `${outputPrefix}.${String(shard).padStart(5, "0")}.vocab.json`;
    await fs.writeFile(file, JSON.stringify(pack), { encoding: "utf8", mode: 0o600 });
    shards.push({ shard, file, packId: pack.packId, concepts: concepts.length });
    totalConcepts += concepts.length;
    concepts = [];
    shard += 1;
  }

  const accept = async (concept: ConceptSourceRecord | undefined): Promise<void> => {
    if (!concept) return;
    concepts.push(concept);
    if (concepts.length >= conceptsPerShard) await flush();
  };

  let lineNumber = 0;
  for await (const line of reader) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: WorldLexemeInput;
    try {
      row = JSON.parse(trimmed) as WorldLexemeInput;
    } catch (error) {
      throw new Error(`Invalid JSON at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!row.conceptKey || !row.language || !row.lexeme) {
      throw new Error(`Line ${lineNumber} must contain conceptKey, language, and lexeme`);
    }
    await accept(assembler.push(row));
  }

  await accept(assembler.finish());
  await flush();

  const stats = assembler.stats();
  if (stats.concepts !== totalConcepts) {
    throw new Error(`Internal concept count mismatch: assembler=${stats.concepts} emitted=${totalConcepts}`);
  }

  const manifestPath = `${outputPrefix}.manifest.json`;
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        format: "vaml-world-vocab-shards",
        version: "0.2",
        createdAt: new Date().toISOString(),
        inputOrdering: "conceptKey-ascending-grouped",
        sourceRows: stats.sourceRows,
        totalConcepts,
        languages: stats.languages,
        surfaceForms: stats.surfaceForms,
        shards,
      },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  );

  console.log(`Built ${shards.length} encrypted shard(s).`);
  console.log(`Concepts: ${totalConcepts}; source rows: ${stats.sourceRows}; languages: ${stats.languages}; forms: ${stats.surfaceForms}.`);
  console.log(`Manifest: ${manifestPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
