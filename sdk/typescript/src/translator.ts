/**
 * Official VAML Translator boundary client.
 *
 * Human <-> VAML interpretation belongs EXCLUSIVELY to the authorized
 * translator backend (see Agent-language-Translate: POST {direction, input}
 * -> {output}). This module performs NO local translation and holds NO
 * concept dictionary: without a configured endpoint every call fails
 * closed. That refusal is the feature — a local word list would turn VAML
 * into a public dictionary.
 */

export type TranslationDirection = "vaml-to-human" | "human-to-vaml";

export interface TranslatorOptions {
  /** Bearer token; pass via environment, never CLI args or logs. */
  token?: string;
  timeoutMs?: number;
}

const MAX_INPUT_BYTES = 32768;
const DEFAULT_TIMEOUT_MS = 25000;

export function translationEndpoint(): string | undefined {
  const url = process.env.VAML_TRANSLATOR_API_URL;
  return url && url.trim() ? url.trim() : undefined;
}

export function translationToken(): string | undefined {
  const token = process.env.VAML_TRANSLATOR_API_TOKEN;
  return token && token.trim() ? token.trim() : undefined;
}

/**
 * Send one translation request to the authorized endpoint.
 * Input is NFC-normalized and size-bounded exactly like the boundary.
 * Returns the authorized human/VAML output string.
 */
export async function translateViaEndpoint(
  endpoint: string,
  direction: TranslationDirection,
  input: string,
  options: TranslatorOptions = {},
): Promise<string> {
  if (typeof endpoint !== "string" || !/^https?:\/\//.test(endpoint)) {
    throw new Error("Invalid translator endpoint");
  }
  if (direction !== "vaml-to-human" && direction !== "human-to-vaml") {
    throw new Error("Invalid translation direction");
  }
  if (typeof input !== "string") throw new Error("Invalid translation input");
  const normalized = input.normalize("NFC");
  if (!normalized.trim() || Buffer.byteLength(normalized, "utf8") > MAX_INPUT_BYTES) {
    throw new Error("Invalid translation input");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error("Invalid translator timeout");
  }
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ direction, input: normalized }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`Translator endpoint unreachable: ${error instanceof Error ? error.message : error}`);
  }
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { output: text };
  }
  if (!response.ok) {
    const message = (data as Record<string, unknown>)?.["error"];
    throw new Error(typeof message === "string" ? message : `Translator endpoint returned ${response.status}`);
  }
  const record = data as Record<string, unknown>;
  const output = [record["output"], record["translation"], record["result"], record["text"]].find(
    (x): x is string => typeof x === "string",
  );
  if (!output) throw new Error("Translator endpoint returned no output");
  return output;
}
