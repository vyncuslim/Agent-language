#!/usr/bin/env node
import { readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertKey, unb64 } from "./crypto.js";
import { compileArtifact, readArtifact } from "./compiler.js";
import { buildVocabulary, ShardedSemanticIndex } from "./vocabulary.js";
import { runClient } from "./transport.js";
export function envKey(name: string): Buffer {
  const raw = process.env[name];
  if (!raw) throw new Error("Missing secret environment variable");
  const key = unb64(raw);
  assertKey(key);
  return key;
}
export function option(args: string[], name: string): string {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1] || args[i + 1].startsWith("--"))
    throw new Error("Missing required option");
  return args[i + 1];
}
export async function loadInput(file: string) {
  if ((await stat(file)).size > 1048580) throw new Error("Source size limit");
  return readArtifact(await readFile(file));
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, file] = args;
  if (command === "compile") {
    if (!file || (await stat(file)).size > 1048576)
      throw new Error("Invalid source");
    const output = args.includes("--out")
      ? option(args, "--out")
      : file + ".compiled.vaml";
    await writeFile(output, compileArtifact(await readFile(file, "utf8")), {
      mode: 0o600,
      flag: "wx",
    });
    console.log("Compiled machine IR; session binding occurs at run time.");
    return;
  }
  if (command === "inspect") {
    if (!args.includes("--authorized"))
      throw new Error("Explicit local inspection authorization required");
    const input = await loadInput(file);
    console.log(
      JSON.stringify({
        version: 2,
        peer: input.peer,
        fields: input.fields.map((f) => ({
          conceptId: f.conceptId,
          type: f.valueType,
        })),
      }),
    );
    return;
  }
  if (command === "pack" && file === "build") {
    const semantic = envKey("VAML_SEMANTIC_KEY"),
      key = envKey("VAML_PACK_KEY");
    try {
      console.log(
        JSON.stringify(
          await buildVocabulary(
            args[2],
            option(args, "--out"),
            semantic,
            key,
            Number(option(args, "--revision")),
          ),
        ),
      );
    } finally {
      semantic.fill(0);
      key.fill(0);
    }
    return;
  }
  if (command === "pack" && file === "verify") {
    const key = envKey("VAML_PACK_KEY");
    try {
      const index = new ShardedSemanticIndex(
        args[2],
        key,
        option(args, "--catalog"),
        Number(option(args, "--min-revision")),
      );
      try {
        index.verify();
        console.log(JSON.stringify({ verified: index.size() }));
      } finally {
        index.close();
      }
    } finally {
      key.fill(0);
    }
    return;
  }
  if (command === "run") {
    const target = option(args, "--peer").match(/^([^:]+):(\d+)$/);
    if (!target) throw new Error("Expected host:port");
    const input = await loadInput(file),
      key = envKey("VAML_PACK_KEY");
    let index: ShardedSemanticIndex | undefined;
    try {
      index = new ShardedSemanticIndex(
        option(args, "--vocab"),
        key,
        option(args, "--catalog"),
        Number(option(args, "--min-revision")),
      );
      const fields = await runClient(
        target[1],
        Number(target[2]),
        input,
        {
          agentId: option(args, "--id"),
          peerId: input.peer,
          catalogId: index.catalogId,
          packKey: key,
          index,
        },
        (f) => console.log("FRAME_HEX " + f.toString("hex")),
      );
      console.log(JSON.stringify({ received: fields.length }));
    } finally {
      index?.close();
      key.fill(0);
    }
    return;
  }
  throw new Error("Usage: vaml compile|inspect|run|pack build|pack verify");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch(() => {
    console.error(
      "VAML command rejected; check inputs, authorization and peer availability.",
    );
    process.exitCode = 1;
  });
