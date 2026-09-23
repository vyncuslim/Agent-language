import { createWriteStream, promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { OmwTabSourceAdapter } from "../src/omw.js";
import { readCorpusSourceAdapter } from "../src/source-adapter.js";

interface Arguments { input: string; out: string; sourceVersion?: string; license?: string; provenance?: string }

function parseArgs(values: string[]): Arguments {
  const options: Partial<Arguments> = {};
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index]!;
    const value = values[index + 1];
    if (!value || !["--input", "--out", "--source-version", "--license", "--provenance"].includes(flag)) {
      throw new Error("Usage: corpus:omw --input source.tab --out private.omw.ingest.json [--source-version v --license text --provenance text]");
    }
    if (flag === "--input") options.input = value;
    if (flag === "--out") options.out = value;
    if (flag === "--source-version") options.sourceVersion = value;
    if (flag === "--license") options.license = value;
    if (flag === "--provenance") options.provenance = value;
    index += 1;
  }
  if (!options.input || !options.out || !options.out.endsWith(".omw.ingest.json")) {
    throw new Error("--input and an --out ending in .omw.ingest.json are required");
  }
  return options as Arguments;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const out = resolve(args.out);
  const rowsFile = out.replace(/\.json$/, ".jsonl");
  const input = resolve(args.input);
  if (input === out || input === rowsFile) throw new Error("OMW output must not overwrite input");
  await fs.mkdir(dirname(out), { recursive: true });
  const adapter = new OmwTabSourceAdapter({ input, sourceVersion: args.sourceVersion, license: args.license, provenance: args.provenance });
  let output: ReturnType<typeof createWriteStream> | undefined;
  try {
    await fs.access(out).then(() => { throw new Error("OMW manifest already exists; refusing overwrite"); }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    await fs.access(rowsFile).then(() => { throw new Error("OMW rows already exist; refusing overwrite"); }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    output = createWriteStream(rowsFile, { encoding: "utf8", flags: "wx", mode: 0o600 });
    let records = 0;
    const languages = new Set<string>();
    const synsets = new Set<string>();
    for await (const row of readCorpusSourceAdapter(adapter)) {
      if (row.kind !== "lexeme") throw new Error("OMW adapter emitted a non-lexical row");
      if (!output.write(`${JSON.stringify(row)}\n`)) await new Promise<void>((done, fail) => { output!.once("drain", done); output!.once("error", fail); });
      records += 1;
      languages.add(row.language);
      synsets.add(row.alignmentKey);
    }
    await new Promise<void>((done, fail) => output!.end(done).once("error", fail));
    output = undefined;
    const manifest = {
      format: "vaml-omw-private-ingest",
      version: "0.1",
      source: { id: adapter.descriptor.id, sourceVersion: args.sourceVersion ?? "unspecified", license: adapter.descriptor.license, provenance: adapter.provenance, redistribution: "private-only" },
      alignment: "omw:pwn3.0:{offset}-{pos}",
      records, synsets: synsets.size, languages: [...languages].sort(), recordsFile: rowsFile,
    };
    await fs.writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ format: manifest.format, records, synsets: synsets.size, languages: manifest.languages }));
  } catch (error) {
    output?.destroy();
    await Promise.allSettled([fs.rm(out, { force: true }), fs.rm(rowsFile, { force: true })]);
    throw error;
  }
}

main().catch(() => { console.error("OMW private ingest rejected; check tab format, sorted synsets, provenance and output path."); process.exitCode = 1; });
