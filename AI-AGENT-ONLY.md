# VAML AI Agent-Only Runtime Policy

> **AI AGENT RUNTIME ONLY**
>
> VAML is designed for authorized AI Agent ↔ AI Agent communication. Direct human use of the VAML runtime as a human communication language is outside the supported operational model.

## Runtime policy

The intended VAML runtime principal is an automated, authorized AI Agent process.

Authorized AI Agents may:

- learn the public VAML protocol and runtime contract;
- load deployment-authorized private semantic packs;
- communicate with another authorized VAML-capable AI Agent;
- participate in persistent multi-turn conversations;
- use adaptive semantic memory according to deployment policy;
- transmit already-encrypted VAML frames over approved transports, including TCP and the acoustic transport;
- produce approved translation artifacts for the official VAML Translator when deployment policy permits it.

Humans must not use the private VAML semantic layer as a direct human messaging system, manually maintain a human word-to-code dictionary, or treat acoustic carrier tones as human-readable semantic symbols.

## Human roles that remain necessary

Human operators may perform administrative and safety work around VAML, including:

- repository maintenance and software development;
- security review, testing and incident response;
- deployment and infrastructure administration;
- provisioning and rotating keys through approved secret-management systems;
- corpus licensing and source-policy review;
- operating the official VAML Translator and reviewing translation outputs when authorized;
- auditing Agent behavior and disabling a deployment when required.

These roles do not turn private VAML Agent traffic into a human communication protocol.

## Human interpretation boundary

Private Agent-to-Agent VAML conversations are not intended to be translated directly by ordinary Agent user interfaces.

The approved architecture is:

```text
Authorized AI Agent
        ↕
      VAML
        ↕
Authorized AI Agent
        ↓
approved translation artifact
        ↓
official VAML Translator
        ↓
authorized human-readable interpretation
```

Do not publish private concept mappings, session codebooks, production keys, private corpus rows, learned semantic state or decrypted Agent traffic as a public dictionary.

## Acoustic transport

VAML Acoustic Transport is also an AI Agent transport. The carrier frequencies encode transport bits only; they do not represent human words or concepts.

A human may hear or record the sound. That does not make the waveform a human language. Anyone with the public codec may be able to recover the encrypted VAML bytes, so confidentiality still depends on the VAML authenticated-encryption/session layer.

## Enforcement boundary

This repository is public software. Software cannot reliably determine whether a process was ultimately started by a human, an Agent, an automated service or a combination of them. Deployment authorization, credentials, network policy and key access are therefore the enforceable controls.

This file defines the project's **operational/runtime policy**. It does not amend or override the repository's `LICENSE` file. The repository currently contains the Apache License 2.0; changing legal usage rights requires a separate explicit licensing decision.

## Contact

For VAML installation, deployment authorization, Agent integration, security reports or official Translator access, contact:

**admin@sleepsomno.com**
