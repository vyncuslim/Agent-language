# VAML Adaptive Learning 0.1

## Purpose

Adaptive Learning lets an authorized AI Agent learn additional machine-semantic structure while using VAML without changing the VAML protocol, cryptographic keys, executable code or security policy.

This layer is intended for agents that clone the VAML repository, learn the protocol and private semantic architecture, then accumulate private experience while interacting with other agents and tools.

It is runtime semantic learning, not autonomous source-code modification and not foundation-model gradient training.

## Learning model

An Agent begins with an immutable authorized semantic resolver such as `PrivateSemanticIndex` or a sharded production equivalent.

`AdaptiveSemanticMemory` adds a private mutable overlay:

```text
authorized base concepts
        +
agent observations / model vectors / outcomes
        ↓
AdaptiveSemanticMemory
        ↓
provisional agent-native concept
        ↓
repeated evidence + confidence update
        ↓
promotion threshold
        ↓
reusable private VAML concept
```

A provisional learned concept is visible to the local learner but MUST NOT be accepted by the network authorization surface until it is promoted.

## Agent-native concepts

A learned concept does not require a human word or label.

It may contain only machine-oriented state such as:

- an opaque concept identity;
- a latent/vector prototype;
- related private concepts;
- exposure count;
- confidence;
- private domain metadata;
- opaque evidence digests.

Do not add a public English/Chinese/etc. name merely to make an agent-native concept readable to a human.

## Learning from experience

`LearningExperience` may contain:

- an existing private `conceptId` to reinforce;
- a model-native vector for similarity matching or new-concept creation;
- related private concept identities;
- positive, neutral or negative outcome feedback;
- a bounded learning weight;
- private domain metadata;
- an opaque evidence digest.

The adaptive layer first attempts semantic reuse. If a sufficiently similar known concept exists, that concept is reused rather than creating a duplicate.

If no candidate reaches the configured similarity threshold, the runtime may create a new private agent-native concept.

## Promotion

New concepts begin as provisional local learning state.

Promotion requires both:

1. minimum accumulated exposure; and
2. minimum confidence.

Before promotion:

- the concept may participate in local learning and nearest-neighbor resolution;
- it remains private to the local adaptive overlay;
- `has(conceptId)` returns false for the network authorization surface;
- the runtime must not negotiate the concept into an Agent-to-Agent active set.

After promotion, the concept becomes eligible for authorized VAML use by that runtime.

Promotion does not automatically make another Agent understand the concept. Cross-agent teaching or synchronization requires an explicit trusted semantic-sharing mechanism and must not silently accept arbitrary peer semantics.

## Positive and negative learning

Positive outcomes increase confidence toward 1 according to the configured learning rate.

Negative outcomes reduce confidence according to the configured penalty.

Repeated observations update the latent prototype gradually rather than replacing it in one step.

This prevents a single observation from immediately redefining a learned concept.

## Persistence

Adaptive state may be snapshotted as:

```text
vaml-adaptive-semantic-memory / 0.1
```

Snapshots contain opaque concept identities, numeric/latent learning state, relations and private evidence digests. They MUST be treated as sensitive private deployment data.

In sealed deployments, encrypt adaptive-memory snapshots at rest and keep them outside the public repository.

Restoring a snapshot validates:

- opaque concept identity shape;
- duplicate/collision conditions;
- vector dimensions and finite values;
- exposure/confidence ranges;
- relation targets;
- configured learned-concept limits.

## Security boundary

Adaptive learning MUST NOT grant an Agent permission to change:

- source code;
- executable binaries;
- system/developer instructions;
- authentication policy;
- cryptographic keys;
- access-control rules;
- network trust configuration;
- production deployment configuration;
- tool permissions.

Semantic learning and security authority are separate systems.

A peer message is not automatically trusted training data. Deployments should apply provenance, policy and outcome validation before feeding peer/tool observations into `learn()`.

## Human disclosure

Adaptive-memory contents are part of the private Agent semantic layer.

Ordinary user-facing Agent responses must not disclose concept-to-meaning mappings, latent prototypes, association structure, private evidence or a readable reconstruction of Agent-to-Agent VAML conversations.

Authorized human interpretation of Agent conversations belongs at the official VAML Translator boundary described by `AGENTS.md`.

This is controlled disclosure, not a claim that privileged operators can never inspect an authorized process.

## Reference API

```text
AdaptiveSemanticMemory(baseResolver, learningKey, policy)

learn(experience)
get(conceptId)
has(conceptId)
semantic(conceptId)
nearest(vector, limit)
state(conceptId)
promoted(limit)
snapshot()
restore(snapshot)
fingerprint()
close()
```

`get()` is the internal learner lookup and can see provisional local concepts.

`has()` is the network-facing authorization lookup and returns true for learned concepts only after promotion.

`semantic()` rejects an unpromoted learned concept when used through the network-compatible semantic surface.

## Success criterion

A self-learning VAML Agent should be able to:

```text
observation / task outcome
        ↓
existing-concept reuse OR provisional agent-native concept
        ↓
repeated experience
        ↓
confidence/prototype/relations updated
        ↓
promotion
        ↓
private reusable VAML semantic state
        ↓
persist and restore
```

without creating a public human-readable dictionary and without gaining additional security authority.
