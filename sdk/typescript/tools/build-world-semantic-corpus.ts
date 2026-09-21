import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import {
  WorldSemanticCorpusAssembler,
  type CorpusRow,
  type CorpusSourceDescriptor,
} from "../src/corpus.js";
import { buildVocabulary } from "../src/vocabulary.js";
import { envKey } from "../src/cli.js";
import { b64, canonicalJson, sha256 } from "../src/crypto.js";
async function main(): Promise<void> {
  const [sources, input, out, revision = "1"] = process.argv.slice(2);
  if (!sources || !input || !out)
    throw new Error(
      "Usage: corpus-pack sources.json corpus.sorted.jsonl output-directory [revision]",
    );
  if ((await stat(sources)).size > 1048576)
    throw new Error("Source registry limit");
  const registry = JSON.parse(await readFile(sources, "utf8")) as {
    format: string;
    version: string;
    sources: CorpusSourceDescriptor[];
  };
  if (
    registry.format !== "vaml-corpus-sources" ||
    registry.version !== "0.1" ||
    !Array.isArray(registry.sources) ||
    !registry.sources.length ||
    registry.sources.length > 10000
  )
    throw new Error("Invalid source registry");
  const assembler = new WorldSemanticCorpusAssembler(registry.sources);
  const policy = b64(sha256(canonicalJson(registry))),
    semantic = envKey("VAML_SEMANTIC_KEY"),
    key = envKey("VAML_PACK_KEY");
  async function* records() {
    const stream = createReadStream(input, {
      encoding: "utf8",
      highWaterMark: 65536,
    });
    let pending = "";
    function accept(line: string) {
      const row = JSON.parse(line) as CorpusRow;
      if (row.kind !== "lexeme" && row.kind !== "agent-native")
        throw new Error("Invalid corpus row");
      const result = assembler.push(row);
      if (result)
        result.metadata = { ...result.metadata, sourcePolicyDigest: policy };
      return result;
    }
    try {
      for await (const chunk of stream) {
        pending += chunk;
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (Buffer.byteLength(line) > 1048576)
            throw new Error("Source line limit");
          if (line.trim()) {
            const record = accept(line);
            if (record) yield record;
          }
        }
        if (Buffer.byteLength(pending) > 1048576)
          throw new Error("Source line limit");
      }
      if (pending.trim()) {
        const record = accept(pending);
        if (record) yield record;
      }
      const last = assembler.finish();
      if (last) {
        last.metadata = { ...last.metadata, sourcePolicyDigest: policy };
        yield last;
      }
    } finally {
      stream.destroy();
    }
  }
  try {
    console.log(
      JSON.stringify({
        ...(await buildVocabulary(
          records(),
          out,
          semantic,
          key,
          Number(revision),
        )),
        ...assembler.stats(),
      }),
    );
  } finally {
    semantic.fill(0);
    key.fill(0);
  }
}
main().catch(() => {
  console.error(
    "Private corpus build rejected; check authorized registry, source and keys.",
  );
  process.exitCode = 1;
});
