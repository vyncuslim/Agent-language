import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertOutsidePublicRepository,
  runPrivateCorpusBuild,
  unb64,
  type PrivateCorpusBuildPlan,
} from "../src/index.js";

function usage(): never {
  throw new Error("Usage: tsx tools/run-private-corpus-build.ts <private-build-plan.json>");
}

async function main(): Promise<void> {
  const planPath = process.argv[2];
  if (!planPath) usage();

  const semanticKeyRaw = process.env.VAML_SEMANTIC_KEY;
  const packKeyRaw = process.env.VAML_PACK_KEY;
  if (!semanticKeyRaw || !packKeyRaw) {
    throw new Error("VAML_SEMANTIC_KEY and VAML_PACK_KEY must be set as base64url 32-byte secrets");
  }
  const semanticKey = unb64(semanticKeyRaw);
  const packKey = unb64(packKeyRaw);
  if (semanticKey.length !== 32 || packKey.length !== 32) {
    throw new Error("VAML_SEMANTIC_KEY and VAML_PACK_KEY must each decode to exactly 32 bytes");
  }

  const toolDir = dirname(fileURLToPath(import.meta.url));
  const publicRepoRoot = resolve(toolDir, "../../..");
  const absolutePlanPath = resolve(planPath);
  assertOutsidePublicRepository(publicRepoRoot, absolutePlanPath, "build plan");

  const plan = JSON.parse(await fs.readFile(absolutePlanPath, "utf8")) as PrivateCorpusBuildPlan;
  if (!/^[A-Za-z0-9._-]+$/.test(plan.output?.prefix ?? "")) {
    throw new Error("output.prefix may contain only letters, numbers, dot, underscore and hyphen");
  }

  const receipt = await runPrivateCorpusBuild(plan, { semanticKey, packKey }, { publicRepoRoot });
  console.log(`Private corpus build ${receipt.runId} completed.`);
  console.log(`Candidates seen: ${receipt.pipelineStats.candidatesSeen}`);
  console.log(`Sorted private rows: ${receipt.pipelineStats.sortedRows}`);
  console.log(`Concepts: ${receipt.corpusStats.concepts}`);
  console.log(`Encrypted shards: ${receipt.artifacts.encryptedShards.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
