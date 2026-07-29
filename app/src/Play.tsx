import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { ProductSDKContext } from "@parity/product-sdk/react";

import { useGame } from "./game/useGame";
import { remote, type Attestation, type Enclave, type Identity } from "./chain/enclave";
import {
  localEpoch,
  minutesToReset,
  nextAttempt,
  MAX_ATTEMPTS,
  type SessionRecord,
} from "./chain/attempts";
import { playerAddress, submitAttestation } from "./chain/submit";
import { addressOf } from "./chain/leaderboard";
import { connectWallet, useSignerState } from "./chain/wallet";
import { Hud } from "./ui/Hud";
import { TouchPad } from "./ui/TouchPad";
import { ProofRail, type Step, type StepState } from "./ui/ProofRail";
import { Verdict } from "./ui/Verdict";
import { useStoredJson, useStoredString } from "./ui/useStored";
import { standaloneReason } from "./main";

/**
 * Verifier the app points at out of the box.
 *
 * Baked in only as a convenience default, and always overridable in the UI —
 * the value the user types wins and is persisted locally. It has to work this
 * way because an Acurast job is a *onetime* execution behind a quick tunnel: the
 * hostname is minted at boot and dies with the job, so no build-time constant
 * can stay correct for long. When the enclave is redeployed, either paste the
 * new URL here or republish with this updated.
 */
const DEFAULT_VERIFIER = "https://buck-influence-greetings-nursery.trycloudflare.com";

/** Only the parts of a session the UI and the attestation actually need. */
interface Active {
  epoch: number;
  k: number;
  seed: string;
}

type LogKind = "info" | "ok" | "bad";
interface Line {
  kind: LogKind;
  text: string;
}

export function Play() {
  // Read the context rather than `useProductSDK()`: that hook throws when the
  // provider is absent, and absent is a supported state here — no host means no
  // chain access, but the game and the enclave round-trip still work.
  const app = useContext(ProductSDKContext);
  const signer = useSignerState();

  const account = signer.selectedAccount ?? signer.accounts[0] ?? null;
  // The H160 pallet-revive maps this account to. It is what the contract
  // credits AND what the enclave hashes into sessionId, so it must be derived
  // identically on both sides.
  const player = account ? playerAddress(account.address) : null;

  // Persisted, because a player who turned the sound off meant it. Applied to
  // the sound module by the effect below rather than passed down, so toggling
  // it mid-run re-renders nothing that the game loop touches.
  const [muted, setMuted] = useStoredJson("rainbow.muted", false);

  const mountRef = useRef<HTMLDivElement | null>(null);
  // The address is passed for one reason only: it picks which of the pack's
  // five characters the player is drawn as, so a returning player is the same
  // character every time. It reaches nothing that is attested.
  const game = useGame(mountRef, player);

  // Also depends on `ready`: the preference is set before the audio has
  // finished loading, and would otherwise be dropped on the floor.
  const applyMuted = game.setMuted;
  useEffect(() => {
    applyMuted(muted);
  }, [muted, game.ready, applyMuted]);

  // The URL persists as it is edited, so a reload does not cost the user a
  // pasted tunnel hostname. There was previously a separate uncommitted draft,
  // which meant a URL typed but never submitted was simply lost.
  const [verifier, setVerifier] = useStoredString("rainbow.verifier", DEFAULT_VERIFIER);

  // Dev only: an enclave that answers from this tab instead of a deployed job.
  // Persisted so a reload does not silently put the app back on a tunnel that
  // is not running. `simulating` is the value everything else reads — a build
  // resolves `import.meta.env.DEV` to false, so a stale stored `true` cannot
  // switch the simulator on in production.
  const [simulated, setSimulated] = useStoredJson("rainbow.simulate", false);
  const [sim, setSim] = useState<Enclave | null>(null);
  const simulating = import.meta.env.DEV && simulated;

  // One session record per enclave. A seed the simulator issued means nothing
  // to the deployed one — each derives its own from its own key — so a held run
  // must never be replayed or attested against the other, and the attempt
  // budgets are likewise unrelated. Separate slots are what make flipping the
  // switch safe rather than a source of mystifying score disagreements.
  const liveRecord = useStoredJson<SessionRecord | null>("rainbow.session", null);
  const simRecord = useStoredJson<SessionRecord | null>("rainbow.session.sim", null);
  const [record, setRecord] = simulating ? simRecord : liveRecord;

  const [session, setSession] = useState<Active | null>(null);
  const [enclave, setEnclave] = useState<Identity | null>(null);
  const [attestation, setAttestation] = useState<Attestation | null>(null);
  const [landed, setLanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<number | null>(null);
  const [lines, setLines] = useState<Line[]>([]);

  const say = useCallback((text: string, kind: LogKind = "info") => {
    setLines((l) => [...l.slice(-60), { kind, text }]);
  }, []);

  // Announce standalone mode once, so the missing Submit button is explained
  // rather than just broken. The ref is what makes "once" true: StrictMode
  // mounts effects twice in development, which printed the notice twice.
  const announced = useRef(false);
  useEffect(() => {
    if (app || !standaloneReason.value || announced.current) return;
    announced.current = true;
    say(`no Polkadot host: ${standaloneReason.value}`, "info");
    say("running standalone — play and attestation work, on-chain submit does not.", "info");
  }, [app, say]);

  // Pull the simulator in only when it is actually switched on, and only in a
  // dev build. The dynamic import is what keeps it out of the bundle: the
  // branch is statically false in production, so nothing references the chunk.
  useEffect(() => {
    if (!import.meta.env.DEV || !simulated || sim) return;

    let live = true;
    void import("./chain/mock")
      .then((m) => {
        if (live) setSim(m.simulatedEnclave());
      })
      .catch((e: unknown) => {
        say(`simulator failed to load: ${e instanceof Error ? e.message : String(e)}`, "bad");
      });
    return () => {
      live = false;
    };
  }, [simulated, sim, say]);

  const connecting = signer.status === "connecting";

  // -- session -------------------------------------------------------------
  //
  // The attempt index is not something the player sets. A stored session is
  // reused for as long as it is still valid, and only a session the chain has
  // actually consumed advances the counter. That is the anti-grinding rule
  // expressed as a UI: you cannot re-roll a level you did not pay for.

  const next = nextAttempt(record, player, localEpoch());
  const canReplay = next.mode === "replay";
  const exhausted = next.mode === "exhausted";

  /**
   * The enclave this run talks to, or null with the reason it is not ready.
   *
   * Resolved per call rather than held in state: the simulator arrives
   * asynchronously and the URL is edited as it is typed, so a value captured
   * at render would be the stale one exactly when it matters.
   */
  const endpoint = (): Enclave | null => (simulating ? sim : verifier.trim() ? remote(verifier.trim()) : null);
  const notReady = () => (simulating ? "the simulator is still loading…" : "set the verifier URL first");

  const play = useCallback(async () => {
    const api = endpoint();
    if (!api) return say(notReady(), "bad");
    if (!player) return say("connect a wallet first — the seed is bound to your address", "bad");
    if (next.mode === "exhausted") {
      return say(`no runs left this hour — ${minutesToReset()} min until they reset`, "bad");
    }

    setBusy("session");
    setAttestation(null);
    setLanded(false);
    setFailed(null);
    try {
      // Confirms the enclave is alive and running the ruleset we expect. On a
      // replay it is a courtesy rather than a requirement — the seed is already
      // in hand and the level is a pure function of it — so a dead enclave
      // still lets the player play, and only blocks opening a new session.
      try {
        const id = await api.identity();
        setEnclave(id);
        say(`enclave gameId ${id.gameId}, rulesHash ${id.rulesHash.slice(0, 14)}…`);
      } catch (e) {
        if (next.mode !== "replay") throw e;
        say(`enclave unreachable (${e instanceof Error ? e.message : String(e)})`, "bad");
        say("replaying the held seed offline — attesting will need it back.", "info");
      }

      if (next.mode === "replay") {
        setSession({ epoch: next.epoch, k: next.k, seed: next.seed });
        say(`session epoch ${next.epoch} k ${next.k} still open — same seed ${next.seed}`, "ok");
        game.start(BigInt(next.seed));
        return;
      }

      const s = await api.openSession(player, next.k);
      setSession({ epoch: s.epoch, k: s.k, seed: s.seed });
      setRecord({ player, epoch: s.epoch, k: s.k, seed: s.seed, spent: false });
      say(`session epoch ${s.epoch} k ${s.k} — seed ${s.seed}`, "ok");
      say(`the level below was generated from that seed, inside sim.wasm`);

      game.start(BigInt(s.seed));
    } catch (e) {
      setFailed(1);
      say(`session failed: ${e instanceof Error ? e.message : String(e)}`, "bad");
    } finally {
      setBusy(null);
    }
  }, [verifier, simulating, sim, player, next, setRecord, say, game]);

  // -- attest + submit -----------------------------------------------------

  const finish = useCallback(async () => {
    const api = endpoint();
    if (!api) return say(notReady(), "bad");
    if (!session || !game.result || !player || !enclave) return;

    // Local, not `busy`: the catch below needs to know which step threw, and
    // the state read inside this closure is the one captured at render.
    let stage = 4;

    setBusy("attest");
    setFailed(null);
    try {
      say(`sending ${game.result.inputLog.length} log entries — no score is sent…`);
      const att = await api.attest(player, session.epoch, session.k, game.result.inputLog);
      setAttestation(att);

      const theirs = BigInt(att.claim.score);
      const ours = game.result.score;
      say(`enclave replayed ${att.ticks} ticks and computed ${theirs}`);
      if (theirs === ours) {
        say(`AGREES with this device (${ours}) — same wasm, same log, same answer`, "ok");
      } else {
        say(`DISAGREES: device ${ours}, enclave ${theirs}. The enclave's is authoritative.`, "bad");
      }

      // A simulated attestation is signed by a key printed in the source. The
      // contract's verifier set does not contain it, so submitting would spend
      // a transaction to be told what is already known — and, worse, would let
      // the rail claim an on-chain step the simulator cannot honestly reach.
      if (simulating) {
        say("simulated enclave — stopping before submit. This signature is from a dev key", "info");
        say("the contract does not trust; switch the simulator off to land a real score.", "info");
        return;
      }

      if (!app) {
        say("no host — stopping before submit. The attestation below is valid and", "info");
        say("can be landed from the CLI with scripts/serve-game.mjs.", "info");
        return;
      }

      stage = 6;
      setBusy("submit");
      say("submitting to the leaderboard…");
      // The enclave address only picks the signature's recovery id; the
      // contract recovers the signer itself and checks its own verifier set,
      // so a wrong value here reverts rather than forging an acceptance.
      const out = await submitAttestation(app, att, addressOf(enclave.secp256k1));
      setLanded(out.matches);
      if (!out.matches) setFailed(6);
      say(`best(${att.claim.gameId}) is now ${out.best}`, out.matches ? "ok" : "bad");

      // Only an accepted submit consumes the session on-chain. A revert —
      // `NotAnImprovement` most often — leaves the attempt open, so the player
      // keeps the level rather than being charged for a rejected transaction.
      if (out.matches) {
        setRecord({ player, epoch: session.epoch, k: session.k, seed: session.seed, spent: true });
        const left = MAX_ATTEMPTS - (session.k + 1);
        say(left > 0 ? `session consumed — ${left} runs left this hour` : "no runs left this hour", "info");
      }
    } catch (e) {
      setFailed(stage);
      say(`failed: ${e instanceof Error ? e.message : String(e)}`, "bad");
    } finally {
      setBusy(null);
    }
  }, [verifier, simulating, sim, session, game.result, player, enclave, app, setRecord, say]);

  /**
   * Switch between the deployed enclave and the one in this tab.
   *
   * The in-flight session is dropped rather than carried across. The seed the
   * player holds was derived from a key only one of the two has, so attesting
   * it against the other would replay a different level and produce a score
   * that looks like a cheat rather than a mismatch of endpoints.
   */
  const toggleSimulation = useCallback(() => {
    const on = !simulated;
    setSimulated(on);
    setSession(null);
    setAttestation(null);
    setEnclave(null);
    setLanded(false);
    setFailed(null);
    say(
      on
        ? "simulating the enclave in this tab — seeds, replay and signature are local, and nothing is submitted"
        : "back to the deployed enclave at the URL above",
      "info",
    );
  }, [simulated, setSimulated, say]);

  const connect = useCallback(() => {
    connectWallet()
      .then((m) =>
        say(
          m === "host"
            ? "connected through the Polkadot host"
            : "no host found — using dev accounts. Play and attestation work; on-chain submit needs the host.",
          m === "host" ? "ok" : "info",
        ),
      )
      .catch((e: unknown) => say(`wallet: ${e instanceof Error ? e.message : String(e)}`, "bad"));
  }, [say]);

  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  // -- the controls on the screen ------------------------------------------
  //
  // Both actions live inside the stage, over the picture. The cabinet is what
  // goes fullscreen, so a control anywhere else on the page is unreachable
  // exactly when the game is most playable — a player would have to leave
  // fullscreen to attest a run and then go back in to play the next one.
  //
  // Labels are derived here rather than inline: each button carries four or
  // five states, and a nested ternary in the middle of the JSX hides which of
  // them is actually reachable.

  /** Nothing left to do with this run: it is attested, and either landed or unlandable. */
  const attestSettled = attestation !== null && (landed || simulating || !app);

  const attestLabel =
    busy === "attest"
      ? "Attesting…"
      : busy === "submit"
        ? "Submitting…"
        : landed
          ? "On the leaderboard"
          : attestSettled
            ? "Attested"
            : simulating
              ? "Attest (simulated)"
              : "Attest & submit";

  const playLabel =
    busy === "session"
      ? "Asking the enclave…"
      : exhausted
        ? `Back in ${minutesToReset()} min`
        : canReplay
          ? "Replay"
          : game.result
            ? "Play again"
            : "Play";

  // -- fullscreen ----------------------------------------------------------
  //
  // The cabinet goes fullscreen, not the canvas: the HUD and the touch pad
  // have to come with it or the game is unplayable on a phone once it fills
  // the screen. A Product is delivered into an iframe, which may withhold the
  // permission — hence the catch rather than an assumption it worked.
  const cabinetRef = useRef<HTMLDivElement | null>(null);
  const [full, setFull] = useState(false);

  useEffect(() => {
    const sync = () => setFull(document.fullscreenElement === cabinetRef.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggleFull = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    cabinetRef.current?.requestFullscreen().catch((e: unknown) => {
      say(`fullscreen unavailable: ${e instanceof Error ? e.message : String(e)}`, "bad");
    });
  }, [say]);

  // -- the proof trace -----------------------------------------------------
  //
  // Derived from the same state that drives the buttons, so the rail cannot
  // claim a step the app has not actually reached.
  const at = (index: number, done: boolean, active: boolean): StepState =>
    failed === index ? "failed" : done ? "done" : active ? "active" : "idle";

  const steps: Step[] = [
    {
      short: "Account",
      what: "Connect an account",
      why: "Your seed is derived from your address, so nobody can play your session for you.",
      state: at(1, player !== null, player === null),
    },
    {
      short: "Seed issued",
      what: "The enclave issues a seed",
      why: "Derived inside the secure element and never guessable — the level is built from it.",
      state: at(2, session !== null, player !== null && session === null),
    },
    {
      short: "Run played",
      what: "Play the run",
      why: "Every keypress is recorded as a tick-stamped log. The score stays local for now.",
      state: at(3, game.result !== null, session !== null && game.result === null),
    },
    {
      short: "Log sent",
      what: "Send the log, not the score",
      why: "The request has no score field at all. There is nothing to inflate.",
      state: at(4, attestation !== null, game.result !== null && attestation === null),
    },
    {
      short: "Enclave signed",
      what: "The enclave replays and signs",
      why: "Same sim.wasm, same seed, its own answer — signed by a key that never leaves the Processor.",
      state: at(5, attestation !== null, busy === "attest"),
    },
    {
      short: "On-chain",
      what: "The contract checks the signature",
      why: "Asset Hub recovers the signer, matches it against its verifier set, and takes the score.",
      state: at(6, landed, busy === "submit"),
    },
  ];

  return (
    <section className="play" id="play">
      <div className="container">
        {/* The cabinet gets the full width; everything else sits under it. */}
        <div className="cabinet" ref={cabinetRef}>
          <div className="stage">
            <div ref={mountRef} className="pixi" />

            {!game.ready && !game.error && <div className="overlay">loading sim.wasm…</div>}
            {game.error && <div className="overlay bad">{game.error}</div>}
            {/* Art is an enhancement: when the pack does not load the game
                still runs, drawn from primitives. Saying so makes a sandbox
                that will not serve public/art/ diagnosable from the page
                instead of only from the console. */}
            {game.ready && !game.art && <div className="art-notice dim">simple graphics</div>}
            {/* Before a run. The two overlays are mutually exclusive on
                `session`, so toggling the simulator mid-result drops back to
                this one rather than stacking both. */}
            {game.ready && !session && (
              <div className="overlay">
                <h2>Ready</h2>
                {player ? (
                  <>
                    <p>The Acurast Processor hands out the seed. The seed is what the level is build of</p>
                    <div className="overlay-actions">
                      <button onClick={() => void play()} disabled={busy !== null || exhausted}>
                        {playLabel}
                      </button>
                    </div>
                    {exhausted && <p className="dim">That is every run for this hour.</p>}
                  </>
                ) : (
                  <>
                    <p>Your seed is derived from your address, so nobody can play your session for you.</p>
                    <div className="overlay-actions">
                      <button className="ghost" onClick={connect} disabled={connecting}>
                        {connecting ? "Connecting…" : "Connect an account"}
                      </button>
                    </div>
                  </>
                )}
                <p className="dim">
                  <kbd>←</kbd> <kbd>→</kbd> move · <kbd>space</kbd> jump — hold it, a tap is a shorter hop
                </p>
              </div>
            )}

            {/* After one. The enclave's verdict is repeated here, not only in
                the card below the cabinet, because in fullscreen there is no
                below — and the whole point of the run is that number. */}
            {game.result && session && (
              <div className="overlay">
                <h2>
                  {game.result.won ? "Reached the goal" : game.result.lives === 0 ? "Out of lives" : "Time up"}
                </h2>
                <p>
                  this device scored <b>{String(game.result.score)}</b> over {game.result.ticks} ticks
                </p>

                {attestation ? (
                  <p className={BigInt(attestation.claim.score) === game.result.score ? "ok" : "bad"}>
                    the enclave replayed {attestation.ticks} ticks and computed <b>{attestation.claim.score}</b> —{" "}
                    {BigInt(attestation.claim.score) === game.result.score
                      ? "it agrees"
                      : "it disagrees, and its number is the one that counts"}
                  </p>
                ) : (
                  <p className="dim">{game.result.inputLog.length} log entries — now let the enclave recompute it</p>
                )}

                <div className="overlay-actions">
                  <button onClick={() => void finish()} disabled={busy !== null || attestSettled}>
                    {attestLabel}
                  </button>
                  <button className="ghost" onClick={() => void play()} disabled={busy !== null || exhausted}>
                    {playLabel}
                  </button>
                </div>
                {exhausted && <p className="dim">That is every run for this hour.</p>}
              </div>
            )}

            <div className="stage-controls">
              <button onClick={() => setMuted(!muted)} aria-pressed={muted}>
                {muted ? "Sound off" : "Sound on"}
              </button>
              <button onClick={toggleFull}>{full ? "Exit fullscreen" : "Fullscreen"}</button>
            </div>
          </div>

          <Hud
            hud={game.hud}
            result={game.result}
            seed={session?.seed ?? null}
            icons={game.icons}
          />
          <TouchPad onPress={game.press} />
        </div>

        <section className="panel stepper" aria-label="Proof trace">
          <ProofRail steps={steps} />
        </section>

        {attestation && game.result && (
          <Verdict device={game.result.score} enclave={BigInt(attestation.claim.score)} ticks={attestation.ticks} />
        )}

        <div className="play-below">
          <section className="panel">
            <div className="panel-head">
              <h2>Session</h2>
              <span className="note">
                {simulating ? "simulated enclave" : app ? "polkadot host connected" : "standalone — no host"}
              </span>
            </div>
            <div className="panel-body">
              <div className="field-row">
                <div className="field grow">
                  <label htmlFor="account">Account</label>
                  {account ? (
                    <span className="identity">
                      <span>{short(account.address)}</span>
                      <span className="arrow">→ plays as</span>
                      <span>{player ? short(player) : "—"}</span>
                    </span>
                  ) : (
                    <button id="account" className="ghost" onClick={connect} disabled={connecting}>
                      {connecting ? "Connecting…" : "Connect wallet"}
                    </button>
                  )}
                </div>
              </div>

              <div className="field-row">
                <div className="field grow">
                  <label htmlFor="verifier">Verifier enclave</label>
                  <input
                    id="verifier"
                    value={verifier}
                    spellCheck={false}
                    disabled={simulating}
                    placeholder="https://<tunnel>.trycloudflare.com"
                    onChange={(e) => setVerifier(e.target.value)}
                  />
                  {simulating && <span className="hint">unused while the simulator is on</span>}
                </div>
              </div>

              {/* Development only. This whole block is compiled away in a
                  build, along with the simulator it switches on. */}
              {import.meta.env.DEV && (
                <div className="field-row">
                  <div className="field grow">
                    <span className="label">Development</span>
                    <div className="dev-row">
                      <button className="ghost" onClick={toggleSimulation} aria-pressed={simulated}>
                        {simulated ? "Simulator: on" : "Simulate the enclave"}
                      </button>
                      <span className="hint">
                        {simulated
                          ? "Seeds, replay and the EIP-712 signature are computed here, by a key that is in the source. Play and attest work with nothing deployed; submitting is refused."
                          : "Runs the verifier in this tab so play and attest work without an Acurast job or a tunnel."}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Play and Attest are not repeated here. They live on the
                  screen, where they stay reachable in fullscreen; a second
                  copy would be both redundant and a competing call to action.

                  No attempt number appears anywhere either. Which slot the
                  protocol is spending is bookkeeping the player has no decision
                  to make about — it only ever surfaces as "you are out of runs
                  for now", and in the technical log. */}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Log</h2>
              <span className="note">{lines.length} lines</span>
            </div>
            <div className="trace">
              {lines.length === 0 && (
                <div className="empty">Connect an account, then start a session. Everything the app does lands here.</div>
              )}
              {lines.map((l, i) => (
                <div key={i} className={l.kind}>
                  {l.text}
                </div>
              ))}
              {attestation && (
                <details>
                  <summary>Signed attestation</summary>
                  <pre>{JSON.stringify(attestation, null, 2)}</pre>
                </details>
              )}
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
