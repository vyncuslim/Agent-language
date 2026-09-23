#!/usr/bin/env tsx
/**
 * Offline VAML acoustic evidence analyzer CLI.
 *
 * Usage:
 *   npm run acoustic:evidence -- path/to/capture.wav
 *   npm run acoustic:evidence -- path/to/capture.wav --json report.json
 *   npm run acoustic:evidence -- path/to/capture.wav --calibration vaml-acoustic-calibration.json
 *
 * The input WAV is only read, never modified. A calibration file applies
 * measured carrier offsets + RX normalization; verdict rules are identical
 * either way (CRC PASS + byte-exact match, no "close enough").
 */
import { promises as fs } from "node:fs";
import { basename } from "node:path";
import { analyzeEvidenceWav, formatEvidenceReport, type EvidenceEqualization } from "../src/acoustic-evidence.js";
import { loadChannelCalibrationV2, toEvidenceEqualizationV2 } from "../src/acoustic-calibration.js";

function flagValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  return args[at + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const jsonOut = flagValue(args, "--json");
  if (args.includes("--json") && !jsonOut) {
    console.error("Missing path after --json");
    process.exitCode = 2;
    return;
  }
  const calPath = flagValue(args, "--calibration");
  if (args.includes("--calibration") && !calPath) {
    console.error("Missing path after --calibration");
    process.exitCode = 2;
    return;
  }
  const positional = args.filter((a, i) => {
    if (!a || a.startsWith("--")) return false;
    const prev = args[i - 1];
    return prev !== "--json" && prev !== "--calibration";
  });
  const wavPath = positional[0];
  if (!wavPath) {
    console.error("Usage: npm run acoustic:evidence -- <capture.wav> [--json report.json] [--calibration vaml-acoustic-calibration.json]");
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
  let eq: EvidenceEqualization | undefined;
  let eqSource = "inline";
  if (calPath) {
    try {
      const raw = await fs.readFile(calPath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("Invalid calibration JSON");
      }
      const version = (parsed as Record<string, unknown>)?.["version"];
      if (version !== "vaml-acoustic-calibration/2") {
        if (version === "vaml-acoustic-calibration/1") {
          throw new Error("v1 calibration is a legacy diagnostic and cannot feed the formal path; run the Round-1/Round-2 symbol calibration to produce v2");
        }
        // The strict v2 loader produces the precise rejection reason.
        loadChannelCalibrationV2(raw);
        throw new Error("Unsupported calibration version");
      }
      const cal = loadChannelCalibrationV2(raw);
      const view = toEvidenceEqualizationV2(cal);
      eq = { frequenciesHz: view.frequenciesHz, rxGains: view.rxGains, provenance: view.provenance };
      eqSource = basename(calPath);
      console.error(`Calibration v2 ${cal.quality.status}: effectiveRxGains (MEASURED ROUND 2) ${view.rxGains.map((g) => g.toFixed(3)).join("/")}.`);
      console.error(`Provenance: round1 ${cal.round1Sha256.slice(0, 12)}… round2 ${cal.round2Sha256.slice(0, 12)}….`);
      if (cal.quality.blockSend) {
        console.error("Warning: Round-1 quality blocks sending; analysis continues but the channel needs attention.");
      }
    } catch (error) {
      console.error(`Cannot use calibration ${calPath}: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 2;
      return;
    }
  }
  const report = analyzeEvidenceWav(bytes, eq, eqSource);
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
