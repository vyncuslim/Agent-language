import { createReadStream } from "node:fs";
import type { CorpusRow, CorpusSourceDescriptor } from "./corpus.js";
import type { CorpusSourceAdapter } from "./source-adapter.js";

const MAX_LINE_BYTES = 64 * 1024;
const SYNSET = /^(\d{8})-([nvars])$/i;
const LANGUAGE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;

export interface OmwTabSourceOptions {
  input: string;
  sourceVersion?: string;
  license?: string;
  provenance?: string;
}

export interface OmwTabRecord {
  offset: string;
  pos: "n" | "v" | "a" | "r" | "s";
  language: string;
  lemma: string;
  metadata?: Record<string, string>;
}

function text(value: string, field: string): string {
  const result = value.normalize("NFKC").trim();
  if (!result) throw new Error(`OMW ${field} must not be empty`);
  return result;
}

/** Parse the two common OMW tab layouts without retaining a source line. */
export function parseOmwTabLine(line: string, lineNumber = 1): OmwTabRecord | undefined {
  const value = line.replace(/\r$/, "");
  if (!value.trim() || value.trimStart().startsWith("#")) return undefined;
  if (Buffer.byteLength(value) > MAX_LINE_BYTES) throw new Error(`OMW line ${lineNumber} exceeds byte limit`);
  const columns = value.split("\t");
  if (columns.length < 2) throw new Error(`OMW line ${lineNumber} requires synset and lexical data`);
  const synset = SYNSET.exec(text(columns[0]!, "synset"));
  if (!synset) throw new Error(`OMW line ${lineNumber} has unsupported synset/POS`);

  let language: string;
  let lemma: string;
  let extras: string[];
  if (columns.length >= 3 && LANGUAGE.test(columns[1]!.trim())) {
    language = columns[1]!;
    lemma = columns[2]!;
    extras = columns.slice(3);
  } else {
    const lexical = text(columns[1]!, "lexical field");
    const separator = lexical.indexOf(":");
    if (separator < 1) throw new Error(`OMW line ${lineNumber} must declare language and lemma`);
    language = lexical.slice(0, separator);
    lemma = lexical.slice(separator + 1);
    extras = columns.slice(2);
  }
  language = text(language, "language").replaceAll("_", "-");
  if (!LANGUAGE.test(language)) throw new Error(`OMW line ${lineNumber} has invalid language`);
  language = new Intl.Locale(language).toString();
  lemma = text(lemma, "lemma");
  if (Buffer.byteLength(lemma) > 4096) throw new Error(`OMW line ${lineNumber} lemma exceeds byte limit`);
  const metadata = extras.filter((item) => item.trim()).length
    ? { extraColumnCount: String(extras.filter((item) => item.trim()).length) }
    : undefined;
  return { offset: synset[1]!, pos: synset[2]!.toLowerCase() as OmwTabRecord["pos"], language, lemma, metadata };
}

/**
 * Private OMW ingestion adapter.  Its alignment key identifies a PWN 3.0
 * synset, so multilingual expressions for that synset become one concept.
 */
export class OmwTabSourceAdapter implements CorpusSourceAdapter {
  readonly descriptor: CorpusSourceDescriptor;
  readonly provenance: string;

  constructor(private readonly options: OmwTabSourceOptions) {
    this.provenance = text(options.provenance ?? "operator-provided-omw-tab", "provenance");
    this.descriptor = {
      id: "omw-pwn-3.0",
      kind: "lexical-knowledge-base",
      license: text(options.license ?? "operator-must-verify-source-license", "license"),
      redistribution: "private-only",
      notes: `OMW tab adapter; source version ${text(options.sourceVersion ?? "unspecified", "source version")}; provenance retained only in private ingestion output.`,
    };
  }

  async *rows(): AsyncGenerator<CorpusRow> {
    const stream = createReadStream(this.options.input, { encoding: "utf8", highWaterMark: 64 * 1024 });
    let pending = "";
    let lineNumber = 0;
    let lastKey: string | undefined;
    const accept = (line: string): CorpusRow | undefined => {
      lineNumber += 1;
      const parsed = parseOmwTabLine(line, lineNumber);
      if (!parsed) return undefined;
      const alignmentKey = `omw:pwn3.0:${parsed.offset}-${parsed.pos}`;
      if (lastKey !== undefined && alignmentKey.localeCompare(lastKey) < 0) {
        throw new Error("OMW input must be globally sorted by PWN synset alignment key");
      }
      lastKey = alignmentKey;
      return {
        kind: "lexeme",
        alignmentKey,
        sourceId: this.descriptor.id,
        sourceSenseId: `pwn3.0:${parsed.offset}-${parsed.pos}:${parsed.language}:${parsed.lemma}`,
        language: parsed.language,
        lexeme: parsed.lemma,
        domains: [`pwn-pos:${parsed.pos}`],
        metadata: { omw: { sourceVersion: this.options.sourceVersion ?? "unspecified", provenance: this.provenance, ...parsed.metadata } },
      };
    };
    try {
      for await (const chunk of stream) {
        pending += chunk;
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error(`OMW line ${lineNumber + 1} exceeds byte limit`);
          const row = accept(line);
          if (row) yield row;
        }
        if (Buffer.byteLength(pending) > MAX_LINE_BYTES) throw new Error(`OMW line ${lineNumber + 1} exceeds byte limit`);
      }
      if (pending.length) {
        const row = accept(pending);
        if (row) yield row;
      }
    } finally {
      stream.destroy();
    }
  }
}
