# Research: Acurast official docs (collected 2026-07-31)

Source-anchored facts for the article. Every claim carries its official URL.
Flags at the bottom mark what must NOT be claimed.

## 1. What Acurast is

- "Acurast is a decentralized cloud compute network powered by smartphones. Developers deploy serverless workloads - REST APIs, webhooks, scheduled jobs, LLM inference, confidential computation - to a global pool of smartphone processors that execute the code inside hardware-backed Trusted Execution Environments (TEEs)." — https://docs.acurast.com/ (FAQ)
- "250,000+ compute units worldwide, making it the most decentralized verifiable compute network available today." — https://docs.acurast.com/ (accessed 2026-07-31; older FAQ page says 227,181 on incentivized testnet)
- Differentiator vs other DePIN: "Most DePIN networks coordinate hardware… without verifying what runs on it. Acurast uses smartphone TEEs to **prove** that the deployed code ran unmodified, on genuine hardware, with confidential inputs the device owner cannot inspect." — https://docs.acurast.com/
- Why phones: built-in TEEs + HSMs "offer a higher level of security than servers ever can"; 1.39 billion phones sold annually, 2.75-year replacement cycle — https://acurast.com/why-mobile/ and https://docs.acurast.com/faq#why-is-acurast-using-mobile-phones

## 2. The Processor (phones as nodes)

- "The Acurast processor is the app that is running on smartphones which take part in the Acurast Decentralized Compute Network." — https://docs.acurast.com/processors/acurast-processors
- Two tiers (same page):
  - **Processor Lite** — everyday phone, computes during "edge-times (like while you sleep and charge)", isolated Android Work Profile, Android 12+ (non-rooted, locked bootloader) or iPhone 6S+/iOS 15+.
  - **Processor Core** — Android only, dedicated device, factory reset, fully locked down, 24/7. "Developers often prefer Core devices for longer-running, critical deployments."
- Old-phone framing (official): "If you have a phone that you don't need any more for anything else, go with Core." — https://docs.acurast.com/faq#what-is-the-difference-between-acurast-processor-core-and-lite
- "Acurast leverages the security features of the smartphone to turn the device into an independent and completely locked compute unit, offering the highest level of security against bad actors with physical access." — https://acurast.com/why-mobile/
- Onboarding: install app → connect wallet at https://hub.acurast.com/ → (Core) factory reset, pair, lock down — https://docs.acurast.com/processors/become-compute-provider

## 3. Enclave / TEE (naming + hardware)

- Current official name: **Acurast Secure Hardware Runtime (ASHR)**. Whitepaper: **Acurast Trusted Execution Environment (ATEE)**. Older pallet README: "Acurast Trusted Virtual Machine". Use **ASHR**.
- NOT TrustZone/SGX: "Arguably, TEEs, such as Intel SGX or ARM TrustZone, implemented on the main application processor, are insecure, particularly when considering side-channel attacks. For that reason, ASHR is based on the bleeding edge of a dedicated coprocessor… The current ASHR implementation is based on coprocessors provided by the Google Titan chip." — https://docs.acurast.com/acurast-protocol/architecture/execution-layer
- Whitepaper: Titan M2 "is a standalone processor with separate flash memory and minimal OS… these so-called coprocessors do not share memory or cache"; on Snapdragon SoCs, QSEE is used — https://arxiv.org/html/2503.15654v2
- Key never leaves hardware: "the processor is generating an asymmetric key pair… whereas the private key of that pair is remaining in the dedicated secure element" — whitepaper §Processor Attestation
- Second runtime: **Acurast Zero-Knowledge Runtime (AZKR)**, ZK-based alternative trust model — https://docs.acurast.com/acurast-protocol/architecture/execution-layer#acurast-zero-knowledge-runtime

## 4. Attestation

- Processor generates keypair in secure element; "pk is signed and sent to the Attestation service, where the trust root of the respective TEE can be verified (e.g., **Google as a trust root for Titan M2**)" — whitepaper §Processor Attestation, https://arxiv.org/html/2503.15654v2
- Attestation service is **enshrined in the consensus layer** (on-chain): stores signed public keys and revocations; updated when a certificate is revoked — https://arxiv.org/abs/2503.15654
- Remote attestation binds code to key: "cryptographically links the binary hash of the executable e… with the secret key sk_p, remaining securely in the ATEE… The chain of trust is cryptographically verifiable from the executable e to the original hardware manufacturer." — whitepaper §Attestation Service
- Matching gated on attestation: "Only devices with valid attestations can then be matched with deployments… attestations also include… the specific model of the hardware security module… allowing the developer to choose the level of security they require."
- On-chain mechanics: extrinsic `submitAttestation` takes a valid **attestation certificate chain**; `updateCertificateRevocationList`; job flag `allowOnlyVerifiedSources` — https://github.com/Acurast/acurast-core/blob/main/pallets/acurast/README.md
- OEM certification framing: "Acurast requires the security chip to create the official hardware certification – issued by the Original Equipment Manufacturer (OEM)." — https://acurast.com/why-mobile/

## 5. Deployments, jobs, and signing keys

- Deployment = instructions + schedule + destination; lifecycle OPEN → MATCHED → ASSIGNED → DONE — https://docs.acurast.com/acurast-protocol/architecture/architecture and https://docs.acurast.com/acurast-protocol/architecture/end-to-end
- **Per-deployment keys** (whitepaper, verbatim): "a specific NodeJS deployment d receives its individual key pair (sk_d, pk_d) linked to the code of the deployment itself. So, if the NodeJS code is changed, access to the key pair is lost forever, and only the said deployment can effectively sign payloads with that sk. This allows an external party to deduce that if a specific cryptographic signature is linked to a remotely attested key pair, this signature could only be a result of the execution of that specific set of instructions, offering an end-to-end verifiable execution environment." — https://arxiv.org/html/2503.15654v2
- "The respective key pair can only be accessed by that specific executable e; if e is tampered with or deleted, the access to sk is lost."
- Runtime APIs: `_STD_.signers.secp256r1.sign(payload)` signs with the key "generated for the current deployment"; `_STD_.job.getPublicKeys()` — https://docs.acurast.com/developers/build/nodejs-runtime-environment ; per-processor keys per curve (p256, secp256k1, ed25519) via `deployment_assignedProcessors` — https://docs.acurast.com/developers/build/cargo-runtime-environment
- Processors sign `fulfill` extrinsics with P256 (secp256r1) — https://github.com/Acurast/acurast-core/blob/main/pallets/acurast/README.md

## 6. Trust model

- "The deployment of TEE reduces the trust assumptions to (i) cryptographic hardness assumptions and (ii) a single root of trust (i.e., secure hardware with key attestation and an external coprocessor)." — whitepaper
- Device owner NOT trusted: TEEs "maintain confidentiality **without requiring trust in the device owner**" — https://docs.acurast.com/ ; "confidential inputs the device owner cannot inspect"
- "removing the trust required in third parties, and reducing them to cryptographic hardness assumptions" — whitepaper abstract
- Composable trust: choose public / known / own processors — https://docs.acurast.com/acurast-protocol/architecture/execution-layer
- Reliability: reputation engine + NPoS consensus with slashing — https://docs.acurast.com/acurast-protocol/architecture/consensus-layer

## 7. Whitepaper reference

- Killer, De Carli, Brun, Charlé, Godenzi, Wehrli — "Acurast: Decentralized Serverless Cloud", arXiv:2503.15654 [cs.CR], v2 Jan 8 2026. https://arxiv.org/abs/2503.15654 · https://doi.org/10.48550/arXiv.2503.15654
- MiCA whitepaper (ACU token, Feb 21 2025): https://docsend.com/view/vxyaenm9z2mfghg9
- Docs index of whitepapers: https://docs.acurast.com/acurast-protocol/whitepapers · Audits: https://docs.acurast.com/acurast-protocol/audits

## MUST-NOT-CLAIM flags

- Do NOT write "Acurast uses ARM TrustZone" or "StrongBox" or "Android Keystore" — official sources position ASHR on dedicated coprocessors (Titan M2, QSEE) and explicitly criticize TrustZone/SGX.
- Do NOT use the exact phrase "Android Key Attestation verified on-chain" as an Acurast quote; documented facts: `submitAttestation` takes an "attestation certificate chain", and "Google as a trust root" (whitepaper). Describe carefully.
- Compute-unit numbers vary by page; cite the docs home figure with access date.
