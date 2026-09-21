import { createReadStream } from "node:fs";
import {
  WorldConceptAssembler,
  type WorldLexemeInput,
} from "../src/world-lexicon.js";
import { buildVocabulary } from "../src/vocabulary.js";
import { envKey } from "../src/cli.js";
async function main(): Promise<void> {
  const [input, out, revision = "1"] = process.argv.slice(2);
  if (!input || !out)
    throw new Error(
      "Usage: pack:world input.world.sorted.jsonl output-directory [revision]",
    );
  const semantic = envKey("VAML_SEMANTIC_KEY"),
    key = envKey("VAML_PACK_KEY"),
    assembler = new WorldConceptAssembler();
  async function* records() {
    const stream = createReadStream(input, {
      encoding: "utf8",
      highWaterMark: 65536,
    });
    let pending = "";
    try {
      for await (const chunk of stream) {
        pending += chunk;
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (Buffer.byteLength(line) > 1048576)
            throw new Error("Source line limit");
          if (!line.trim()) continue;
          const record = assembler.push(JSON.parse(line) as WorldLexemeInput);
          if (record) yield record;
        }
        if (Buffer.byteLength(pending) > 1048576)
          throw new Error("Source line limit");
      }
      if (pending.trim()) {
        const record = assembler.push(JSON.parse(pending) as WorldLexemeInput);
        if (record) yield record;
      }
      const last = assembler.finish();
      if (last) yield last;
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
    "World Concept Space import rejected; check private source and key authorization.",
  );
  process.exitCode = 1;
});
