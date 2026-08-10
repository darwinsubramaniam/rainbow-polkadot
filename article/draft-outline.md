# Draft outline — APPROVED (Darwin, 2026-07-31)

**Title (Darwin's direction):** "A New Polkadot Product (Devnet) Capability: Your Phone
as the Backend Server"
**Medium subtitle candidate:** "A browser game with no company servers — distributed by
a chain, verified by a phone's secure hardware, audited by a smart contract."
**Publication target:** Medium.
**Tunnel naming:** generic — "any tunnel provider", never a vendor name.

**Aim:** show readers that a new capability exists TODAY — trustless, verifiable
client-side computation built from a Polkadot Product (devnet) + Acurast — using the
Rainbow game as the visible demonstration. Not a tutorial. Repo link for the "how".

**Audience:** curious general/tech-adjacent readers. Every concept explained in plain
language; technical depth only where it earns trust. Research citations anchor the proof
methods.

**Voice rule (truthfulness):** we say exactly what the system does and doesn't do. No
Merkle trees are claimed (there are none). Limitations are stated plainly.

**Terminology rule (Darwin, 2026-07-31):** never say "phone enclave" or bare "the
phone" — readers assume the *player's* phone. Always **"Acurast cloud phone"** (or "a
phone in the Acurast cloud — someone else's phone, not yours") in diagrams and prose
alike. The verifier hardware belongs to the Acurast network, never to the player.

---

## Section plan

### 0. Hook — "The score that can't lie" (~200 words)
The scene: a simple platformer in a browser. You finish a run, and a number lands on a
public leaderboard. The claim: **nobody — not the player, not the developer, not the
company hosting it (there isn't one) — can fake that number.** Not because someone checks,
but because an old smartphone's security chip re-ran the whole game and put its
unforgeable signature on the result. This article explains how that is possible today,
and why the game is the least important part of it.

- Key sentence: "The game is a strawman" — quote the repo itself.
- **Diagram D1** (hero, may be image-AI): the four actors.

### 1. An app with no server — the Polkadot Product (~400 words)
Plain-language: what it means that the app itself lives on a blockchain. Published to the
Bulletin chain under a human-readable name (`rainbow-dev.dot`), loaded by the Polkadot
app, running in a sandbox. It holds no keys and opens no connections of its own — the
wallet and the chain access are *lent to it* by the host, and the user approves what it
may do. The surprising part: the name IS the identity — but note the order, corrected by
Darwin 2026-08-09: you **register the `.dot` name in DotNS first** (it lives in a smart
contract on Asset Hub), and *then* upload the app to Bulletin and link it to the name you
own. The host derives the app's account from that registered name, per app and per user.
Do NOT write that the account is "mathematically derived from the name string" — that
skips the registration and implies a name is free text you can pick at build time.
- Capability message: you can ship an app that no company hosts, no server runs, and
  whose wallet access is controlled by the user's own host app.
- **Diagram D2**: "Where does this app actually live?"

### 2. The cloud in your drawer — Acurast (~400 words)
Plain-language: a network where smartphones are the data center. Official facts: 250k+
compute units; phones ship with security hardware "better than servers"; a phone you no
longer use becomes a locked-down compute node (Processor Core). Developers deploy code to
strangers' phones — and crucially, the network can *prove* what ran.
- Citations: docs.acurast.com, acurast.com/why-mobile, whitepaper arXiv:2503.15654.
- **Diagram D3**: old phone → locked compute node in a global network.

### 3. The vault inside the phone — the enclave (~500 words)
The heart of the trust story, in three plain-language steps:
1. **A key is born inside a chip** (dedicated security coprocessor — Google Titan M2
   class; NOT the main processor) and physically cannot leave it. Even the phone's owner
   can't read it.
2. **The key is welded to the code.** Each Acurast deployment gets its own key bound to
   the exact code deployed; change one byte and the key is lost forever (whitepaper
   quote). So a valid signature proves *this exact program* produced the result.
3. **The hardware can prove itself.** The chip carries a factory-installed certificate
   chain (rooted at Google/OEM) that the Acurast chain checks before trusting a device —
   attestation.
- Research anchors: Sabt et al. 2015 (what a TEE is), Coker et al. 2011 (remote
  attestation principles), Ménétrey et al. 2022 (attestation survey), Acurast whitepaper.
- Careful wording: ASHR is coprocessor-based; do NOT say TrustZone/StrongBox.
- **Diagram D4**: the key ceremony — key born in silicon, welded to code, certified by
  the factory.

### 4. Assembling the machine — how Rainbow uses both (~500 words)
Now snap the pieces together, and make the POC framing explicit:
- The **backend is the proof-of-concept**: Product (trustless distribution + user-owned
  wallet) + Acurast (trustless compute + hardware keys) + a small contract (trustless
  bookkeeping). The game exists only so you can *watch* the system work.
- The one clever trick that makes a game verifiable: **the game is a deterministic
  machine**. Same seed + same inputs = same outcome, always (fixed-point math, no
  floats). Verified across three engines, per tick, over millions of ticks.
- Because of that, the browser doesn't need to be trusted: it only records *which buttons
  you pressed and when* (the input log). The score is never sent — there is literally no
  field for it. The enclave replays your inputs against the same compiled game and
  computes the score itself.
- The rules are pinned on-chain: the contract stores the fingerprint (keccak256) of the
  exact game binary; the enclave fingerprints whatever binary it actually loaded. If they
  differ, no signature can help.
- **Diagram D5** (centerpiece): the full journey of one run — buttons pressed → input
  log → enclave replay → signed claim → player's wallet submits → contract checks.

### 5. The sealed envelope — why the contract believes a stranger (~450 words)
The subtle beauty: the *player* — the least trusted party — carries the proof to the
chain. Explain like a sealed envelope: the enclave writes the verdict, seals it with a
signature that covers every field (who, which game, what score, which session, which
rules, until when), and hands it back to the player. The player can read it, delay it,
or throw it away — but cannot alter one bit without breaking the seal.
The contract, in ~10 lines of checks: Is the envelope fresh? Is this session unused
(each session number can be spent once — no replays)? Do the rules match? And finally:
recover the signer's address from the signature — is it the one registered as the
verifier? That registered address was read from the *Acurast chain's public record* of
the deployment, published before the job ever ran.
- Research anchors: EIP-712 (typed, domain-bound signing — a signature valid for exactly
  one contract on one chain), ECDSA (Johnson-Menezes-Vanstone 2001), secp256k1 (SEC 2),
  and the direct academic precedents: Bethea-Cochran-Reiter NDSS 2010 (verify a game
  client by replaying its action log) and BlackMirror CCS 2020 (TEE-based anti-cheat).
  Position vs zk-SNARKs (Walfish-Blumberg 2015; Ben-Sasson et al. 2014): TEE replay is
  the pragmatic point in the design space — cheap, general, hardware-rooted.
- **Diagram D6**: three cheat attempts, three failures (edit the log → enclave computes
  a different score; forge a signature → recovers wrong address; resubmit an old win →
  session already spent).

### 6. Not a game — a pattern (~350 words)
Generalize, concretely: the verifier is 391 lines of game-agnostic code plus one swappable
wasm module; the contract serves any number of games, each pinned to its own rules
fingerprint. Replace "game run" with any deterministic computation over a client-supplied
trace: fitness/insurance telemetry scoring, exam or certification results, IoT sensor
readings, auction bids, fair lotteries, oracle computations, AI-inference receipts.
- The devnet + Acurast pairing is the capability; Rainbow is one instantiation.
- Mention the strongest unbuilt extension (from the repo): publish the input log
  publicly, and the TEE becomes "a fast path over a publicly re-verifiable record".
- **Diagram D7** (optional, simple): same backbone, different payloads.

### 7. What this doesn't prove yet — limitations (~300 words, expand later)
Honest list, plainly worded:
- One verifier phone, one operator, chosen by the developer (whitelist) — decentralized
  compute, not yet decentralized *verification*.
- The tunnel (Cloudflare) can censor/delay, though not forge.
- The contract owner (a single account) registers verifiers — a compromise point.
- Human-side cheating (bots, perfect TAS play, multiple identities) is out of scope: the
  system proves the rules were followed, not who was holding the phone.
- TEE hardware attacks are inherited risk from the chip vendor (cite Cerdeira et al.
  2020 SoK for honesty).
- Devnet, small numbers, one real attested score on the live board.

### 8. Closing + "want the details?" (~150 words)
One paragraph restating the capability: a browser app distributed by a chain, computed
for by a phone in someone's drawer, and audited by a contract — no company in the loop.
Link to the GitHub repo and the reference list for everything else.

**Total target: ~3,300 words** (≈12-min read).

---

## Diagram plan

Style direction (all diagrams): friendly-technical, flat illustration, consistent color
coding per trust zone — e.g. amber = untrusted (player/browser), teal = hardware-trusted
(enclave/phone), violet = chain-trusted (contracts). Rounded cards, arrows with short
verb labels, minimal text. Design in Figma file
https://www.figma.com/design/1NQStUOSQZ86KzLiYswPd5/Untitled first.

| # | Diagram | Content | Tool |
|---|---|---|---|
| D1 | The four actors (hero) | Player, browser app, phone-with-vault, contract — one sentence each | Figma (illustrative hero variant optional via image-AI) |
| D2 | An app with no server | Publish once → app lives on chain → host lends wallet/chain access → sandbox | Figma |
| D3 | The cloud in your drawer | Old phone → factory reset → locked node → joins global mesh of phones | Figma; illustrative variant good candidate for image-AI |
| D4 | The key ceremony | Key born inside coprocessor → welded to deployed code (change code = key gone) → factory certificate chain up to Google/OEM | Figma |
| D5 | Journey of one run (centerpiece) | inputs recorded → log sent (no score field!) → enclave replays same wasm → signs claim → player submits → contract's checklist | Figma |
| D6 | Three cheats, three failures | tampered log / forged signature / replayed envelope — each hits a different wall | Figma |
| D7 | Same backbone, other uses | swap the wasm: game → telemetry, exams, sensors, lotteries | Figma |

### Image-AI prompts (for pictures beyond Figma's comfort zone)

**P1 — Hero image (article header):**
"Flat vector illustration, warm minimal tech-editorial style. An old smartphone sitting
in an open desk drawer, glowing softly from within; inside the phone, a tiny glowing
bank-vault door (representing a secure chip). From the phone, a thin luminous thread
travels to a floating browser window showing a simple 2D platformer game character
mid-jump, and another thread travels to a floating hexagonal ledger/block symbol. Dark
indigo background, amber/teal/violet accent palette, generous negative space, no text,
16:9."

**P2 — 'Cloud in your drawer' (section 2, optional replacement for D3):**
"Flat vector illustration, editorial style. Dozens of diverse old smartphones arranged
as a world map / globe grid, each phone glowing like a small server; one phone in the
foreground being placed into the grid by a human hand. Subtle circuit lines connect
them. Dark background, teal and amber accents, no text, 16:9."

**P3 — 'Sealed envelope' (section 5, optional):**
"Flat vector illustration. A small robot-like phone character handing a glowing sealed
envelope (wax seal shaped like a fingerprint) to a person, who walks it toward a grand
classical building made of hexagonal blocks (a blockchain courthouse). The person cannot
open the envelope — it glows shut. Dark indigo background, amber/teal/violet palette,
no text, 16:9."

---

## Reference strategy in-article

- Inline, light-touch: "(researchers proposed exactly this in 2010 — replaying a game
  client's action log to catch cheating [Bethea et al.])" — full table at the end.
- End matter: the reference table from `references/references.md`, trimmed to the ~10
  actually cited, with URLs.
- Primary sources quoted directly: Acurast whitepaper (per-deployment keys), repo
  ("the game is a strawman", "no score is sent — there is no field for one").

## Alternative titles

1. "The Uncheatable Leaderboard"
2. "Proof, from a Phone in a Drawer"
3. "No Server, No Company, No Cheating: a Game That Proves Its Own Scores"
4. "The Game Is Not the Point" (leans hardest into the POC framing)

## Questions for Darwin (round 1)

1. Outline OK? Any section to add/cut/reorder before prose starts?
2. Publication target (blog/Medium/dev.to/personal site)? Affects length and tone.
3. Title preference from the list (or another direction)?
4. Should the article name Cloudflare, or keep the repo's "any tunnel provider" generic
   stance? (Recommended: generic, matching `ProofFlow.tsx`.)
