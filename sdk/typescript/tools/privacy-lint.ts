import { promises as fs } from "node:fs";
import { join, relative, resolve } from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".next", "coverage"]);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const forbiddenFilePatterns: RegExp[] = [
  /(^|\/)private-lexicon(\/|$)/i,
  /(^|\/)private-vocab(\/|$)/i,
  /(^|\/)world-lexicon(\/|$)/i,
  /(^|\/)private-corpus(\/|$)/i,
  /(^|\/)corpus-private(\/|$)/i,
  /(^|\/)alignment-map(\/|$)/i,
  /(^|\/)alignment-shards(\/|$)/i,
  /(^|\/)source-pack-private(\/|$)/i,
  /(^|\/)source-snapshots(\/|$)/i,
  /(^|\/)private-build(\/|$)/i,
  /\.private\.jsonl$/i,
  /\.world(?:\.sorted)?\.jsonl$/i,
  /\.corpus(?:\.sorted)?\.jsonl$/i,
  /\.corpus\.manifest\.json$/i,
  /\.corpus\.sources\.json$/i,
  /\.sourcepack\.jsonl$/i,
  /\.snapshot\.private\.jsonl$/i,
  /\.extract\.private\.jsonl$/i,
  /\.alignment\.private\.jsonl$/i,
  /\.alignment\.private\.json$/i,
  /\.alignment\.manifest\.json$/i,
  /\.sources\.private\.json$/i,
  /\.build-plan\.json$/i,
  /\.build\.receipt\.json$/i,
  /\.vocab\.json$/i,
  /\.vocab\.key$/i,
  /\.semantic\.key$/i,
  /\.session\.key$/i,
  /(^|\/)\.env(?:\.|$)/i,
];

const forbiddenContentPatterns: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "decrypted private lexicon payload",
    pattern: /["']format["']\s*:\s*["']vaml-private-lexicon["']/,
  },
  {
    name: "embedded semantic key",
    pattern: /VAML_SEMANTIC_KEY\s*=\s*[A-Za-z0-9_-]{32,}/,
  },
  {
    name: "embedded pack key",
    pattern: /VAML_PACK_KEY\s*=\s*[A-Za-z0-9_-]{32,}/,
  },
  {
    name: "public fixed word-to-opcode registry",
    pattern: /["'](?:word|lexeme|term)["']\s*:\s*["'][^"']+["'][\s\S]{0,160}["'](?:opcode|publicCode|fixedCode)["']\s*:/i,
  },
  {
    name: "committed private source-pack alignment table",
    pattern: /["'](?:sourceSenseId|synset|wikidataId)["']\s*:\s*["'][^"']+["'][\s\S]{0,200}["']alignmentKey["']\s*:\s*["'][^"']+["']/i,
  },
  {
    name: "committed populated private alignment shard",
    pattern: /["']entries["']\s*:\s*\{\s*["'][A-Za-z0-9_-]{43}["']\s*:\s*["'][^"']{4,}["']/i,
  },
];

async function walk(root: string, current: string, errors: string[]): Promise<void> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const absolute = join(current, entry.name);
    const rel = relative(root, absolute).replaceAll("\\", "/");

    if (entry.isDirectory()) {
      await walk(root, absolute, errors);
      continue;
    }
    if (!entry.isFile()) continue;

    if (forbiddenFilePatterns.some((pattern) => pattern.test(rel)) && !rel.endsWith(".env.example")) {
      errors.push(`${rel}: private/secret filename must not be committed`);
      continue;
    }

    const stat = await fs.stat(absolute);
    if (stat.size > MAX_TEXT_BYTES) continue;

    let content: string;
    try {
      content = await fs.readFile(absolute, "utf8");
    } catch {
      continue;
    }

    for (const rule of forbiddenContentPatterns) {
      if (rule.pattern.test(content)) errors.push(`${rel}: ${rule.name}`);
    }
  }
}

async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? ".");
  const errors: string[] = [];
  await walk(root, root, errors);
  if (errors.length) {
    console.error("VAML privacy lint failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "VAML privacy lint passed: no committed private lexicon/corpus/source-pack/build artifacts, keys, alignment maps, or fixed public word/opcode tables detected.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
