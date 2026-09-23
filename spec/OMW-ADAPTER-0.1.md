# OMW Adapter 0.1

`OmwTabSourceAdapter` is a private import adapter for Open Multilingual Wordnet
tab data. It is not a public dictionary and it does not add labels to VAML
frames, runtime packs, or the public protocol specification.

Each accepted source row carries a PWN 3.0 synset reference and produces the
private corpus alignment key:

```text
omw:pwn3.0:{offset}-{pos}
```

The same synset in different languages therefore becomes one private concept.
The same surface expression in different synsets becomes different concepts.
For example, lexical forms such as `bank` must retain their individual synset
alignment; a word is never a concept identity.

## Private ingestion

The adapter accepts the common OMW tab forms:

```text
02084071-n<TAB>eng<TAB>lemma
02084071-n<TAB>eng:lemma
```

It normalizes Unicode and language tags, rejects malformed/unsupported POS
records, limits source lines, and requires globally sorted synset alignment
keys. The private corpus runner remains responsible for verified source
snapshots, bounded-memory external sorting, deduplication, encrypted shard
building, and provenance checks when combining OMW with other sources.

Create an ignored private ingest manifest and row stream:

```sh
npm run corpus:omw -- --input /secure/omw.tab --out /secure/omw.omw.ingest.json \
  --source-version "OMW release" --license "source license" --provenance "acquisition record"
```

The command writes `*.omw.ingest.json` and `*.omw.ingest.jsonl` with mode 0600,
refuses overwrite, and does not print aliases or records. The manifest retains
operator-supplied source version, license, and provenance. Operators must verify
the actual source licence and redistribution obligations; VAML does not claim
ownership of OMW data. Production OMW tabs, manifests, rows, mappings and packs
must never be committed.

Aliases exist only before encrypted vocabulary construction. `buildVocabulary`
removes aliases before writing runtime shards; agents exchange only negotiated
opaque concept IDs/session codes in authenticated encrypted frames.
