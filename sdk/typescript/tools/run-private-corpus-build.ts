import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { envKey } from "../src/cli.js";
import {
  assertOutsidePublicRepository,
  runPrivateCorpusBuild,
  type PrivateCorpusBuildPlan,
} from "../src/private-corpus-runner.js";

function usage(): never {
  throw new Error("Usage: private-corpus-run <private-build-plan.json>");
}

async function main(): Promise<void> {
  const planArg = process.argv[2];
  if (!planArg) usage();

  const toolDir = dirname(fileURLToPath(import.meta.url));
  const publicRepoRoot = resolve(toolDir, "../../..");
  const planPath = resolve(planArg);
  assertOutsidePublicRepository(publicRepoRoot, planPath, "build plan");

  const plan = JSON.parse(await fs.readFile(planPath, "utf8")) as PrivateCorpusBuildPlan;
  const semanticKey = envKey("VAML_SEMANTIC_KEY");
  const packKey = envKey("VAML_PACK_KEY");
  try {
    const receipt = await runPrivateCorpusBuild(
      plan,
      { semanticKey, packKey },
      { publicRepoRoot },
    );
    console.log(
      JSON.stringify({
        runId: receipt.runId,
        candidates: receipt.pipelineStats.candidatesSeen,
        sortedRows: receipt.pipelineStats.sortedRows,
        concepts: receipt.corpusStats.concepts,
        catalogId: receipt.artifacts.vocabulary.catalogId,
        revision: receipt.artifacts.vocabulary.revision,
      }),
    );
  } finally {
    semanticKey.fill(0);
    packKey.fill(0);
  }
}

main().catch(() => {
  console.error("Private corpus build rejected; check the private plan, digests, alignment, licenses and keys.");
  process.exitCode = 1;
});
