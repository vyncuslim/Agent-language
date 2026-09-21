import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { parse } from "csv-parse";
import { canonicalJson } from "./crypto.js";
import type { ConceptSourceRecord } from "./types.js";
/** Explicit source senses are split; semantic disambiguation is supplied by the dataset/model. */
export function normalizeRecord(input: unknown): ConceptSourceRecord[] {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid source record");
  const r = input as ConceptSourceRecord & { senses?: unknown[] };
  if (r.senses !== undefined) {
    if (!Array.isArray(r.senses) || !r.senses.length || r.senses.length > 1024)
      throw new Error("Invalid senses");
    return r.senses.flatMap((semantic) =>
      normalizeRecord({ ...r, senses: undefined, semantic }),
    );
  }
  if (r.semantic === undefined || r.semantic === null)
    throw new Error("Missing semantic record");
  function normalize(v: unknown, depth = 0): unknown {
    if (depth > 32) throw new Error("Semantic nesting limit");
    if (typeof v === "string") return v.normalize("NFC");
    if (typeof v === "number" && !Number.isFinite(v))
      throw new Error("Invalid semantic number");
    if (Array.isArray(v)) return v.map((x) => normalize(x, depth + 1));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, normalize(x, depth + 1)]),
      );
    if (v === null || ["number", "boolean"].includes(typeof v)) return v;
    throw new Error("Invalid semantic material");
  }
  const semantic = normalize(r.semantic);
  if (Buffer.byteLength(canonicalJson(semantic)) > 65536)
    throw new Error("Semantic record too large");
  const aliases: Record<string, string[]> = {};
  for (const [lang, values] of Object.entries(r.aliases ?? {})) {
    if (!Array.isArray(values) || values.some((v) => typeof v !== "string"))
      throw new Error("Invalid aliases");
    aliases[lang] = [
      ...new Set(values.map((v) => v.normalize("NFKC").trim()).filter(Boolean)),
    ];
  }
  if (
    r.domains !== undefined &&
    (!Array.isArray(r.domains) || r.domains.some((v) => typeof v !== "string"))
  )
    throw new Error("Invalid domains");
  if (
    r.embedding !== undefined &&
    (!Array.isArray(r.embedding) ||
      r.embedding.length > 4096 ||
      r.embedding.some((n) => typeof n !== "number" || !Number.isFinite(n)))
  )
    throw new Error("Invalid embedding");
  for (const values of Object.values(r.relations ?? {}))
    if (!Array.isArray(values) || values.some((v) => typeof v !== "string"))
      throw new Error("Invalid relations");
  return [
    {
      semantic,
      identityMaterial:
        r.identityMaterial === undefined
          ? undefined
          : normalize(r.identityMaterial),
      aliases,
      domains: [...new Set(r.domains ?? [])].sort(),
      relations: r.relations,
      embedding: r.embedding,
      metadata: r.metadata,
    },
  ];
}
/** Optional private ingestion adapter; never included in runtime packs or transport. */
export class PrivateImportAliases {
  private readonly index = new Map<string, Set<string>>();
  add(id: string, aliases: Record<string, string[]> = {}): void {
    for (const [lang, values] of Object.entries(aliases))
      for (const value of values) {
        const key = lang + "|" + value.normalize("NFKC").trim().toLowerCase();
        const ids = this.index.get(key) ?? new Set<string>();
        ids.add(id);
        this.index.set(key, ids);
      }
  }
  resolve(lang: string, value: string): string[] {
    return [
      ...(this.index.get(
        lang + "|" + value.normalize("NFKC").trim().toLowerCase(),
      ) ?? []),
    ];
  }
}
export async function* readSources(
  file: string,
): AsyncGenerator<ConceptSourceRecord> {
  const ext = extname(file).toLowerCase();
  if (ext === ".json") {
    if ((await stat(file)).size > 64 * 1024 * 1024)
      throw new Error("JSON limit; use streaming JSONL/CSV");
    const records = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(records))
      throw new Error("JSON source must be an array");
    for (const record of records) yield* normalizeRecord(record);
  } else if (ext === ".jsonl") {
    const stream = createReadStream(file, {
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
            throw new Error("Source line too large");
          if (line.trim()) yield* normalizeRecord(JSON.parse(line));
        }
        if (Buffer.byteLength(pending) > 1048576)
          throw new Error("Source line too large");
      }
      if (pending.trim()) yield* normalizeRecord(JSON.parse(pending));
    } finally {
      stream.destroy();
    }
  } else if (ext === ".csv") {
    const input = createReadStream(file);
    const parser = parse({
      columns: true,
      bom: true,
      max_record_size: 1048576,
      skip_empty_lines: true,
    });
    input.on("error", (error) => parser.destroy(error));
    input.pipe(parser);
    try {
      for await (const row of parser) {
        const record = Object.fromEntries(
          Object.entries(row)
            .filter(([, v]) => v !== "")
            .map(([k, v]) => [k, JSON.parse(v as string)]),
        );
        yield* normalizeRecord(record);
      }
    } finally {
      input.destroy();
      parser.destroy();
    }
  } else throw new Error("Supported sources: JSONL, CSV, JSON");
}
