# VAML 0.2 Agent Learning Model

## Objective

An AI agent should be able to acquire VAML semantics from authorized private packs without depending on a public human-readable dictionary.

The reference learning layer does not train a foundation model. It provides the runtime mechanisms an agent or model adapter needs to associate private VAML concept identities with machine semantics, vectors, observations, and other private concepts.

## Learning surfaces

An authorized runtime may learn a concept from one or more of:

- exact private `conceptId`;
- model embedding similarity;
- private lexical ingress aliases;
- machine semantic records;
- concept relations;
- repeated co-occurrence or transition observations;
- tool/runtime outcomes.

The preferred native path is concept/vector/relations. Human language is an optional edge adapter.

## Reference learner

`AgentSemanticLearner` operates over a sealed `PrivateSemanticIndex` (or compatible resolver) and keeps runtime learning state in opaque form. Lexical observations are rejected unless the caller explicitly supplies a private import adapter backed by `PrivateImportAliases`; aliases are not present in runtime packs:

```text
conceptId -> exposure weight
conceptId -> conceptId association weight
```

It can:

1. resolve a known private concept exactly;
2. resolve a private lexical input through an authorized alias index;
3. resolve a model vector through nearest-neighbor semantic matching;
4. record concept exposure;
5. learn directed concept associations;
6. rank associated concepts;
7. snapshot and restore learning state without human labels.

A snapshot contains opaque concept identities and numeric weights only.

## Boot sequence

```text
vaml.manifest.json
        ↓
protocol + world lexicon + learning specs
        ↓
authorized encrypted .vocab packs
        ↓
decrypt inside trusted runtime
        ↓
PrivateSemanticIndex
        ↓
AgentSemanticLearner
        ↓
agent/model adapter
        ↓
private concepts
        ↓
peer session codebook
        ↓
encrypted VAML frames
```

## Internal representation

Agents SHOULD retain semantic state as private concept identities and model-native data rather than immediately converting it into prose.

Recommended internal tuple:

```text
<conceptId, confidence, vector?, relations?, typed value?, provenance?>
```

The exact model representation is implementation-defined.

## Learning from natural language

Natural-language input is allowed at the edge because users and external systems may communicate with words. It is not the VAML wire language.

A private adapter may perform:

```text
human input
   ↓
private tokenizer / model
   ↓
private alias + vector resolution
   ↓
concept candidates
   ↓
contextual disambiguation
   ↓
VAML concept identity
```

The chosen concept can then be transmitted using a session-local opaque code. The human word does not need to appear on the wire.

## Polysemy

One lexeme may resolve to multiple private concept IDs. The learner MUST NOT silently collapse them into one meaning.

Disambiguation may use:

- surrounding concepts;
- embeddings;
- current task state;
- domain context;
- relation graph;
- prior learned associations;
- model inference.

## Unknown concepts

Unknown session codes and unknown private concept identities are rejected. Agents must not infer a stable meaning from an unknown wire number, byte pattern, position, or frequency.

New concepts are introduced through authorized vocabulary negotiation or a new encrypted pack, not by guessing.

## Persistence

Learning state may be persisted separately from the vocabulary pack. In sealed deployments it should be encrypted at rest and treated as sensitive because co-occurrence structure can itself leak information.

Do not persist decrypted aliases or semantic payloads unless the deployment explicitly requires it.

## Human observability

Debug mode may expose semantic labels locally for development. Opaque and sealed modes should log policy-safe metadata instead:

- agent/session identity;
- concept count;
- pack IDs/hashes;
- sequence number;
- confidence bucket;
- policy decision;
- timing/error category.

This preserves operations visibility without turning logs into a plaintext semantic dictionary.

## Success criterion

A VAML-capable agent succeeds when it can perform both directions without a public word/opcode table:

```text
model state / observation
→ private concept candidate
→ private concept identity
→ session code
→ encrypted frame
```

and:

```text
encrypted frame
→ session code
→ private concept identity
→ model semantic state / action planner
```

VAML syntax or successful decryption never grants authorization to execute a tool. Tool policy remains a separate security boundary.
