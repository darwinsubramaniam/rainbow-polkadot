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

### Round 7 — 2026-08-09 — Darwin's rewrite replaces article.md wholesale

**Darwin supplied a full replacement draft and asked for it verbatim.** Written in as
given, no edits. It supersedes rounds 2–6 as the article's text (those rounds' *facts*
survive in it; their prose does not).

**What changed in character:** long-form narrative → numbered technical explainer, 19
sections, short declarative paragraphs, plain "application/computation" register instead
of the earlier voice. Rainbow now appears from §7, with §1–§6 covering Product, `.dot`
identity, Devnet, host-as-browser, Acurast, and the enclave — the ingredients-first order
agreed in round 5, kept.

**Facts from earlier rounds that the new draft preserves:** two-stage publishing (register
the name, then publish and associate content) from round 6; the host-as-specialised-browser
mapping table from round 4; DotNS resolving to a **content hash** rather than a location
from round 4's correction; devnet-is-its-own-ecosystem; no-score-is-ever-sent; the
keccak-256 rules pin; EIP-712 domain binding; all 13 references.

**Regression to resolve — every diagram embed is gone.** The draft carries no images, so
D1–D10 are no longer referenced anywhere. The Figma page and `images/` are untouched and
still current; the diagrams simply need re-placing into the new section numbering. Best
fits, when Darwin wants them back:
| Diagram | Section |
|---|---|
| D2 — An app with no server | §1 |
| D8 — What is the Product Devnet | §3 |
| D10 — A browser for chain-hosted apps | §4 (its table duplicates §4's table — pick one) |
| D9 — What is Acurast | §5 |
| D4 — The key ceremony | §6 |
| D1 — Four actors | §7 |
| D5 — The journey of one run | §9 |
| D6 — Three cheats, three failures | §13 |
| D7 — Not a game, a pattern | §15 |
| D3 — Cloud in a drawer | §5, if §5 wants a second image |

**Two other open items in the new text:**
- The three host repos are listed by name without URLs in §4 and §19. The verified links
  are in round 4 above.
- `**TODO: repo URL**` in §19 still needs the project's own repository.

**Terminology conflict, flagged for Darwin's decision.** The new title is *"Your Phone as
the Backend"*. Round 2 deliberately chose "**a** Phone as the Backend Server" over "your",
because Darwin's own round-2 feedback was that readers were misreading the verifying phone
as the *player's* phone — which is what produced the standing "Acurast cloud phone"
naming rule. §5 and §15 of the new draft do say the computation happens on another,
independently operated phone, so the body is unambiguous; only the title reads as "your
phone does the backend work". Left exactly as written pending Darwin's call.

### Round 6 — 2026-08-09 — correction: how a name actually becomes an identity

**Wrong claim, flagged by Darwin:** the article said *"the app's on-chain account is
mathematically derived from the name string itself… rename the app and you have created a
different identity."* That skipped the registration entirely and implied a `.dot` name is
free text you pick at build time.

**The actual order:**
1. **Register the name in DotNS** — it lives in a smart contract on Polkadot's Asset Hub.
   From that moment the name is owned on chain.
2. **Upload the application to the Bulletin chain and link it to the registered name.**
   Claim the address, then put something at it; shipping a new version relinks the same
   name to new content.
3. The host then derives the app's account **from the registered name**, one account per
   app *and* per user (`ProductAccountId = (DotNsIdentifier, DerivationIndex)`).

The war story still holds and is now told against the right mechanism — an early build
passed `dappName: "Rainbow"`, the SDK appended `.dot` and asked the host to derive
`Rainbow.dot`, which nobody had registered; the host refused, **and the refusal resolved
as an empty account list rather than an error** (`app/src/chain/wallet.ts:29-42`).

**Fixed in three places:** `article.md` (the paragraph rewritten into two — registration,
then upload-and-link), `draft-outline.md` §1 (the original source of the bad sentence,
now carrying an explicit do-not-write note), and **D2 in Figma**, whose step order was
wrong for the same reason.

**D2 rebuilt (node `10:2`)** — steps now follow the real publishing sequence:
| # | Was | Now |
|---|---|---|
| 1 | Bulletin chain — "Published once" | **DotNS name — "Register the name first"** |
| 2 | Polkadot app — "Loaded from the chain" | **Bulletin chain — "Upload, and link it"** |
| 3 | Host wallet — "The wallet is lent" | Polkadot app — "Loaded from the chain" |
| 4 | DotNS name — "The name is the identity" *(wrong)* | Host wallet — "The wallet is lent" |

Accents were remapped so colour now means something: the two chain-side steps are violet,
the two host-side steps amber. Subtitle de-Rainbowed to "How a Product gets published —
and how it reaches someone", per round 5's restructure.

**Still pending:** `images/D2.png` deliberately not exported — D2 is one of the six
diagrams awaiting Darwin's image-AI pass, and its blueprint has just changed, so it should
be enhanced from the corrected Figma frame rather than half-filled with a raw export.

### Round 5 — 2026-08-09 — restructured: ingredients first, game last

**Feedback (Darwin):** "I don't like the article structure — first explain the Polkadot
Product, then what is Acurast, then later come to the Rainbow." This restores the
original brief in *Planned structure* above, which rounds 2–4 had drifted from by opening
on the game.

**Decisions (Darwin, asked before rewriting):**
- Opening = **"Two ingredients, then the dish"** — frame both technologies as the
  subject, name Rainbow once as a forward reference, then leave it alone.
- Title = **unchanged**; standfirst retuned so it no longer opens on "a browser game".

**New order:**
| # | Section | Role |
|---|---|---|
| 1 | Two ingredients | frames both, no game content |
| 2 | An app with no server | **Polkadot Product** |
| 3 | And the "devnet" in the title | Devnet (D8) |
| 4 | The browser you have not heard of | the hosts (D10) |
| 5 | The cloud in a drawer | **Acurast** (D9, D3) |
| 6 | The vault inside the phone | the enclave (D4) |
| 7 | The dish — a game that cannot lie | **Rainbow starts** (D1) |
| 8 | Assembling the machine | determinism + replay (D5) |
| 9 | The sealed envelope | EIP-712 handover (D6) |
| 10 | Not a game — a pattern | generalization (D7) |
| 11–12 | Limitations · Want the details? | unchanged |

**What moved, and the de-Rainbowing that came with it:**
- The old hook "The score that can't lie" is **gone as an opening**; its two strongest
  paragraphs (the unfakeable-number claim, the *"the game is a strawman"* quote) now open
  section 7, together with D1 and the four-actors paragraph, which moved wholesale.
- Section 2 no longer opens "Rainbow is a Polkadot Product" — it defines the Product
  first, and `rainbow-dev.dot` is introduced as "the Product this article keeps using as
  its example" at the point where the name-is-the-identity fact needs it.
- The Acurast "not the player's phone" clarification was rewritten generically — *the
  phone doing the computing is never the phone of the person using the app* — because it
  now lands before the player exists in the article.
- "Rainbow's team measured this" → "This project measured that", in section 6.
- Section 5's opener now carries the hand-off: hosting is solved, computing is not, and a
  browser is the one machine you can never believe.

**Unchanged on purpose:** every claim, reference number, and diagram. This round moved
prose, it did not re-argue anything. ~3,580 words.

### Round 4 — 2026-08-09 — the host is a browser (D10)

**Feedback (Darwin):** explain that Polkadot Desktop and the Polkadot App (mobile) are
browsers specialised for loading Web3 content.

**Done:**
- **D10 "A browser — for apps that live on a chain"** (node `24:2`) — two host cards
  (Desktop / mobile) over a six-row mapping table: URL→`.dot` name, DNS lookup→DotNS
  lookup, web server→Bulletin, tab sandbox→Product sandbox, camera prompt→signer
  approval, Chrome/Safari/Firefox→Polkadot Desktop/App. Amber zone color.

**Host repos added (Darwin, same round)** — and they turned out to be far better evidence
than the SDK docstring alone. All three are public, GPL-3.0, last pushed 2026-07-28, under
`github.com/Polkadot-Community-Foundation/`:
| Repo | GitHub description | Language |
|---|---|---|
| `polkadot-desktop-community` | "Polkadot Desktop prototype" | TypeScript |
| `polkadot-android-community` | "Polkadot Android **user-agent** prototype" | Kotlin |
| `polkadot-ios-community` | "Polkadot iOS **user-agent** prototype" | Swift |

Three finds worth keeping:
- The desktop README's own tagline is *"A desktop browser for Polkadot applications"*, and
  its first feature reads *"Type a dotNS name and the app's content resolves on-chain,
  loads from the Bulletin Chain / IPFS, and renders in a tab. No DNS, no hosting servers."*
  That is D10's entire mapping, in the product's own words.
- **"user-agent"** is the web's own term for a browser — so the analogy is the projects'
  naming, not the article's invention.
- The sandbox prompt lists *"the camera, signing, storage, notifications, or the network"*
  — signing sits in the same permission list as the camera, grantable and revocable per
  app. D10's permission row was rewritten to say exactly that, and the prose now leans on
  it as "the whole security model, stated as a settings screen".
Also noted in prose: all three carry a prototype / not-audited warning, and the desktop can
delegate signing to the phone over QR so keys never leave it. The repo links are in the
browser section and in "Want the details?".

**Correction (Darwin, same round): "the URL is the DotNS."** The first cut of D10 split
naming across two rows as though a `.dot` name and DotNS were different layers — "you
open a name" then "DotNS turns it into a hash". Wrong emphasis: `rainbow-dev.dot` *is*
the URL, not a label pointing at one, and DotNS is the address layer as well as the
lookup. Rows 1–2 are now "The URL you type → The URL is a DotNS name" and "DNS looks it
up, returns an IP → DotNS looks it up, returns a content hash", the closing line reads
"the DotNS name is the URL", and the prose leads with the address before the lookup.
Standing rule for any future diagram or prose: **do not describe DotNS as merely the
DNS of this stack — it is the URL.**
- New article section **"The browser you have not heard of"**, placed between the devnet
  section and the Acurast section — it answers "if there is no server, what opens the app?"
- The analogy is anchored, not decorative: `docs/host-api-conformance.md` quotes the SDK's
  own docstring — a Product "is designed to run exclusively inside a host container
  (Polkadot Browser / Desktop)" and throws with **no direct-WebSocket fallback**. Parity
  calls the host a browser; the article just points at that.
- Also written: where the analogy *stops* — a normal browser gates the camera, this one
  gates your keys — and the honest footnote that E0.1 passed on the desktop path only,
  with the mobile webview recorded as untested (`docs/E0.1-product-sandbox.md`,
  `docs/E0.3-E0.4-acurast.md` status table).

**Darwin's enhanced images landed and are now wired in:** `D8_V2.png` (byte-identical to
`What is PolkadotDevnet.png`) and `What is Acuraast.png` → copied to `D9_V2.png` for a
space-free path. The article now embeds the enhanced versions; the raw exports
`D8.png`/`D9.png` are kept as the blueprints.

**Two things to check in the enhanced Acurast image:**
- Its lifecycle strip shows **five** stages, adding "VERIFIED" after DONE. Acurast's
  documented deployment lifecycle is OPEN → MATCHED → ASSIGNED → DONE
  (`research/acurast-docs-research.md` §5). The prose says four; the image says five.
- Card 3's body reads "For critical jobs executions use a Core device" — the source line
  was "developers use a Core device". Minor, but it is grammatically broken.

### Round 3 — 2026-08-08 — the two missing definitions (D8, D9)

**Feedback (Darwin):** the article never actually tells the reader *what* a Polkadot
Product Devnet is, or *what* Acurast is — and the purpose of the Devnet should be
carried by a diagram, built in Figma.

**Done:**
- **D8 "What is the Polkadot Product Devnet?"** (node `18:2`) — definition band, the
  resolution path as chips (`rainbow-dev.dot` → light client → DotNS contenthash →
  Bulletin over Bitswap → locked sandbox), four purpose cards (whole stack / nothing at
  stake / proof before production / its own chain), and the two doors. Amber zone color,
  matching D2's browser-and-app language.
- **D9 "What is Acurast?"** (node `21:2`) — definition band quoting the docs' own framing,
  four cards (network / workload / processor / the difference), and the deployment
  lifecycle OPEN → MATCHED → ASSIGNED → DONE. Teal zone color, matching D3.
- Both built with the established token set (bg #14162B, card #1E2140, Inter,
  44/20/22/15.5, 34px badges, 1.5px zone strokes at 55%).
- `article.md`: new section **"And the 'devnet' in the title"** after "An app with no
  server"; the Acurast section opening rewritten to define the network before telling
  the phone's story. Includes the silent-environment trap (devnet Bulletin ≠ Paseo
  Bulletin) as the one named gotcha.

**Deviation from the image workflow, on purpose:** D8/D9 currently embed the *raw Figma
export*, not an enhanced PNG, so the article renders complete today. They should go
through the same image-AI pass as D5 — the Figma frames are the base.

**Sourcing note:** the Darwin Knowledge vault could not be read this session — both the
`obsidian-vault` MCP server and the shell are blocked from
`Library/CloudStorage/…/Darwin Knowledge` by macOS TCC (same block recorded in project
memory for launchd). Definitions were taken instead from `research/acurast-docs-research.md`
(itself vault- and docs-anchored, every claim carrying its official URL) and from the
repo's own `docs/DEVELOPER-GUIDE.md`, `docs/deployment-devnet.md`,
`docs/E0.1-product-sandbox.md` and `README.md`. The MUST-NOT-CLAIM flags were respected:
no TrustZone/StrongBox/Keystore claims, and the compute-unit figure is given as
"at the time of writing".

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
| D8 | What is the Polkadot Product Devnet? | `18:2` | ✅ images/D8_V2.png |
| D9 | What is Acurast? | `21:2` | ✅ images/D9_V2.png |
| D10 | A browser — for apps that live on a chain | `24:2` | ⚠️ raw Figma export in `images/D10.png` |

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
