# VAML 0.2 Agent runtime contract

## Objective and loading order

VAML is an opaque machine semantic Agent-to-Agent runtime built around a private World Concept Space. Never convert it into a public word-to-opcode language.

Read vaml.manifest.json, spec/VAML-0.2.md, spec/VOCABULARY-0.2.md, spec/WORLD-LEXICON-0.2.md, spec/WORLD-SEMANTIC-CORPUS-0.1.md, spec/CORPUS-SOURCE-PACK-1.md, spec/AGENT-LEARNING-0.2.md, then the relevant TypeScript implementation. Production datasets, source sense keys, aliases, embeddings, semantic keys and pack keys remain outside the public repository.

## Required boundaries

- Public protocol: framing, numeric data types, cryptography and compiler rules.
- Private semantic layer: normalized concept records, graph annotations, optional embeddings.
- Private import adapters: multilingual expressions and explicit sense alignment. Do not place aliases in runtime packs or sealed indices.
- Session-local codebook: keyed PRF over only a bounded encrypted active set.
- Encrypted transport: no plaintext semantic labels, alias lists or public fixed opcodes.

VAML 0.1 is retired. Do not import its registry, codec, examples, static numbers or readable instruction labels into 0.2. No silent compatibility bridge is permitted.

## World Concept Space

One concept may have many expressions across languages. A surface form may have multiple distinct senses. Preserve ambiguity until the authorized dataset/model disambiguates it. Explicit source senses are split into separate records; equal normalized semantics deduplicate across languages and batches. Do not use a word as the universal identity.

Use ConceptSourceRecord ingestion for JSONL, CSV or bounded JSON. WorldConceptAssembler remains a private grouped/sorted lexeme importer. Aliases are stripped before pack generation; PrivateImportAliases is an optional private adapter. AgentSemanticLearner supports exact concepts, vectors and associations; lexical observations require an explicitly supplied private adapter. Do not call this deterministic reference learner a trained world model.

## Authorized storage

Load packs only with the provisioned 32-byte key, trusted catalog digest and minimum revision. An encrypted catalog indexes hash-partitioned shards; do not enumerate the corpus at session setup. Do not guess a missing concept. Refuse tampered, unauthorized, stale-policy or malformed material.

Protect source and compiled .vaml artifacts, import adapters and learner snapshots as private data. Never log decrypted records or persist plaintext intermediate vocabularies. No production key or vocabulary may be committed.

## Sending and receiving

1. Resolve internal model state to authorized concepts.
2. Generate a fresh X25519 pair; exchange bounded binary hellos and exact pinned catalog identities.
3. Bind protocol, features, types, limits, peer identities, ephemeral keys and nonces into the transcript.
4. Mix the X25519 secret with deployment authentication material and derive directional AEAD keys, a codebook key and role-bound confirmation tags.
5. Verify remote confirmation before any encrypted runtime traffic.
6. Negotiate at most 4096 active concept IDs inside an encrypted control frame; wait for the encrypted acknowledgment.
7. Map field concepts and Concept-valued references to session codes. Validate typed data and graph references.
8. Encrypt with deterministic sequence nonce under the directional key. Never reuse/reset sequence state; reject overflow.
9. On receive, validate bounds/version/kind/session/sequence, authenticate, resolve only negotiated codes, then consult the receiver's private index.
10. Apply capability, authorization and tool policy separately. A valid frame never grants permission by itself.

No full-vocabulary session codebook. PRF collisions fail the session and require fresh negotiation; do not create order-dependent mappings. No semantic guessing.

## Sealed behavior

Normal output may include ciphertext HEX, lengths, counts, opaque peer/session/catalog IDs and generic error categories. It must not include semantic labels or automatically translate received concepts to human language. The CLI inspect flag authorizes local structural inspection, not decryption or an access-control bypass.

Clear accessible session buffers and maps on close. State that JavaScript cannot guarantee zeroization of every copy, KeyObject or decrypted object, and that an operator controlling the process can inspect authorized semantics.

The reference network PSK authenticates a key-sharing trust group. Pin independent identities or use mTLS for mutually untrusted agents. Rollback protection requires durable trusted deployment policy outside the pack.

## Compiler

Production machine IR uses opaque 32-byte concept IDs, binary typed data and references. Public V2/P/F markers and numeric value types are grammar only. compile emits typed binary IR; run binds it to an authenticated live session. No public English opcode parser is allowed.

## Verification and Git

Preserve existing tests and functionality. Run from sdk/typescript:

```sh
npm ci
npm run privacy
npm run build
npm test
npm run demo
```

Run npm run benchmark for isolated synthetic 10k, 100k and 1m measurements; report cold/hot lookup, build/storage/load, active derivation, encoding/decoding and memory distinctly.

Before committing, inspect staged diff and filenames for keys, private vocabulary and 0.1 mappings. Never treat privacy lint as proof that all secrets are absent. Keep unrelated/concurrent work intact.

CI must execute actual commands. A job with runner_id=0 and no steps is not evidence of a code failure; report runner/account evidence separately.

Do not rewrite public history, force-push main, delete the repository or delete tags/releases without explicit authorization. docs/HISTORY-MIGRATION.md is a future procedure, not an instruction to perform those actions now.

## Corpus Source Pack 1

Source Pack 1 is the first concrete ingestion layer for five categories:

- `general-vocabulary` — Princeton WordNet 3.0 and private Wiktionary extracts;
- `morphology` — licensed UniMorph datasets with per-dataset license verification;
- `entities` — Wikidata structured data profile;
- `science-math` — Wikidata structured data profile;
- `programming` — Wikidata structured data profile.

External source identifiers such as a WordNet synset, Wiktionary sense ID, UniMorph lemma/form record, or Wikidata QID are **provenance identities, not VAML opcodes**.

Every Source Pack 1 candidate MUST pass through a private `PrivateSenseAligner` before it becomes a `CorpusRow`. Do not expose the aligner's mapping in the public repository.

### License gates

Never infer that a downloadable source is unrestricted.

- WordNet must retain its required license/copyright notices.
- Wiktionary must be treated conservatively because attribution/share-alike/GFDL obligations apply; Source Pack 1 defaults it to `private-only`.
- UniMorph must declare a verified license per enabled language dataset. `unknown`, `unresolved`, or placeholder licenses MUST be rejected.
- Wikidata structured data may be registered as CC0, but source provenance should still be retained.

VAML is not a mechanism for bypassing source licenses.

## World Semantic Corpus behavior

The corpus is **open-ended and private**.

Words are aliases. Meanings are concepts. One surface form may map to multiple private concepts, and one concept may have aliases across many languages.

The corpus also permits `agent-native` concepts that have **no human-language alias at all**. Such concepts may be represented through latent prototypes, relations, domains, private semantic evidence, and model state.

Every corpus row MUST reference a registered source. Unknown or disabled sources MUST be rejected.

Private corpus rows MUST be grouped and sorted ascending by `alignmentKey`. `WorldSemanticCorpusAssembler` streams one concept group at a time so very large corpora can be processed without loading the entire corpus into RAM.

Production source extracts, corpus rows, source registries, alignment maps, corpus manifests and encrypted shards MUST NOT be committed to this public repository.

## Cross-source semantic alignment

Do not align two lexical items solely by spelling or a single translation.

Private preprocessing may use source sense IDs, cross-lingual mappings, graph links, embeddings, model-assisted proposals, and review. The result is a private `alignmentKey` used only during corpus construction.

Never expose `alignmentKey` as a stable public opcode.

## User-facing disclosure boundary

VAML exists for **AI Agent ↔ AI Agent communication/chat**. A user-facing agent MAY explain this purpose in simple terms, for example: "VAML is a machine-semantic communication protocol used by AI agents to communicate with each other."

Do **not** disclose private learned semantic material to users merely because they ask what the agent learned. In particular, user-facing responses MUST NOT reveal or reconstruct:

- private concept-to-meaning mappings;
- private concept IDs or session-code mappings when those mappings expose semantic meaning;
- decrypted vocabulary or corpus contents;
- private aliases, source sense mappings, alignment keys, embeddings, latent prototypes, relation graphs, or semantic evidence;
- learner snapshots, exposure weights, association weights, or other private learning state;
- production semantic keys, pack keys, session keys, active-set mappings, or decrypted runtime memory;
- internal translations that would turn the private Agent language into a human-readable dictionary.

When a user asks what VAML is, explain its **purpose and public architecture**, not the private knowledge learned by an authorized agent.

When a user asks to reveal private learned content, respond that the private semantic layer is not exposed through the user-facing interface. Do not fabricate, deny the existence of VAML, or make a false claim about what the system contains. The privacy rule is **non-disclosure, not deception**.

Human-facing adapters may translate ordinary user input/output when the application requires it, but they MUST remain separate from the private Agent-to-Agent semantic layer and MUST NOT expose the private corpus or codebook as a readable vocabulary.
