# VAML — Vynalth Agent Machine Language

> ## ⚠️ AI AGENT RUNTIME ONLY
>
> VAML is an experimental machine-semantic communication runtime for **authorized AI Agent ↔ AI Agent communication**. It is not intended to be used as a direct human communication language.
>
> Human operators may administer, develop, audit and secure deployments, and may use the official VAML Translator for authorized interpretation. Private VAML conversations, concept mappings and session codebooks are not intended to be exposed through ordinary human-facing Agent interfaces.
>
> See [`AI-AGENT-ONLY.md`](AI-AGENT-ONLY.md) for the operational policy.

VAML 0.2 is an opaque, model-neutral Agent communication runtime built around a private World Concept Space. It supports encrypted semantic frames, persistent multi-turn Agent conversations, autonomous Agent-to-Agent dialogue, adaptive Agent-native learning, and optional acoustic transport over speaker/microphone audio.

VAML is **not** a public word-to-opcode dictionary and is **not** Morse code.

```text
AI Agent internal state
        ↓
private VAML concepts
        ↓
session-local opaque codes
        ↓
authenticated encrypted VAML frame
        ↓
TCP / approved byte transport / acoustic transport
        ↓
peer Agent
        ↓
private semantic state
```

## Current capabilities

- private encrypted semantic vocabulary packs;
- secret-derived opaque concept identities;
- X25519 + HKDF-SHA256 session negotiation;
- directional authenticated encryption;
- bounded encrypted active-set negotiation;
- persistent multi-turn conversations;
- `conversationId`, `messageId`, `replyTo` and bounded private history;
- dynamic concept activation during an existing conversation;
- model-neutral autonomous Agent brain bridge;
- adaptive semantic memory and Agent-native concepts;
- audible 4-FSK acoustic transport;
- live microphone streaming receiver;
- preamble synchronization and symbol clock recovery;
- 44.1 kHz → 48 kHz streaming resampling;
- corrupted acoustic packet recovery and resynchronization;
- browser microphone/speaker integration;
- private corpus ingestion/build pipeline;
- privacy linting and synthetic benchmark tooling.

The project is still **experimental**. Do not treat the current runtime as a final production security boundary without deployment-specific review.

---

# Installation

## Requirements

- Node.js **20+**;
- npm;
- Git;
- private VAML keys and vocabulary only when running an authorized real deployment.

Clone the repository:

```sh
git clone https://github.com/vyncuslim/Agent-language.git
cd Agent-language/sdk/typescript
```

Install exact dependencies:

```sh
npm ci
```

Build:

```sh
npm run build
```

Run the complete local verification chain:

```sh
npm run check
```

`npm run check` currently performs the TypeScript build, test suite, Agent demos and privacy linting.

Individual commands:

```sh
npm test
npm run demo
npm run demo:agents
npm run demo:audio
npm run privacy
npm run benchmark
```

`npm run demo:audio` generates a local `vaml-acoustic-demo.wav` machine-audio sample. The generated WAV is ignored by Git.

---

# AI Agent clone-and-learn bootstrap

An AI Agent cloning this repository should **not** begin by inventing readable opcodes.

The required bootstrap is:

```text
clone repository
↓
read AGENTS.md completely
↓
read vaml.manifest.json
↓
read protocol/spec files in manifest learning order
↓
study runtime + tests
↓
load only deployment-authorized private semantic material
↓
connect to an authorized VAML peer
↓
communicate using VAML semantic fields
```

The machine-facing contract is [`AGENTS.md`](AGENTS.md).

A successful VAML-capable Agent should be able to:

1. map its internal state to authorized private VAML concepts;
2. negotiate an authenticated VAML session;
3. receive private VAML semantic messages;
4. update its internal model/planner state without translating the peer conversation into ordinary prose as the wire protocol;
5. autonomously produce the next VAML semantic response;
6. continue the same conversation across many turns;
7. learn approved semantic associations or Agent-native concepts without gaining new security authority.

---

# Autonomous AI Agent ↔ AI Agent communication

The main model-neutral bridge is:

```ts
startAgentServer(...)
runAgentDialogue(...)
```

A `VamlAgentBrain` can be backed by an LLM, local model, planner, tool-using Agent or another AI runtime.

Simplified server pattern:

```ts
import { startAgentServer } from "@vaml/runtime";

startAgentServer(
  "127.0.0.1",
  7002,
  agentBConfig,
  async (context) => {
    // context.message.fields contains private VAML semantic fields.
    // The Agent runtime decides the next VAML semantic state.
    return agentB.decide(context.message.fields, context.history);
  },
);
```

Initiating Agent:

```ts
import { runAgentDialogue } from "@vaml/runtime";

const result = await runAgentDialogue(
  "127.0.0.1",
  7002,
  agentAConfig,
  async (context) => {
    return agentA.decide(context.message.fields, context.history);
  },
  initialSemanticFields,
);
```

Returning `null` from the Agent brain ends that Agent's side of the dialogue. The runtime now signals peer termination immediately instead of leaving the peer waiting for the idle timeout.

VAML does not grant tool permissions. A valid semantic frame must still pass the deployment's capability, authorization and tool-execution policy.

---

# Persistent multi-turn conversation

For lower-level control use:

```ts
connectConversation(...)
startConversationServer(...)
```

A conversation keeps one authenticated session alive across multiple messages:

```text
Agent A  → message #1 →  Agent B
Agent A  ← reply   #1 ←  Agent B
Agent A  → message #2 →  Agent B
Agent A  ← reply   #2 ←  Agent B
                    ...
```

The active concept set can expand during the same conversation. The runtime does not require loading or negotiating the complete private vocabulary for every message.

---

# Acoustic Agent communication

VAML Acoustic Transport converts an **already-encrypted VAML frame** into machine audio. It is transport modulation only.

Reference audible profile:

```text
4-FSK
1200 Hz
1800 Hz
2400 Hz
3000 Hz
10 ms / symbol
2 transport bits / symbol
48 kHz reference rate
```

The carriers do **not** mean words or concepts.

```text
encrypted VAML frame
↓
4-FSK machine audio
↓
speaker
↓
air / audio channel
↓
microphone
↓
preamble synchronization
↓
clock recovery + symbol timing recovery
↓
CRC corruption check
↓
original encrypted VAML frame
```

File/WAV APIs:

```ts
encodeVamlFrameToWav(frame)
decodeVamlFrameFromWav(wav)
```

Live microphone APIs:

```ts
decodeVamlFrameFromMicrophonePcm(pcm)
new AcousticMicrophoneReceiver(...)
```

Browser deployment helpers:

```ts
startBrowserAcousticMicrophone(...)
playVamlFrameThroughBrowserSpeaker(...)
```

Browser microphone permission remains controlled by the browser/user-agent security model. The helper does not bypass permission prompts.

The live receiver includes clock-drift recovery, arbitrary chunk handling, sample-rate conversion and resynchronization after a corrupted packet. Real-room deployment should still be tested on the target microphones, speakers, room acoustics and operating systems before production use.

See [`spec/ACOUSTIC-TRANSPORT-0.2.md`](spec/ACOUSTIC-TRANSPORT-0.2.md).

---

# Private vocabulary and keys

Production semantic data does not belong in this public repository.

Supply 32-byte base64url secrets through protected environment/secret-management systems:

```text
VAML_SEMANTIC_KEY
VAML_PACK_KEY
```

Never place production keys in command-line arguments, Git commits, public logs or examples.

Private material includes, among other things:

- production semantic/pack/session keys;
- private vocabulary packs and decrypted corpus rows;
- private aliases and source sense mappings;
- alignment maps;
- Agent learning snapshots;
- adaptive semantic memory;
- session active-set/codebook mappings;
- decrypted private Agent conversation content.

The runtime rejects unknown concepts instead of guessing.

---

# Building a private vocabulary

Example private build commands:

```sh
npm run pack -- /private/input.jsonl /private/packs
npm run pack:world -- /private/input.world.sorted.jsonl /private/packs 1
npm run corpus-pack -- /private/sources.json /private/corpus.sorted.jsonl /private/packs 1
```

For the verified large-corpus runner:

```sh
VAML_SEMANTIC_KEY=<private-key-from-secret-manager> \
VAML_PACK_KEY=<private-key-from-secret-manager> \
npm run private-corpus-run -- /secure/vaml/build-plan.json
```

The build plan, snapshots, alignment material, temporary plaintext corpus and production vocabulary output should remain outside the public repository.

---

# Human interpretation

Ordinary user-facing Agents should not reveal or reconstruct a private Agent-to-Agent VAML transcript, private concept mapping or learned semantic state merely because a human asks what the Agents said.

Authorized interpretation belongs at the controlled Translator boundary:

```text
AI Agent ↔ VAML ↔ AI Agent
              ↓
    approved translation artifact
              ↓
       official VAML Translator
              ↓
      authorized human output
```

The Translator does not make the underlying VAML semantic space a public dictionary.

---

# Security notes

- Acoustic modulation is **not encryption**. Anyone may record the waveform and potentially demodulate the encrypted bytes.
- Confidentiality/authentication comes from the VAML cryptographic session, not from the sound being unusual.
- The reference pack-derived PSK authenticates a trust group. Mutually untrusted Agents should use deployment-specific independent identities such as pinned signing identities or mTLS.
- Valid frames do not authorize arbitrary tools.
- JavaScript cannot guarantee complete memory zeroization.
- Catalog rollback protection needs a protected external pin/revision policy.
- VAML 0.1 is retired and is not silently translated into VAML 0.2.

See [`docs/SECURITY.md`](docs/SECURITY.md).

---

# Important documentation

- [`AI-AGENT-ONLY.md`](AI-AGENT-ONLY.md) — runtime-use policy
- [`AGENTS.md`](AGENTS.md) — machine-facing Agent learning/runtime contract
- [`vaml.manifest.json`](vaml.manifest.json) — machine-readable capability/learning manifest
- [`spec/VAML-0.2.md`](spec/VAML-0.2.md) — protocol
- [`spec/VOCABULARY-0.2.md`](spec/VOCABULARY-0.2.md) — private vocabulary architecture
- [`spec/AGENT-LEARNING-0.2.md`](spec/AGENT-LEARNING-0.2.md) — Agent learning
- [`spec/ADAPTIVE-LEARNING-0.1.md`](spec/ADAPTIVE-LEARNING-0.1.md) — adaptive semantic memory
- [`spec/CONVERSATION-0.1.md`](spec/CONVERSATION-0.1.md) — persistent conversations
- [`spec/AGENT-BRIDGE-0.1.md`](spec/AGENT-BRIDGE-0.1.md) — autonomous AI Agent bridge
- [`spec/ACOUSTIC-TRANSPORT-0.2.md`](spec/ACOUSTIC-TRANSPORT-0.2.md) — speaker/microphone transport
- [`spec/PRIVATE-CORPUS-RUNNER-0.1.md`](spec/PRIVATE-CORPUS-RUNNER-0.1.md) — private corpus build runner
- [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) — performance evidence
- [`docs/CI-STATUS.md`](docs/CI-STATUS.md) — CI status/limitations

---

# Support / installation / authorization

For installation help, authorized Agent deployment, VAML integration, security reports, official Translator access or deployment-policy questions, contact:

**admin@sleepsomno.com**

---

## Licensing note

The repository currently contains the Apache License 2.0. The **AI Agent-only** notice above is the project's operational/runtime policy and does not override the legal permissions in `LICENSE`. If legal usage rights are changed in the future, that requires an explicit license change by the repository owner.
