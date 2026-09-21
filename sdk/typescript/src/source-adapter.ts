import {
  validateCorpusSource,
  type CorpusRow,
  type CorpusSourceDescriptor,
} from "./corpus.js";

/**
 * Boundary implemented by private/source-specific ingestion packages.
 *
 * The public VAML repository intentionally does not contain vendor-specific
 * dictionary credentials, licensed source dumps, or production mappings.
 */
export interface CorpusSourceAdapter {
  descriptor: CorpusSourceDescriptor;
  rows(): AsyncIterable<CorpusRow>;
}

/**
 * Validate an adapter's descriptor and enforce source identity on every row.
 * Sorting/cross-source alignment happens after adapter normalization.
 */
export async function* readCorpusSourceAdapter(
  adapter: CorpusSourceAdapter,
): AsyncGenerator<CorpusRow> {
  const descriptor = validateCorpusSource(adapter.descriptor);
  if (descriptor.enabled === false) {
    throw new Error(`Corpus source adapter is disabled: ${descriptor.id}`);
  }

  for await (const row of adapter.rows()) {
    if (row.sourceId.normalize("NFKC").trim() !== descriptor.id) {
      throw new Error(
        `Corpus adapter ${descriptor.id} emitted row for different source ${row.sourceId}`,
      );
    }
    yield row;
  }
}
