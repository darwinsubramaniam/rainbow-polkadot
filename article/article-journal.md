# Article Journal — "How Rainbow Was Really Built"

Working folder for the article explaining the Rainbow project truthfully, for a general
audience, with graphical diagrams and research-paper anchoring of the proof methods.

**Core framing (agreed 2026-07-31):** the game is NOT the proof-of-concept. The backend —
Polkadot Product + Acurast enclave verification — is the POC. The game exists only to make
the concept visible. The pattern generalizes to other use cases.

**Audience & aim (Darwin, 2026-07-31):** this is a CAPABILITY story, not a development
tutorial. The point is to let people know that such a system is *possible today* and was
*made real* on the Polkadot Product devnet + Acurast. No build steps, no code walkthroughs —
readers who want the "how" get a link to the GitHub repo. Every section should answer
"what is now possible and why can you trust it", not "how do I do this". Technical detail
appears only where it earns trust (e.g. the proof chain), always in plain language.

## Files in this folder

| File | Purpose |
|---|---|
| `article-journal.md` | this file — what is done, what needs improving, per round |
| `draft-outline.md` | the article skeleton: sections, key claims, diagram list |
| `references/` | downloaded research papers + `references.md` table with URLs |
| `article.md` | the article itself (starts round 2) |

## Planned structure (from Darwin's brief)

1. What a Polkadot Product is
2. Acurast — the network and the phone processors
3. The Enclave (anchored on official Acurast docs)
4. How Polkadot Product + Acurast were combined to build the platform game
   — make clear: the backend is the POC, the game is the demonstration
5. How the smart contract trusts the client's handover of a signed message
   from the Acurast phone (explained simply)
6. Limitations (today) — to be expanded in a later round

Diagrams: graphical, designed in Figma first
(https://www.figma.com/design/1NQStUOSQZ86KzLiYswPd5/Untitled). Anything Figma can't do
well gets a full image-AI prompt for Darwin to run instead.

---

## Round log (newest first)

### Round 2 — 2026-07-31 — decisions locked + first Figma diagrams

**Decisions (Darwin):** outline approved · publication = **Medium** · title direction =
"A New Polkadot Product (Devnet) Capability: Your Phone as the Backend Server" ·
tunnel described generically (no vendor names).

**Done:**
- Figma page "Article Diagrams" created in the target file
  (figma.com/design/1NQStUOSQZ86KzLiYswPd5).
- **D5 "The journey of one run"** (centerpiece) built and verified: serpentine 6-step
  flow (1→2→3 / 4→5→6), trust-zone colors (amber = player/browser untrusted,
  teal = phone enclave, violet = contract), dark indigo editorial style. Node `3:2`.
- **D1 "Four actors — and no company"** built and verified: four cards, same language.
  Node `5:2`.
- Style system established: dark bg #14162B, card #1E2140, Inter, zone-colored
  strokes/badges — reuse for D2, D3, D4, D6, D7.

**Feedback applied (Darwin, 2026-07-31):** "phone enclave" was being read as the
*player's* phone. Renamed the trust zone to **"Acurast cloud phone"** in D5 (legend,
zone labels, card 3+4 bodies) and D1 (card heading, tagline, body); wording now says
"someone else's phone, not yours". Recorded as a standing terminology rule in
draft-outline.md — applies to all remaining diagrams and all prose.

**Image workflow (established when Darwin delivered images/D5.png):**
Figma blueprint (content + layout, by Claude) → Darwin enhances with image AI →
final PNG lands in `article/images/Dx.png` → the article embeds ONLY the enhanced
PNGs from `images/`. Darwin's D5.png confirmed the approach: same text and structure,
richly illustrated (gamepad, Acurast rack, sealed chip, PROVED magnifier).

**Diagram inventory (all blueprints built in Figma, page "Article Diagrams"):**
| # | Title | Figma node | Enhanced PNG |
|---|---|---|---|
| D1 | Four actors — and no company | `5:2` | pending |
| D2 | An app with no server | `10:2` | pending |
| D3 | The cloud in a drawer — Acurast | `10:38` | pending |
| D4 | The key ceremony | `11:2` | pending |
| D5 | The journey of one run | `3:2` | ✅ images/D5.png |
| D6 | Three cheats, three failures | `11:32` | ✅ built with red CHEAT badges + colored WALL chips |
| D7 | Not a game — a pattern | `12:2` | pending |

**Also done this round:** full first draft of the article written → `article.md`
(~2,000 words, all 9 sections, 13 numbered references + background refs, images
embedded as `images/Dx.png`). Title nuance: used "**a** Phone as the Backend Server"
(not "your") to respect the Acurast-cloud-phone terminology rule.

**To improve / next round:**
- Darwin: enhance D1–D4, D6, D7 the same way as D5.png (export each Figma frame as
  the base). Drop results into `article/images/` with matching names.
- Darwin: fill the one `TODO` in article.md — the public repo URL (I did not want to
  guess whether the repo is public and under which org).
- Claude: revision pass on the draft after Darwin's read (tone, length, accuracy);
  then Medium formatting notes (where to place captions, pull-quotes).

### Round 1 — 2026-07-31 — research + draft outline ✅ COMPLETE

**Done:**
- Pulled ground truth from the Darwin Knowledge vault (architecture, EIP-712 domain
  binding, rulesHash, verifier key mechanics, eth_getLogs blindness, sandbox probes).
- Codebase mapped with file:line evidence → `research/rainbow-codebase-map.md`.
  Key truths: NO Merkle/hash-chaining anywhere — the proof is deterministic replay +
  one EIP-712 secp256k1 signature; no score is ever sent to the enclave (no field for
  it); rulesHash = keccak256 of the wasm the enclave actually loaded; the repo itself
  says "the game is a strawman".
- Acurast official docs researched → `research/acurast-docs-research.md`.
  ASHR runs on dedicated coprocessors (Titan M2 / QSEE), NOT TrustZone — docs
  explicitly criticize TrustZone/SGX. Whitepaper (arXiv:2503.15654) documents
  per-deployment keys: change the code, the key is lost forever. Must-not-claim flags
  recorded.
- 18 research papers downloaded + verified → `references/` + `references.md` table.
  Star anchors: Bethea-Cochran-Reiter NDSS 2010 (replay-verify game clients — almost
  exactly our method), BlackMirror CCS 2020 (TEE anti-cheat), Schneier-Kelsey 1999
  (untrusted-machine logs as evidence), EIP-712, SEC 2 secp256k1, Walfish-Blumberg
  2015 + Ben-Sasson 2014 (why TEE replay beats ZK pragmatically today).
- Draft outline written → `draft-outline.md`: 9 sections, ~3,300 words target,
  7 Figma diagrams planned (D1–D7) with a shared trust-zone color language, 3 image-AI
  prompts (P1–P3) ready for Darwin.

**To improve / next round (round 2):**
- ~~AWAITING DARWIN~~ → ANSWERED 2026-07-31: outline approved; target **Medium**;
  title direction **"Polkadot Product (Devnet) capability — Phone as backend server"**;
  tunnel stays **generic** (no vendor name).
- Round 2 now: design D1–D7 in Figma (D5 centerpiece first), iterate.
- Then: write prose sections 0–3.

**Notes:**
- DKG memory node was unreachable this session; vault + project memory used instead.

**Correction (2026-07-31, from Darwin):** an agent pass misreported
`onlyAttestedDevices` as `false`. The config (`e2e/acurast-verifier/acurast.json:46`)
is **`true`** — the deployment requires attested devices. Removed from the Limitations
section and from all research files. (Local CLI deploy records under
`.acurast/deploy/*.json` show `false` for jobs 380396–380406 — treated as CLI-side
records, not the source of truth per Darwin.)
