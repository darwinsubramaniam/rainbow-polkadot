# A New Polkadot Product Capability: Your Phone as the Backend

*An app distributed by a blockchain. A smartphone providing verifiable computation. A smart contract acting as the judge.*

A small game called **Rainbow** brings all three together.

---

## The idea

Every application needs somewhere to live and somewhere to compute.

Traditionally, that means servers: a company hosts the application, operates the infrastructure, and performs the computation. Users trust that infrastructure because there has rarely been another practical option.

Two pieces of infrastructure change that model:

* **Polkadot Product** lets applications be published to and distributed from a blockchain rather than a conventional web server.
* **Acurast** provides decentralized compute using smartphones, with secure hardware and attestation allowing computation to be verified.

Put them together and a new architecture emerges:

> **The blockchain distributes the application. A phone performs the computation. A smart contract verifies the result.**

Rainbow is a small demonstration of that architecture.

---

## 1. An application with no web server

A **Polkadot Product** is an application whose files are published onto the **Bulletin chain** and resolved through a human-readable `.dot` name.

Instead of:

**Domain → DNS → Web server → Application**

the path becomes:

**`.dot` name → DotNS → content hash → Bulletin chain → application**

The user's device retrieves the application from the chain's network and executes it inside a sandbox.

There is no conventional web server or CDN serving the application.

### The host is part of the security model

Products do not operate as unrestricted web pages.

The application itself does not hold wallet keys or establish direct blockchain connections. Instead, those capabilities are provided by the host application — **Polkadot Desktop** or the mobile Polkadot applications — and exposed to the Product according to the user's permissions.

This creates a useful separation:

**Product**
→ requests capabilities

**Host**
→ controls capabilities

**User**
→ approves them

Signing, storage, notifications, camera access and networking can therefore be treated as explicit capabilities rather than privileges automatically granted to the application.

The Product itself remains isolated from the underlying wallet keys.

---

## 2. `.dot` is an identity, not just a name

There is an important distinction between naming an application and registering its identity.

A `.dot` name is registered through **DotNS**, which operates through a smart contract on Polkadot's Asset Hub.

Publishing a Product therefore happens in two stages:

1. Register the `.dot` name.
2. Publish the application and associate its content with that name.

For example:

`rainbow-dev.dot`

The name remains the application's on-chain identity while its content can be updated by linking it to a new published version.

The registered name also participates in the application's account identity. The host derives an account for the Product and user combination, which is particularly useful for applications such as leaderboards.

This detail matters in practice: an application cannot simply invent a `.dot` name at runtime and expect the host to resolve it. The name must already exist.

---

## 3. The Polkadot Product Devnet

The **Polkadot Product Devnet** is not simply a mock environment.

It provides the components required to test the complete publishing flow:

* a name registry,
* a Bulletin chain for application content,
* an Asset Hub for contracts,
* test tokens and development resources.

The important property is that the entire path is real.

A name resolves to real content.
The content is retrieved from the chain.
The host loads it.
The application interacts with contracts.

That makes the Devnet useful for testing a capability that is difficult to reproduce with conventional unit tests: **end-to-end decentralized application distribution.**

One practical lesson from development is that the Devnet environment is its own ecosystem. Its Bulletin chain is separate from other environments such as Paseo. Pointing a Product at the wrong chain may not produce an obvious error; the expected content simply will not be there.

So when this article says *devnet*, it means:

> **Real publishing and real execution, without production stakes.**

---

## 4. The browser is part of the infrastructure

If there is no web server, what opens the application?

The answer is the **Polkadot host**.

Polkadot Desktop and the mobile applications can be understood as specialized browsers for blockchain-hosted applications.

The model looks familiar:

| Traditional web     | Polkadot Product        |
| ------------------- | ----------------------- |
| URL                 | `.dot` name             |
| DNS                 | DotNS                   |
| Web server/CDN      | Bulletin chain          |
| Browser             | Polkadot host           |
| Website permissions | Product capabilities    |
| Wallet integration  | Host-controlled signing |

The important difference is how content is identified.

Traditional DNS ultimately resolves a name toward a network location. DotNS resolves the Product name to a **content hash**, allowing the application to be identified by its content rather than simply by the server hosting it.

The Bulletin chain can then provide that content through its network.

The host also provides the security boundary. A Product is designed to run inside a host container rather than behaving like an unrestricted standalone application.

The open-source implementations include:

* Polkadot Desktop
* Polkadot Android
* Polkadot iOS

The repositories and SDK documentation describe the host model directly.

---

## 5. A cloud inside a phone

Removing the application server solves only half of the problem.

A browser is still an untrusted environment. The user controls the device running it, and therefore cannot be expected to honestly report the result of a computation performed locally.

This is where **Acurast** enters.

Acurast is a decentralized compute network in which smartphones act as compute processors. A deployment can specify code and execution requirements, and the network can assign that workload to a participating device.

Instead of a centralized data center, computation is performed by devices distributed across the network.

The crucial property is not simply that the computation happens on another phone.

It is that the computation can produce **verifiable evidence of what ran**.

---

## 6. Why the phone can be trusted

Acurast's architecture combines three security mechanisms.

### 1. The key is generated inside secure hardware

The processor's secure hardware generates a signing key internally.

The private key does not need to be exposed to the application, the network operator, or the device owner.

In Acurast's current implementation, this relies on dedicated secure hardware such as Google's Titan-class security hardware.

### 2. The key is bound to the deployment

Acurast associates a deployment's key pair with the code being executed.

That creates an important property:

> **Change the deployment code, and the associated identity changes.**

The Rainbow implementation tested this directly: byte-identical deployments retained the same key, while changing the code caused the key to rotate.

A signature can therefore be associated not merely with *a device*, but with the particular computation that the device was authorized to perform.

### 3. The hardware can be attested

Before computation is assigned, the device provides an attestation chain establishing that it is running on genuine supported hardware and software.

The chain can be checked and revocations can be recorded.

This is **remote attestation**: the system obtains cryptographic evidence about the environment in which a computation is running.

Together, the mechanisms provide the foundation for the system's central claim:

> **A valid result signature can be tied to specific code executing on genuine attested hardware.**

---

## 7. Rainbow: a game designed to prove the architecture

Rainbow is deliberately simple.

You play a platformer, finish a run, and receive a score.

The interesting part is not the game.

The interesting part is that the browser does **not** determine the score.

Instead, the browser records the player's actions and sends those inputs to an Acurast verifier.

The verifier runs the game again.

Because the game is deterministic, the same inputs must produce the same result.

The architecture becomes:

**Player**
→ plays the game

**Polkadot Product**
→ records inputs

**Acurast processor**
→ replays inputs and calculates the result

**Smart contract**
→ verifies the signed result

The developers describe the game itself as a strawman: it exists to make the underlying infrastructure visible.

---

## 8. Making the game deterministic

This approach depends on one critical property:

> **The same inputs must always produce the same output.**

That is harder than it sounds.

Floating-point calculations can produce different results across environments, which is unacceptable when one machine needs to reproduce another machine's execution exactly.

Rainbow therefore uses fixed-point arithmetic.

The team tested the compiled module across multiple execution environments and compared the simulation tick by tick across many seeds.

The result was deterministic execution across the tested environments.

That allows the browser to be treated as an untrusted client.

---

## 9. The browser never sends a score

This is one of the strongest aspects of the design.

During the game, the Product records:

* which inputs occurred,
* and when they occurred.

It does **not** send the claimed score.

At the end of the run:

1. The input log is sent to the Acurast verifier.
2. The verifier loads the pinned game binary.
3. The verifier replays the inputs.
4. The verifier calculates the score independently.
5. The result is signed by the deployment's key.
6. The signed result is returned to the client.
7. The client submits the proof to the leaderboard contract.

The client can therefore lie about what score it achieved, but that lie is irrelevant.

The contract never needs to trust the client's score.

---

## 10. Pinning the exact rules

There is another potential attack:

What if the verifier runs a modified version of the game?

Rainbow addresses this by fingerprinting the game binary.

The leaderboard contract stores a **Keccak-256 fingerprint** of the expected game binary.

The verifier fingerprints the binary it actually loads.

The fingerprints must match.

This creates two independent checks:

**Did the player provide legitimate inputs?**

→ The verifier replays them.

**Did the verifier use the correct game?**

→ The binary fingerprints must match.

---

## 11. The sealed result

The verifier does not need to communicate directly with the leaderboard.

Instead, it gives the result back to the least trusted participant in the system: **the player**.

Think of the result as a sealed envelope.

It contains information such as:

* player identity,
* game identity,
* session,
* score,
* rules fingerprint,
* expiration time.

The verifier signs the complete structure using **EIP-712 typed structured data**.

The signature is also bound to the intended contract and chain, preventing the proof from simply being replayed somewhere else.

The player can transport the proof, store it, or discard it.

But changing its contents invalidates the signature.

---

## 12. The contract becomes the judge

When the wallet submits the proof, the leaderboard contract checks the result.

Conceptually, the checklist is:

1. Has the proof expired?
2. Is the session within the allowed limit?
3. Has this session already been used?
4. Does the game fingerprint match?
5. Does the signature recover to the registered verifier key?

The verifier key is not invented after the result is produced. It is registered as part of the deployment and recorded by the Acurast system.

If the checks pass, the contract accepts the score.

This creates a clean trust boundary:

**The player provides the proof.**

**The verifier produces the proof.**

**The contract decides whether the proof is valid.**

---

## 13. Three attacks, three different walls

The architecture is easier to understand by looking at what happens when someone cheats.

### Modify the input log

The verifier does not trust the original score.

It replays the modified inputs.

The resulting score is therefore the score those inputs actually produce.

### Forge the result

The contract verifies the signature.

A forged signature does not recover to the registered verifier key.

### Replay an old result

Each session can be consumed only once.

Submitting the same proof again therefore fails.

The security does not depend on one enormous mechanism. Different attacks encounter different verification boundaries.

---

## 14. Why not zero-knowledge proofs?

Zero-knowledge proofs could, in principle, provide another way to prove that a computation was performed correctly.

But there is an engineering trade-off.

Proving a complex, continuously running game execution in zero knowledge can be computationally expensive.

Replaying the same deterministic computation inside attested hardware is considerably more practical for this type of workload.

Rainbow therefore demonstrates a different point in the design space:

> **Use secure hardware to execute and attest the computation, then use cryptographic signatures and a smart contract to verify the result.**

It is not the only possible solution.

It is a pragmatic one.

---

## 15. The game is only the demonstration

Remove the platformer and the architecture remains.

The general pattern is:

> **A client records an activity. An independently operated phone deterministically re-executes it. Secure hardware ties the execution to the expected code. The result is signed. A smart contract verifies the signature.**

That pattern does not inherently belong to games.

The same architecture could be applied to workloads such as:

* sensor readings,
* verifiable random draws,
* examination or assessment results,
* model inference,
* computation where the client should not be trusted to report the result.

The verifier can remain largely application-agnostic while the executable module changes.

That is the real capability being demonstrated.

---

## 16. What has actually been demonstrated?

The experiment combines two capabilities that normally live in very different parts of the stack.

### Polkadot Product

Provides:

**Decentralized application distribution**

The application does not require a conventional web host to deliver its frontend.

### Acurast

Provides:

**Decentralized, attestable computation**

The backend computation can execute on a smartphone and produce cryptographic evidence associated with its code and hardware.

### Smart contract

Provides:

**Public verification**

The final decision can be made by deterministic contract logic rather than by trusting the application developer, server operator, or client.

Together:

**Blockchain-hosted application**
→ **untrusted client activity**
→ **attested smartphone computation**
→ **cryptographic proof**
→ **on-chain verification**

That is the product capability.

Rainbow is simply the easiest way to see it working.

---

## 17. What this does not prove yet

A good proof-of-concept should also be clear about its limitations.

### Verification is not yet decentralized

The current demonstration uses a single Acurast verifier selected by the development team.

The compute infrastructure is decentralized, but the demonstration does not yet establish a decentralized set of independent verifiers.

### The network path can still censor

The verifier is accessed through a tunnel provider.

A tunnel operator could delay or block communication.

It cannot silently modify an authenticated result without invalidating the signature.

### Verifier registration has an administrative trust point

The current contract uses an owner account to determine which verifier keys are accepted.

Compromising that authority would therefore be significant.

### It proves execution, not player identity

The system can establish that the recorded inputs produced the claimed result under the expected rules.

It does not establish that the inputs came from a human.

Bots, automation and multiple accounts remain outside the demonstrated security model.

### Secure hardware is not magic

Trusted execution environments have a long security history, but they are not infallible.

The trust model ultimately depends on the security of the underlying hardware, firmware and attestation infrastructure.

### It is still a Devnet

This is a proof-of-concept running in a development environment.

That is a feature, not a weakness: it provides a place to demonstrate the complete architecture before production stakes are introduced.

---

## 18. The bigger picture

The most interesting part of this experiment is not that a game can have a tamper-resistant leaderboard.

It is that the traditional application stack can be split across decentralized infrastructure.

Instead of:

**Company**
→ **Web server**
→ **Backend**
→ **Database**
→ **Trust the operator**

the model can become:

**Blockchain**
→ distributes the application

**User device**
→ provides the interface

**Acurast processor**
→ performs verifiable computation

**Smart contract**
→ enforces the rules

The result is not simply a decentralized frontend or a decentralized cloud.

It is a system in which **distribution, computation and verification can each have independent trust boundaries**.

That is what makes the experiment interesting.

---

## 19. Where to look next

Everything in the demonstration should ultimately be verifiable from the implementation, deployment records and supporting documentation.

The project repository:

**TODO: repo URL**

The Product host implementations are also open source:

* Polkadot Desktop
* Polkadot Android
* Polkadot iOS

These repositories provide the implementation details behind the host, resolution and sandboxing model rather than requiring the architecture to be accepted on faith.

---

## References

1. Sabt, Achemlal, Bouabdallah — *Trusted Execution Environment: What It Is, and What It Is Not*, IEEE TrustCom 2015.
2. Killer, De Carli, Brun, Charlé, Godenzi, Wehrli — *Acurast: Decentralized Serverless Cloud*, arXiv:2503.15654 (v2, Jan 2026).
3. Acurast pallet documentation — `submitAttestation` / attestation certificate chains.
4. Coker, Guttman, Loscocco et al. — *Principles of Remote Attestation*, International Journal of Information Security, 2011.
5. Ménétrey et al. — *Attestation Mechanisms for Trusted Execution Environments Demystified*, DAIS 2022.
6. Bethea, Cochran, Reiter — *Server-side Verification of Client Behavior in Online Games*, NDSS 2010.
7. Park, Ahmad, Lee — *BlackMirror: Preventing Wallhacks in 3D Online FPS Games*, ACM CCS 2020.
8. EIP-712 — *Typed structured data hashing and signing*.
9. Johnson, Menezes, Vanstone — *The Elliptic Curve Digital Signature Algorithm (ECDSA)*, IJIS 2001.
10. Certicom Research — *SEC 2: Recommended Elliptic Curve Domain Parameters*, 2010.
11. Walfish, Blumberg — *Verifying computations without reexecuting them*, Communications of the ACM, 2015.
12. Ben-Sasson, Chiesa, Tromer, Virza — *Succinct Non-Interactive Zero Knowledge for a von Neumann Architecture*, USENIX Security 2014.
13. Cerdeira, Santos, Fonseca, Pinto — *SoK: Understanding the Prevailing Security Vulnerabilities in TrustZone-assisted TEE Systems*, IEEE S&P 2020.

Additional background: Schneier & Kelsey on tamper-evident audit logs; Crosby & Wallach on tamper-evident logging; Android Key Attestation documentation; Acurast documentation.
