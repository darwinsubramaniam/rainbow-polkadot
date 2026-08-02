# Reference table — research backing for Rainbow's proof methods

18 verified PDFs live in this directory; 2 RFCs saved as canonical `.txt` (PDF renders are
bot-blocked — manual browser URLs below). Collected 2026-07-31.

## How each family maps to Rainbow

- **A. Attestation** → why the chain can believe a key lives in real secure hardware
- **B. TEE foundations** → what "runs in an enclave" precisely means, and honest limits
- **C. Tamper-evident logs** → why a game event log can serve as checkable evidence
- **D. Signatures** → the math the contract's `ecrecover`-style check rests on
- **E. Verifiable computation & games** → the direct precedent for "replay the log in a
  trusted place, sign a verdict" and why it beats the alternatives pragmatically

## A. Hardware key attestation / remote attestation

| Reference | Why relevant | Canonical URL | Local file |
|---|---|---|---|
| Google, "Verify hardware-backed key pairs with Key Attestation" (Android docs, living) | The device-level mechanism family behind Acurast's attestation certificate chain rooted at Google | https://developer.android.com/privacy-and-security/security-key-attestation | — (web doc, cite URL) |
| Cooijmans, de Ruiter, Poll — "Analysis of Secure Key Storage Solutions on Android", ACM SPSM 2014 | Peer-reviewed analysis of Android hardware-backed key storage guarantees | https://dl.acm.org/doi/10.1145/2666620.2666627 | `cooijmans-etal-2014-android-secure-key-storage.pdf` |
| Pinto, Santos — "Demystifying Arm TrustZone", ACM Comput. Surv. 2019 | Survey of ARM secure-world isolation (background; note: Acurast's ASHR uses dedicated coprocessors, not TrustZone) | https://dl.acm.org/doi/10.1145/3291047 | `pinto-santos-2019-demystifying-arm-trustzone.pdf` |
| Coker et al. — "Principles of Remote Attestation", IJIS 2011 | Foundational principles: how a remote party can trust a device's claim about itself | https://link.springer.com/article/10.1007/s10207-011-0124-7 | `coker-etal-2011-principles-of-remote-attestation.pdf` |
| Costan, Devadas — "Intel SGX Explained", IACR ePrint 2016/086 | Standard reference for enclave remote attestation; comparison point for the ASHR design | https://eprint.iacr.org/2016/086 | `costan-devadas-2016-intel-sgx-explained.pdf` |

## B. Trusted Execution Environments

| Reference | Why relevant | Canonical URL | Local file |
|---|---|---|---|
| Sabt, Achemlal, Bouabdallah — "TEE: What It Is, and What It Is Not", IEEE TrustCom 2015 | The accepted academic definition of a TEE | https://ieeexplore.ieee.org/document/7345265 | `sabt-etal-2015-tee-what-it-is-what-it-is-not.pdf` |
| Cerdeira et al. — "SoK: Vulnerabilities in TrustZone-assisted TEE Systems", IEEE S&P 2020 | Honest-limitations source: real TEE vulnerabilities — for the Limitations section | https://ieeexplore.ieee.org/document/9152801 | `cerdeira-etal-2020-sok-trustzone-tee-vulnerabilities.pdf` |
| Ménétrey et al. — "Attestation Mechanisms for TEEs Demystified", DAIS 2022 | Recent comparative survey across SGX/TrustZone/SEV/RISC-V attestation | https://arxiv.org/abs/2206.03780 | `menetrey-etal-2022-tee-attestation-demystified.pdf` |

## C. Tamper-evident / secure audit logs

| Reference | Why relevant | Canonical URL | Local file |
|---|---|---|---|
| Schneier, Kelsey — "Secure Audit Logs to Support Computer Forensics", ACM TISSEC 1999 | Founding paper: logs from an untrusted machine as later-checkable evidence | https://www.schneier.com/academic/archives/1999/05/secure_audit_logs_to.html | `schneier-kelsey-1999-secure-audit-logs.pdf` |
| Crosby, Wallach — "Efficient Data Structures for Tamper-Evident Logging", USENIX Sec 2009 | Modern standard for auditable append-only event logs | https://www.usenix.org/legacy/event/sec09/tech/full_papers/crosby.pdf | `crosby-wallach-2009-tamper-evident-logging.pdf` |
| Merkle — "A Certified Digital Signature", CRYPTO 1989 (ms. 1979) | Origin of the Merkle hash tree; commit to a whole log with one hash (scan — no text layer) | https://link.springer.com/chapter/10.1007/0-387-34805-0_21 | `merkle-1979-certified-digital-signature.pdf` |
| Laurie, Langley, Kasper — "Certificate Transparency", RFC 6962, 2013 | Internet-scale precedent: log + independent verifier + signed statement | https://www.rfc-editor.org/rfc/rfc6962 | `rfc6962.txt` (PDF manually: https://datatracker.ietf.org/doc/pdf/rfc6962) |

## D. Digital signatures

| Reference | Why relevant | Canonical URL | Local file |
|---|---|---|---|
| Certicom — "SEC 2: Recommended EC Domain Parameters" v2.0, 2010 | Normative definition of secp256k1 — the curve of Rainbow's verifier signature | https://www.secg.org/sec2-v2.pdf | `secg-2010-sec2-v2-secp256k1.pdf` |
| Johnson, Menezes, Vanstone — "ECDSA", IJIS 2001 | Peer-reviewed security treatment of ECDSA itself | https://link.springer.com/article/10.1007/s102070100002 | `johnson-menezes-vanstone-2001-ecdsa.pdf` |
| Bernstein et al. — "High-speed high-security signatures" (Ed25519), CHES 2011 | Basis of Substrate ed25519 accounts | https://ed25519.cr.yp.to/ | `bernstein-etal-2011-ed25519-high-speed-signatures.pdf` |
| Schnorr — "Efficient Signature Generation by Smart Cards", J. Cryptology 1991 | Scheme behind sr25519; historically apt — signing inside a constrained secure element | https://link.springer.com/article/10.1007/BF00196725 | `schnorr-1991-efficient-signatures-smart-cards.pdf` |
| Josefsson, Liusvaara — "EdDSA", RFC 8032, 2017 | Standardization of Ed25519 | https://www.rfc-editor.org/rfc/rfc8032 | `rfc8032.txt` (PDF manually: https://datatracker.ietf.org/doc/pdf/rfc8032) |

## E. Verifiable computation / untrusted game clients

| Reference | Why relevant | Canonical URL | Local file |
|---|---|---|---|
| **Bethea, Cochran, Reiter — "Server-side Verification of Client Behavior in Online Games", NDSS 2010** | **Closest academic precedent to Rainbow's core method: client submits action log; trusted party verifies it corresponds to legal game execution** | https://www.ndss-symposium.org/ndss2010/server-side-verification-client-behavior-online-games/ | `bethea-cochran-reiter-2010-server-side-verification-online-games.pdf` |
| Park, Ahmad, Lee — "BlackMirror: Preventing Wallhacks in 3D Online FPS Games", ACM CCS 2020 | Peer-reviewed TEE-based game anti-cheat — precedent for TEE trust anchoring in games | https://dl.acm.org/doi/10.1145/3372297.3417890 | `park-etal-2020-blackmirror-sgx-game-cheat-prevention.pdf` |
| Walfish, Blumberg — "Verifying computations without reexecuting them", CACM 2015 | Survey framing the design space; positions TEE-attested re-execution as the pragmatic middle | https://cacm.acm.org/research/verifying-computations-without-reexecuting-them/ | `walfish-blumberg-2015-verifying-computations-cacm.pdf` (arXiv version) |
| Ben-Sasson et al. — "Succinct Non-Interactive Zero Knowledge for a von Neumann Architecture", USENIX Sec 2014 | The zk-SNARK comparison point: why TEE-signed replay is cheaper/simpler than ZK proofs today | https://eprint.iacr.org/2013/879 | `bensasson-etal-2013-zksnarks-von-neumann.pdf` |

## Plus the project-specific primary sources

| Reference | Why relevant | URL |
|---|---|---|
| Killer et al. — "Acurast: Decentralized Serverless Cloud", arXiv:2503.15654 (v2, Jan 2026) | The Acurast whitepaper: per-deployment keys bound to code, on-chain attestation service, coprocessor-based ASHR | https://arxiv.org/abs/2503.15654 |
| Acurast pallet README (`submitAttestation`, certificate chain, `allowOnlyVerifiedSources`) | On-chain attestation mechanics | https://github.com/Acurast/acurast-core/blob/main/pallets/acurast/README.md |
| EIP-712 — "Typed structured data hashing and signing" | The domain-bound signature format the Leaderboard contract verifies | https://eips.ethereum.org/EIPS/eip-712 |

## Citation caveats

- Costan–Devadas: cite ePrint 2016/086 (local file is the identical MIT-hosted copy).
- Walfish–Blumberg: cite CACM 2015 (local file is arXiv:1308.4149 version).
- Merkle 1979 file is the author-hosted typeset manuscript (scan; no text layer).
- Android Key Attestation is a living web document — include access date when citing.
