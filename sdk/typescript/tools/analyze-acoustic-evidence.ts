#!/usr/bin/env tsx
/**
 * Offline VAML acoustic evidence analyzer CLI.
 *
 * Usage:
 *   npm run acoustic:evidence -- path/to/capture.wav
 *   npm run acoustic:evidence -- path/to/capture.wav --json report.json
 *
 * The input WAV is only read, never modified.
 */
import { promises as fs } from "node:fs";
import { analyzeEvidenceWav, formatEvidenceReport } from "../src/acoustic-evidence.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const jsonFlag = args.indexOf("--json");
  let jsonOut: string | undefined;
  let wavPath: string | undefined;
  if (jsonFlag >= 0) {
    jsonOut = args[jsonFlag + 1];
    if (!jsonOut) {
      console.error("Missing path after --json");
      process.exitCode = 2;
      return;
    }
  }
  const positional = args.filter((a, i) => a !== "--json" && args[i - 1] !== "--json" && !a.startsWith("--"));
  wavPath = positional[0];
  if (!wavPath) {
    console.error("Usage: npm run acoustic:evidence -- <capture.wav> [--json report.json]");
    process.exitCode = 2;
    return;
  }
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(wavPath);
  } catch (error) {
    console.error(`Cannot read ${wavPath}: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
    return;
  }
  const report = analyzeEvidenceWav(bytes);
  console.log(formatEvidenceReport(report));
  if (jsonOut) {
    await fs.writeFile(jsonOut, JSON.stringify(report, null, 2), "utf8");
    console.error(`JSON report written to ${jsonOut}`);
  }
  process.exitCode = report.verdict === "VERIFIED PASS" ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
