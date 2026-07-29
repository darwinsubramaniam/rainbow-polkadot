import { useEffect, type MouseEvent } from "react";

import { AcurastMark, PolkadotMark } from "../ui/Logos";

const GUIDE = "https://github.com/darwinsubramaniam/rainbow-polkadot/blob/main/docs/DEVELOPER-GUIDE.md";
const REPO = "https://github.com/darwinsubramaniam/rainbow-polkadot";

const SECTIONS = [
  ["problem", "The problem"],
  ["flow", "How a run gets proven"],
  ["enclave", "Inside the Acurast TEE"],
  ["trust", "Who you have to trust"],
  ["open", "Still open"],
] as const;

/**
 * The write-up.
 *
 * One page rather than a docs section: someone who just played wants the whole
 * argument in one scroll, and the depth-first version already exists as
 * DEVELOPER-GUIDE.md. This page is the honest short form — including the parts
 * that do not work yet, which is the half most project pages leave out.
 */
export function HowItWorks() {
  // Arriving on a shared `#/how#enclave` link: the browser will not act on the
  // second fragment, so honour it once the sections have rendered.
  useEffect(() => {
    const anchor = window.location.hash.split("#")[2];
    if (anchor) document.getElementById(anchor)?.scrollIntoView({ block: "start" });
  }, []);

  return (
    <>
      <section className="hero">
        <div className="container">
          <p className="eyebrow">How it works</p>
          <h1>
            An Acurast Processor <em>decides your score</em>.
          </h1>
          <p className="lede">
            Rainbow exists to find out what a Polkadot Product can actually do. It is a proof-of-concept for a
            leaderboard that takes nobody&apos;s word for anything: the score is computed on an Acurast Processor — a
            phone dedicated to the network, running inside its secure element — and checked by a contract on Asset Hub.
            Here is what runs where, which parts are hardware-backed, which parts still rest on trust, and what is left
            to build.
          </p>

          <div className="built-on">
            <span className="label">Built on</span>
            <a href="https://polkadot.com" target="_blank" rel="noreferrer">
              <PolkadotMark />
              Polkadot
            </a>
            <a href="https://acurast.com" target="_blank" rel="noreferrer">
              <AcurastMark />
              Acurast
            </a>
          </div>
        </div>
      </section>

      <div className="doc">
        <div className="container doc-grid">
          <nav className="doc-toc" aria-label="On this page">
            {SECTIONS.map(([id, label]) => (
              <a key={id} href={`#/how#${id}`} onClick={jump(id)}>
                {label}
              </a>
            ))}
          </nav>

          <div>
            <section id="problem">
              <h2>A signature proves who signed, never what is true</h2>
              <p>
                The usual way to put a score on-chain is to have the player sign it. That works exactly as well as
                asking them. A wallet signature is a statement of authorship — this account said this — and it is just
                as valid when the account says <code>score = 999999</code>. The browser holding the key is the
                player&apos;s own machine. There is nothing to stop them.
              </p>
              <p>
                Server-side validation moves the problem instead of solving it: now everyone has to trust whoever runs
                the server. So Rainbow moves the authority somewhere you can check — a <strong>Trusted Execution
                Environment</strong>, a hardware-isolated enclave on an <strong>Acurast Processor</strong>. The enclave
                re-plays the player&apos;s own keypresses against the exact same game code, works the score out itself,
                and signs the result with a key that never leaves the Processor&apos;s secure element.
              </p>
              <div className="callout">
                <strong>One simulation, not two.</strong> The browser and the enclave run the same compiled{" "}
                <code>sim.wasm</code>. Two hand-written implementations of the same rules would drift on rounding or
                iteration order and start flagging honest players as cheats.
              </div>
            </section>

            <section id="flow">
              <h2>How a run gets proven</h2>
              <p>
                Six steps, in order. The <a href="#/">play page</a> shows this same sequence lighting up as it happens.
              </p>

              <ol className="steps">
                <li>
                  <span className="actor">Browser → Enclave</span>
                  <h3>Claim a session</h3>
                  <p>
                    You ask for a slot. The enclave computes{" "}
                    <code>sessionId = keccak256(player, epoch, k)</code> — derived, never chosen, so a malformed
                    session identifier cannot exist.
                  </p>
                </li>
                <li>
                  <span className="actor">Inside the secure element</span>
                  <h3>The seed is derived, not drawn</h3>
                  <p>
                    <code>seed = keccak256(sign(&quot;rainbow-seed-v1&quot; ‖ sessionId))</code>. The signing key lives
                    in the secure element and the signature scheme is deterministic, which makes this a function nobody
                    can evaluate offline. You get twelve slots an hour and must actually play each one to find out what
                    it holds.
                  </p>
                </li>
                <li>
                  <span className="actor">Browser</span>
                  <h3>Play the level the seed built</h3>
                  <p>
                    The level geometry, enemies and coins are all generated from that seed inside{" "}
                    <code>sim.wasm</code>. Your keypresses are recorded as a tick-stamped input log — the complete
                    record of the run, and small enough to post.
                  </p>
                </li>
                <li>
                  <span className="actor">Browser → Enclave</span>
                  <h3>Send the log, not the score</h3>
                  <p>
                    The attest request has no score field at all. There is nothing to inflate, and nothing the enclave
                    could be tricked into accepting — it can only compute.
                  </p>
                </li>
                <li>
                  <span className="actor">Inside the secure element</span>
                  <h3>Replay, then sign</h3>
                  <p>
                    The enclave re-derives the seed, replays the log through the same wasm, and gets its own number. It
                    builds the EIP-712 digest <em>internally</em> — signing a caller-supplied digest would let anyone
                    get anything signed — and signs with the hardware key.
                  </p>
                </li>
                <li>
                  <span className="actor">Browser → Asset Hub</span>
                  <h3>The contract checks the signature</h3>
                  <p>
                    The <code>Leaderboard</code> contract, compiled to PolkaVM, recovers the signer from the signature,
                    checks it against its own verifier set, checks the rules hash, checks the session has not been used,
                    and only then updates your best. Nine reject paths, all of them on-chain and auditable.
                  </p>
                </li>
              </ol>
            </section>

            <section id="enclave">
              <h2>Inside the Acurast TEE</h2>
              <p>
                <a href="https://acurast.com" target="_blank" rel="noreferrer">
                  Acurast
                </a>{" "}
                is a decentralised compute network. Its <strong>Processors</strong> are Android devices dedicated to
                running jobs for the network, and what makes them useful here is not that they are cheap — it is the
                secure element. A key generated inside one cannot be exported by the device&apos;s operator, its
                operating system, or the person who deployed the job. The verifier is a 52 KB Node job bundling{" "}
                <code>sim.wasm</code> and a vendored keccak256, deployed to a single pinned Processor.
              </p>

              <h3>Four rules the enclave must never break</h3>
              <ul>
                <li>
                  <strong>No score is ever accepted.</strong> The attest endpoint has no score field. A score can only
                  be computed, never supplied.
                </li>
                <li>
                  <strong>The digest is built inside.</strong> If the enclave signed a digest handed to it, the whole
                  guarantee would be a formality.
                </li>
                <li>
                  <strong>The rules hash is read from the loaded artifact</strong>, not from config — so the enclave
                  cannot attest for a ruleset it is not actually running.
                </li>
                <li>
                  <strong>The seed cannot be computed outside.</strong> It is derived through the hardware key, so
                  knowing one seed tells you nothing about the next.
                </li>
              </ul>

              <h3>Why you do not have to trust the operator</h3>
              <p>
                The enclave&apos;s public key is published in <strong>Acurast chain state when the job is matched</strong>
                — before it runs, and not by the enclave itself. The contract is configured with that key. So the
                verification is: does this signature recover to a key that was already on-chain? An operator who swapped
                the job for a lying one would produce signatures from a different key, and every one of them would
                revert.
              </p>

              <h3>The two decisions that cost the most time</h3>
              <p>
                The job runs on Acurast&apos;s <strong>Shell</strong> runtime, not the Node.js one. On Node.js the
                signing helper force-prepends a fixed prefix and its own script hash before hashing, which produces a
                signature over something that is <em>not</em> the EIP-712 digest — unverifiable by any Ethereum-style
                contract. The Shell runtime signs the bytes you give it.
              </p>
              <p>
                And the assignment strategy is <strong>Single</strong> with a pinned processor rather than{" "}
                <strong>Competing</strong>. Competing rotates processors, and rotating processors rotates keys — every
                rotation would silently invalidate the verifier the contract is configured with.
              </p>
            </section>

            <section id="trust">
              <h2>Who you have to trust</h2>
              <p>
                Worth stating exactly, because a security design that overclaims is worse than one that admits its
                edges.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Component</th>
                      <th>Trust required</th>
                      <th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Game client</td>
                      <td>
                        <span className="pill none">none</span>
                      </td>
                      <td>Fully attacker-controlled. Assume it is modified.</td>
                    </tr>
                    <tr>
                      <td>Input log</td>
                      <td>
                        <span className="pill none">none</span>
                      </td>
                      <td>Accepted as data, then replayed. Never believed.</td>
                    </tr>
                    <tr>
                      <td>Verifier enclave</td>
                      <td>
                        <span className="pill hw">hardware</span>
                      </td>
                      <td>
                        The key lives in the Processor&apos;s secure element, and its public half is on-chain before the job
                        runs — so you verify rather than trust the operator.
                      </td>
                    </tr>
                    <tr>
                      <td>Cloudflare tunnel</td>
                      <td>
                        <span className="pill part">liveness only</span>
                      </td>
                      <td>It carries bytes. It cannot forge a signature made in the secure element — only stall it.</td>
                    </tr>
                    <tr>
                      <td>Contract owner</td>
                      <td>
                        <span className="pill none">full</span>
                      </td>
                      <td>
                        Whoever can call <code>setVerifier</code> is the single point of compromise. Behind a multisig
                        for anything past a demo.
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section id="open">
              <h2>Still open</h2>
              <p>
                What is genuinely working, what is being built, and what this design does not solve at all. The last
                group is the important one.
              </p>

              <ul className="status">
                <li>
                  <span className="state live">Working</span>
                  <div>
                    <div className="what">End-to-end on the Products Devnet</div>
                    <div className="why">
                      An enclave-computed score, signed in the secure element, accepted by the contract on Asset Hub —
                      with negative tests covering every reject path.
                    </div>
                  </div>
                </li>
                <li>
                  <span className="state live">Working</span>
                  <div>
                    <div className="what">Deterministic simulation</div>
                    <div className="why">Identical results across native, wasmi and V8. 50 tests.</div>
                  </div>
                </li>
                <li>
                  <span className="state wip">Building</span>
                  <div>
                    <div className="what">Publishing the input log to Bulletin</div>
                    <div className="why">
                      The strongest thing still unbuilt. The log fully determines the run, so publishing it lets anyone
                      re-replay and check the score independently — turning &quot;trust the TEE&quot; into &quot;the TEE
                      is a fast path over a publicly re-verifiable record&quot;. Ghost replays, spectating and dispute
                      resolution all fall out of it.
                    </div>
                  </div>
                </li>
                <li>
                  <span className="state wip">Building</span>
                  <div>
                    <div className="what">A game worth the machinery</div>
                    <div className="why">
                      Run, jump, stomp, collect — basic shapes, one level generator. The proof pipeline is further along
                      than the platformer it protects.
                    </div>
                  </div>
                </li>
                <li>
                  <span className="state wip">Building</span>
                  <div>
                    <div className="what">A durable verifier endpoint</div>
                    <div className="why">
                      An Acurast job is a one-time execution behind a quick tunnel, so its hostname is minted at boot
                      and dies with the job. That is why the verifier URL is a field you can edit rather than a
                      constant.
                    </div>
                  </div>
                </li>
                <li>
                  <span className="state open">Not solved</span>
                  <div>
                    <div className="what">Bots and tool-assisted play</div>
                    <div className="why">
                      A perfectly executed input log is a valid input log. Behavioural heuristics inside the enclave
                      would be detection, not proof — and an arms race.
                    </div>
                  </div>
                </li>
                <li>
                  <span className="state open">Not solved</span>
                  <div>
                    <div className="what">Sybil</div>
                    <div className="why">
                      Nothing stops one person farming many accounts. The Products personhood precompile is the
                      identified path if the board ever carries value.
                    </div>
                  </div>
                </li>
                <li>
                  <span className="state open">Not solved</span>
                  <div>
                    <div className="what">Hardware attacks on the TEE</div>
                    <div className="why">Trust is inherited from the chip vendor&apos;s attestation root.</div>
                  </div>
                </li>
                <li>
                  <span className="state open">Not solved</span>
                  <div>
                    <div className="what">Choosing the processor yourself</div>
                    <div className="why">
                      The job pins one processor. Using the open processor market instead of a chosen device is what
                      removes this.
                    </div>
                  </div>
                </li>
              </ul>

              <div className="callout spaced">
                <strong>Explicitly not a threat: cherry-picking.</strong> A player choosing which runs to submit is
                harmless for a highest-score board — a withheld run is indistinguishable from one that never happened.
                It would <em>not</em> hold for win rates or tournament records, where the denominator matters.
              </div>

              <p className="after">
                The full technical write-up, with diagrams and deploy instructions, is in the{" "}
                <a href={GUIDE} target="_blank" rel="noreferrer">
                  developer guide
                </a>
                . Everything is on{" "}
                <a href={REPO} target="_blank" rel="noreferrer">
                  GitHub
                </a>
                .
              </p>
            </section>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * In-page anchors under a hash route.
 *
 * `#/how#enclave` is not something the browser will scroll to on its own — the
 * fragment is already spent on the route — so the jump is done by hand and the
 * URL is left readable for sharing.
 */
const jump = (id: string) => (e: MouseEvent) => {
  e.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  history.replaceState(null, "", `#/how#${id}`);
};
