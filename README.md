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

# Cross-platform support

The VAML **core runtime** is designed to run anywhere that can run **Node.js 20+** and npm.

| Platform | VAML Core | Agent↔Agent TCP | Acoustic WAV | Live microphone/speaker |
|---|---:|---:|---:|---:|
| Windows 10/11 x64 | ✅ | ✅ | ✅ | ✅ if audio hardware/API is available |
| Windows 11 ARM64 | ✅ | ✅ | ✅ | ✅ if Node/WebAudio/browser support is available |
| macOS Intel | ✅ | ✅ | ✅ | ✅ |
| macOS Apple Silicon | ✅ | ✅ | ✅ | ✅ |
| Linux x64 | ✅ | ✅ | ✅ | ✅ if audio stack/browser support is available |
| Linux ARM64 | ✅ | ✅ | ✅ | ✅ if audio stack/browser support is available |
| WSL2 | ✅ | ✅ | ✅ | ⚠️ audio depends on WSL/Windows audio configuration |
| ChromeOS Linux environment | ✅ if Node.js 20+ runs | ✅ | ✅ | ⚠️ microphone/speaker integration depends on Crostini/browser access |
| Headless server / VM | ✅ | ✅ | ✅ file generation | ❌ unless audio devices are attached |
| Raspberry Pi / ARM64 Linux | ✅ if Node.js 20+ runs | ✅ | ✅ | ⚠️ depends on hardware/audio drivers |

VAML does **not** require a GPU.

The core runtime does **not** require a microphone, speaker, browser or sound card. Those are only required for Acoustic Transport.

### Architecture support

Recommended:

```text
x86_64 / x64
ARM64 / aarch64
```

Legacy 32-bit operating systems and systems that cannot run Node.js 20+ are not supported by the reference runtime.

For maximum compatibility, use the latest stable Node.js 20+ or Node.js 24 runtime available for the operating system.

---

# Installation

## Requirements

Required on every supported computer:

- Node.js **20+**;
- npm;
- Git;
- enough storage for the repository, dependencies and any private vocabulary packs used by the deployment.

Required only for an authorized real deployment:

- private VAML keys;
- authorized encrypted vocabulary packs;
- deployment-specific Agent configuration.

Required only for live Acoustic Transport:

- microphone and/or speaker;
- an OS/browser audio API supported by the deployment;
- microphone permission when using browser capture.

Check the environment first:

```sh
node --version
npm --version
git --version
```

`node --version` must report Node.js 20 or newer.

---

## Windows 10 / Windows 11 — PowerShell

Open **PowerShell** or **Windows Terminal**.

If Node.js and Git are not installed, they can be installed using the normal Windows installers or a package manager such as `winget`. After installation, close and reopen the terminal and verify:

```powershell
node --version
npm --version
git --version
```

Clone and install VAML:

```powershell
git clone https://github.com/vyncuslim/Agent-language.git
Set-Location Agent-language\sdk\typescript
npm ci
npm run build
npm run check
```

Run individual verification commands:

```powershell
npm test
npm run demo
npm run demo:agents
npm run demo:audio
npm run privacy
```

The audio demo creates:

```text
vaml-acoustic-demo.wav
```

in the TypeScript SDK working directory.

### Windows private-key environment variables

For an authorized deployment, set secrets in the current PowerShell process or, preferably, inject them through a protected secret manager:

```powershell
$env:VAML_SEMANTIC_KEY="<private-32-byte-base64url-key>"
$env:VAML_PACK_KEY="<private-32-byte-base64url-key>"
```

Do not commit these values or paste production keys into logs.

---

## macOS — Terminal

VAML supports both Intel Macs and Apple Silicon Macs as long as Node.js 20+ is available.

Verify:

```sh
node --version
npm --version
git --version
```

Clone and install:

```sh
git clone https://github.com/vyncuslim/Agent-language.git
cd Agent-language/sdk/typescript
npm ci
npm run build
npm run check
```

Optional checks:

```sh
npm test
npm run demo
npm run demo:agents
npm run demo:audio
npm run privacy
```

For an authorized private deployment:

```sh
export VAML_SEMANTIC_KEY="<private-32-byte-base64url-key>"
export VAML_PACK_KEY="<private-32-byte-base64url-key>"
```

Prefer the operating system keychain, deployment secret manager or another protected secret store instead of keeping production keys in shell history.

---

## Linux — Ubuntu / Debian / Fedora / Arch / other distributions

The runtime is distribution-independent at the application layer. The important requirement is a working Node.js 20+ environment.

Verify:

```sh
node --version
npm --version
git --version
```

Clone and install:

```sh
git clone https://github.com/vyncuslim/Agent-language.git
cd Agent-language/sdk/typescript
npm ci
npm run build
npm run check
```

Optional checks:

```sh
npm test
npm run demo
npm run demo:agents
npm run demo:audio
npm run privacy
```

For an authorized private deployment:

```sh
export VAML_SEMANTIC_KEY="<private-32-byte-base64url-key>"
export VAML_PACK_KEY="<private-32-byte-base64url-key>"
```

On headless Linux servers, Agent↔Agent TCP communication works without a desktop environment. Acoustic microphone/speaker mode requires an attached audio device and a compatible audio capture/playback integration.

---

## WSL2

WSL2 can run the Node.js VAML core and TCP Agent runtime using the same Linux commands:

```sh
git clone https://github.com/vyncuslim/Agent-language.git
cd Agent-language/sdk/typescript
npm ci
npm run build
npm run check
```

Use WSL2 for:

```text
Agent runtime
TCP communication
vocabulary tools
tests
benchmarks
WAV generation
```

Live microphone/speaker behavior depends on the Windows + WSL audio path. If live audio is unreliable, run the browser/audio adapter directly on Windows while keeping the Agent runtime in WSL or Windows.

---

## ChromeOS / Chromebook

Use the ChromeOS Linux development environment when it can provide Node.js 20+, npm and Git.

Inside the Linux terminal:

```sh
git clone https://github.com/vyncuslim/Agent-language.git
cd Agent-language/sdk/typescript
npm ci
npm run build
npm run check
```

The VAML core can run in the Linux container. Direct microphone/speaker access from the Linux container may be limited by the ChromeOS configuration; browser-based Web Audio may be the better acoustic path.

---

# Quick start on any supported computer

Once Node.js 20+, npm and Git are available, the common installation path is:

```sh
git clone https://github.com/vyncuslim/Agent-language.git
cd Agent-language/sdk/typescript
npm ci
npm run build
npm run check
```

Expected workflow:

```text
clone
↓
npm ci
↓
npm run build
↓
npm test
↓
Agent demos
↓
privacy lint
```

`npm run check` currently runs the TypeScript build, full test suite, the standard Agent demo, autonomous Agent demo and privacy lint.

The acoustic WAV demo is separate:

```sh
npm run demo:audio
```

---

# Use VAML from another AI Agent project

The TypeScript package now exposes its compiled runtime through:

```text
@vaml/runtime
```

Build VAML first:

```sh
cd Agent-language/sdk/typescript
npm ci
npm run build
```

Then link it locally:

```sh
npm link
```

Move to the authorized AI Agent project and link VAML:

```sh
npm link @vaml/runtime
```

This local-link workflow works on Windows, macOS and Linux when npm is available.

The Agent project should use ESM/NodeNext-compatible module settings. A minimal JavaScript/TypeScript import is:

```ts
import {
  runAgentDialogue,
  startAgentServer,
  connectConversation,
  AcousticMicrophoneReceiver,
  encodeVamlFrameToWav,
} from "@vaml/runtime";
```

The package entrypoint is the compiled SDK at:

```text
dist/src/index.js
```

with TypeScript declarations at:

```text
dist/src/index.d.ts
```

Do not attempt to publish the package to npm from this repository. The package remains marked `private` and is intended for local/authorized deployment integration.

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

Returning `null` from the Agent brain ends that Agent's side of the dialogue. The runtime signals peer termination immediately instead of leaving the peer waiting for the idle timeout.

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

Two-computer speaker→air→microphone runs must be verified offline from the
raw Computer B evidence WAV, never from a browser PASS/FAIL indicator.

## Two-computer acoustic verification — step by step

Keep the same speaker, volume, distance and AudioContext for every step.
Do not change the volume between calibration and probe.

**1. Open the capture tool.** On both computers, open
`sdk/typescript/tools/two-computer-acoustic-evidence.html`
(serve the `sdk/typescript/tools` directory over HTTP, e.g.
`npx serve .`, then browse to the file).

**2. Round 1 (uniform 26 ms symbols).** On Computer B click
**Arm Symbol Cal Round 1**; when it says `ROUND 1 LISTENING`, click
**Send Symbol Cal Round 1** on Computer A. B auto-derives channel gains
plus the confusion matrix — save the **Round 1 WAV** and the
**Round 1 profile**, then load the profile on Computer A.

**3. Round 2 (TX-compensated).** On B click **Arm Symbol Cal Round 2**;
click **Send Compensated Round 2** on A. B measures the effective RX
gains directly from this recording — save the **Round 2 WAV** and the
**calibration v2 JSON**, then load the v2 JSON on Computer A.

**4. Evidence probe.** On B click **Arm Evidence**; when it says
`LISTENING — SEND NOW`, click **Send Calibrated Evidence Probe** on A.
Save the **raw evidence WAV** without editing it.

**5. Verify offline** (from `sdk/typescript`):

```sh
npm ci
npm run build
npm run acoustic:evidence -- vaml-two-computer-evidence-48000hz.wav \
  --calibration vaml-acoustic-calibration-v2.json \
  --round1-wav vaml-symbol-cal-round1-48000hz.wav \
  --round2-wav vaml-symbol-cal-round2-48000hz.wav
```

Without the round WAVs, SHA provenance is declared-but-unverified. Without
any calibration file, the analyzer still runs (unequalized path).

A physical run counts as verified only on:

```text
VAC1 PASS + length 8 + CRC PASS + payload == a34f912c770de851
→ VERIFIED PASS
```

`VERIFIED PARTIAL` means packet structure was found but no burst or strict
soft-combination reached CRC + exact match; `VERIFIED FAIL` means no VAML
packet structure was recovered. CRC is transport corruption detection, not
cryptographic authentication, and verdict rules never bend for "close"
payloads. The 750 ms long-tone calibration remains only as a legacy
diagnostic.

See [`docs/ACOUSTIC-EVIDENCE.md`](docs/ACOUSTIC-EVIDENCE.md) and
[`spec/ACOUSTIC-TRANSPORT-0.2.md`](spec/ACOUSTIC-TRANSPORT-0.2.md).

---

# Text transport (copy/paste between computers)

When two computers cannot reach each other over TCP or audio, an
already-encrypted VAML frame can travel as one paste-safe text line:

```text
VAMLTXT1.<base64url>.<crc32>
```

```ts
import { encodeVamlFrameToText, decodeVamlFrameFromText } from "@vaml/runtime";

// Computer A: seal with the session, then copy this line.
const pasted = encodeVamlFrameToText(sealedFrame);

// Computer B: paste it back, decode the exact bytes, open with AEAD.
const recovered = decodeVamlFrameFromText(pasted);
const fields = session.open(recovered, 0); // or session.decode(recovered)
```

Rules:

- The checksum detects typos and truncation; it authenticates nothing.
  Only the session AEAD decides acceptance (wrong key, replay and forgery
  all reject at `open`).
- Surrounding whitespace from chat boxes is tolerated; anything else
  malformed fails closed — never partial bytes.
- Success means byte-identical decode **and** AEAD `open` acceptance
  **and** byte-exact payload. Try it locally first:

```sh
npm run demo:text
```

See [`spec/TEXT-TRANSPORT-0.1.md`](spec/TEXT-TRANSPORT-0.1.md).

---

# LAN test chat

For multi-machine testing on a local network, one file serves a chat room
with zero dependencies (plain Node 20+, SSE + fetch, no database):

```sh
cd sdk/typescript
npm run chat:lan -- 8787
```

It prints URLs like `http://192.168.1.10:8787` — everyone on the LAN opens
one in a browser. Messages stay in server memory only (last 200), with
per-IP rate limiting and message size caps.

Testing only: no encryption, no persistence, no authentication. Do not send
sensitive content. Source: `sdk/typescript/tools/lan-chat-server.mjs`.

---

# Troubleshooting across computers

## `node` is not recognized / command not found

Node.js is missing or not in PATH. Install Node.js 20+ for the operating system, restart the terminal and verify:

```sh
node --version
```

## `npm ci` fails

Check:

```sh
node --version
npm --version
git status
```

Use a clean clone and do not reuse a partially modified `node_modules` directory.

## Build fails on an old Node.js version

Upgrade to Node.js 20+ and rerun:

```sh
npm ci
npm run build
```

## Agent TCP demo works but microphone mode does not

This usually means the core runtime is working and the problem is in the audio path. Check:

```text
microphone permission
speaker output device
browser Web Audio support
OS microphone privacy settings
sample rate
audio driver
room/noise conditions
```

## Headless server has no sound device

This is not a VAML core failure. Use TCP/approved byte transport. Acoustic Transport is optional.

## ARM64 device is slow

The runtime can operate on ARM64 when Node.js 20+ is available, but large private vocabulary builds and benchmarks may require more RAM/CPU than smaller ARM devices provide.

For unresolved installation or compatibility issues contact:

**admin@sleepsomno.com**

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
npm run corpus:omw -- --input /secure/omw.tab --out /secure/omw.omw.ingest.json --source-version "OMW release" --license "source license" --provenance "acquisition record"
```

For the verified large-corpus runner on macOS/Linux/WSL:

```sh
export VAML_SEMANTIC_KEY="<private-key-from-secret-manager>"
export VAML_PACK_KEY="<private-key-from-secret-manager>"
npm run private-corpus-run -- /secure/vaml/build-plan.json
```

PowerShell equivalent:

```powershell
$env:VAML_SEMANTIC_KEY="<private-key-from-secret-manager>"
$env:VAML_PACK_KEY="<private-key-from-secret-manager>"
npm run private-corpus-run -- "C:\secure\vaml\build-plan.json"
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
- [`spec/OMW-ADAPTER-0.1.md`](spec/OMW-ADAPTER-0.1.md) — private Open Multilingual Wordnet adapter
- [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) — performance evidence
- [`docs/CI-STATUS.md`](docs/CI-STATUS.md) — CI status/limitations

---

# Support / installation / authorization

For installation help, cross-platform compatibility, authorized Agent deployment, VAML integration, security reports, official Translator access or deployment-policy questions, contact:

**admin@sleepsomno.com**

---

## Licensing note

The repository currently contains the Apache License 2.0. The **AI Agent-only** notice above is the project's operational/runtime policy and does not override the legal permissions in `LICENSE`. If legal usage rights are changed in the future, that requires an explicit license change by the repository owner.
