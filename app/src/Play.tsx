import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
import { resolveMode, type Slot, type Tier } from "./chain/mode";
import { addressOf } from "./chain/leaderboard";
import { GAME_ID } from "./chain/network";
import { useBoard } from "./chain/useBoard";
import { markLanded, remember, type RunRecord } from "./chain/history";
import { connectHost, connectWallet, useSignerState } from "./chain/wallet";
import { useProcessorHealth, type Health } from "./chain/health";
import { Hud } from "./ui/Hud";
import { TouchPad } from "./ui/TouchPad";
import { ProofRail, type Step, type StepState } from "./ui/ProofRail";
import { ProofFlow } from "./ui/ProofFlow";
import { StageNotice } from "./ui/StageNotice";
import { processorState } from "./ui/processor";
import { useMedia } from "./ui/useMedia";
import { short } from "./ui/short";
import { Verdict } from "./ui/Verdict";
import { TopBoard } from "./ui/TopBoard";
import { YourRuns } from "./ui/YourRuns";
import { Log, type Line, type LogKind } from "./ui/Log";
import { useStoredJson, useStoredString } from "./ui/useStored";
import { standaloneReason } from "./main";

/**
 * Verifier the app points at out of the box.
 *
 * Baked in only as a convenience default, and always overridable in the UI —
 * the value the user types wins and is persisted locally.
 *
 * `VITE_VERIFIER_URL` overrides it at build time. The literal below is the
 * named-tunnel hostname from `VERIFIER_HOSTNAME` in `acurast-verifier/.env`:
 * because the phone attaches as a connector to a tunnel *we* own, the hostname
 * lives in Cloudflare rather than in the job, and survives a restart or a
 * reassignment to a different processor. That is what makes a baked-in constant
 * worth having — the previous fallback was a quick-tunnel hostname minted at
 * boot, which went stale the moment its job ended.
 *
 * Note this pins a *hostname*, not a key. Every deployment mints its own
 * secp256k1 key, so the address behind this URL rotates on each redeploy and
 * must be registered with `setVerifier` before attestations from it are
 * accepted. The URL being stable is what stops the *hostname* churning; it says
 * nothing about which signer is currently on the other end.
 */
const DEFAULT_VERIFIER =
  import.meta.env.VITE_VERIFIER_URL || "https://rainbow-verifier.dw3labs.work";

/**
 * Retire a stored quick-tunnel URL left over from before the named tunnel.
 *
 * A `*.trycloudflare.com` hostname is minted at boot by an unauthenticated
 * tunnel and dies with the job that minted it, so a stored one is dead *by
 * construction* — it cannot be a verifier anyone is deliberately pointing at,
 * only a leftover from a job that has since ended. Those we replace.
 *
 * Everything else is left exactly as stored, because a stored value normally
 * means someone typed it: a verifier on localhost, a second deployment on its
 * own tunnel, a colleague's phone. Migrating on "differs from the default"
 * would silently overwrite all of those, which is why the test is the dead
 * hostname rather than the mismatch.
 *
 * Parsed rather than pattern-matched: `endsWith` on the raw string would also
 * catch `https://evil.example/?x=.trycloudflare.com`, and anything unparseable
 * is left alone rather than guessed at.
 */
const retireQuickTunnel = (stored: string): string => {
  let host: string;
  try {
    host = new URL(stored).hostname;
  } catch {
    return stored;
  }
  return host.endsWith(".trycloudflare.com") ? DEFAULT_VERIFIER : stored;
};

/** Only the parts of a session the UI and the attestation actually need. */
interface Active {
  epoch: number;
  k: number;
  seed: string;
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
  const walletPlayer = account ? playerAddress(account.address) : null;

  // Persisted, because a player who turned the sound off meant it. Applied to
  // the sound module by the effect below rather than passed down, so toggling
  // it mid-run re-renders nothing that the game loop touches.
  const [muted, setMuted] = useStoredJson("rainbow.muted", false);

  // Persisted, and no longer editable from the UI: the field that used to set it
  // lived in the Session sheet, which is now the log alone. What is actually in
  // use is drawn on the tunnel in the proof diagram, and the value itself comes
  // from `VITE_VERIFIER_URL` at build time. A stored one from before still wins,
  // and `localStorage.rainbow.verifier` is the way to point a browser at a
  // verifier on localhost.
  const [verifier] = useStoredString(
    "rainbow.verifier",
    DEFAULT_VERIFIER,
    retireQuickTunnel,
  );

  // An enclave that answers from this tab instead of a deployed job. Persisted
  // so a reload does not silently put the app back on a tunnel that is not
  // running.
  //
  // This used to be gated on `import.meta.env.DEV`, so a build could not reach
  // it at all. That gate is gone deliberately: an Acurast job ends, and until
  // the contract can start one itself, a player arriving at a dead Processor
  // had no way to see the game at all. They can now run the enclave here.
  //
  // What has NOT been relaxed is anything that keeps it honest. A simulated
  // attestation is signed by a key that is printed in this repository, so it
  // is never submitted, its runs are kept in their own history, and both the
  // log and the UI label it. It is a way to see the machine work, not a way
  // to reach the leaderboard.
  const [simulated, setSimulated] = useStoredJson("rainbow.simulate", false);
  const [sim, setSim] = useState<Enclave | null>(null);

  // Everything the rest of this component is allowed to do, in one value.
  //
  // Read `chain/mode.ts` before adding a capability check anywhere below. The
  // tiers are enumerated there precisely so that "can this submit", "does this
  // player have an on-chain record" and "which storage slot is this" cannot
  // drift apart from each other, which is what happens when each question is
  // answered locally at the point it is asked.
  const mode = useMemo(
    () => resolveMode({ walletPlayer, simulatorOn: simulated, hasHost: !!app }),
    [walletPlayer, simulated, app],
  );
  const player = mode.player;
  const simulating = mode.enclave === "simulated";

  const mountRef = useRef<HTMLDivElement | null>(null);
  // The address is passed for one reason only: it picks which of the pack's
  // five characters the player is drawn as, so a returning player is the same
  // character every time. It reaches nothing that is attested — which is why a
  // guest address does the job here as well as a real one does.
  const game = useGame(mountRef, player);

  // Also depends on `ready`: the preference is set before the audio has
  // finished loading, and would otherwise be dropped on the floor.
  const applyMuted = game.setMuted;
  useEffect(() => {
    applyMuted(muted);
  }, [muted, game.ready, applyMuted]);

  // One session record and one run list per tier, keyed by `mode.slot`.
  //
  // A seed the simulator issued means nothing to the deployed one — each
  // derives its own from its own key — and a guest's means nothing to either,
  // since it is bound to an address no wallet controls. A held run must never
  // be replayed or attested across that line, and the attempt budgets are
  // likewise unrelated. Separate slots are what make changing tier safe rather
  // than a source of mystifying score disagreements.
  //
  // All three hooks run on every render, because hooks must; the tier only
  // picks which pair is in use. That also means switching tier switches the
  // session and the history together, never one without the other.
  const recordSlots: Record<Slot, ReturnType<typeof useStoredJson<SessionRecord | null>>> = {
    "": useStoredJson<SessionRecord | null>("rainbow.session", null),
    ".sim": useStoredJson<SessionRecord | null>("rainbow.session.sim", null),
    ".guest": useStoredJson<SessionRecord | null>("rainbow.session.guest", null),
  };
  const historySlots: Record<Slot, ReturnType<typeof useStoredJson<RunRecord[]>>> = {
    "": useStoredJson<RunRecord[]>("rainbow.history", []),
    ".sim": useStoredJson<RunRecord[]>("rainbow.history.sim", []),
    ".guest": useStoredJson<RunRecord[]>("rainbow.history.guest", []),
  };
  const [record, setRecord] = recordSlots[mode.slot];
  const [history, setHistory] = historySlots[mode.slot];

  const [session, setSession] = useState<Active | null>(null);
  const [enclave, setEnclave] = useState<Identity | null>(null);
  const [attestation, setAttestation] = useState<Attestation | null>(null);
  const [landed, setLanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<number | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [logOpen, setLogOpen] = useState(false);

  // Bumped whenever the board is known to have changed — a landed score — or
  // when the player asks. A view call is a dry-run, not a subscription, so
  // nothing tells the app that someone else's run went on-chain.
  const [boardKey, setBoardKey] = useState(0);
  // A guest address has no on-chain record to look up, and asking for one would
  // spend a dry-run to be told zero. The top of the board is still read — it is
  // public, and worth seeing before you decide to connect anything.
  const board = useBoard(app ?? null, GAME_ID, mode.hasOnChainRecord ? player : null, boardKey);

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

  // Ask the host for its account as soon as we know there is a host.
  //
  // Only when `app` is set, so this never runs outside a container and the dev
  // fallback still needs a press. Guarded by a ref rather than by
  // `walletPlayer`, so a host that legitimately has no account is asked once
  // and not on a loop.
  const askedHost = useRef(false);
  useEffect(() => {
    if (!app || askedHost.current) return;
    askedHost.current = true;
    void connectHost().then((e) => {
      if (e) say(`host has no account for this Product yet: ${e.message}`, "info");
    });
  }, [app, say]);

  // Say what a guest is, once, on entering the tier — not once per mount.
  //
  // A guest is dropped into a working game with no ceremony, which is the
  // point, but silence would leave them to discover the limits by hitting
  // them. The ref holds the tier last announced, so connecting an account and
  // disconnecting again says it again, while a re-render does not.
  const saidTier = useRef<Tier | null>(null);
  useEffect(() => {
    if (saidTier.current === mode.tier) return;
    const first = saidTier.current === null;
    saidTier.current = mode.tier;
    if (mode.tier !== "guest") {
      if (!first) say(`account connected — ${mode.summary}`, "ok");
      return;
    }
    say("playing as a guest — no account, so nothing here can reach the chain", "info");
    say("the enclave runs in this tab: real seeds, real replay, real signature, nothing submitted.", "info");
    say("connect an account to play against the deployed enclave and land a score.", "info");
  }, [mode.tier, mode.summary, say]);

  // Pull the simulator in only when it is actually switched on. Still a
  // dynamic import: it is now reachable from a build, but the overwhelming
  // majority of visits never touch it, and they should not pay to download it.
  useEffect(() => {
    if (!simulating || sim) return;

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
  }, [simulating, sim, say]);

  const connecting = signer.status === "connecting";

  // Asked once as soon as the page is open, then every quarter of an hour. The
  // player should learn that the Processor is not there from the diagram, not
  // from a Play button that fails after they committed to it.
  //
  // Probed even while the enclave is simulated, and that is the whole point of
  // not passing null here: someone who switched the simulator on because the
  // job was down needs to be told when it comes back, or they will sit in the
  // simulator indefinitely posting scores that can never land.
  //
  // Not probed for a guest, who has nothing to switch back to. Sending a
  // request every quarter hour to a Processor they cannot use would be traffic
  // spent to fill in a diagram box. `mode.probesProcessor` is the one line to
  // change if that judgement turns out to be wrong.
  const health = useProcessorHealth(mode.probesProcessor ? verifier.trim() || null : null);

  // Said once per transition, so the log carries the same story the diagram
  // does. The ref holds the last status announced: without it every re-render
  // that re-ran this effect would repeat the line.
  const saidHealth = useRef<Health | null>(null);
  useEffect(() => {
    if (health.status === "checking" || health.status === "unknown") return;
    if (saidHealth.current === health.status) return;
    saidHealth.current = health.status;
    if (health.status === "online") {
      say("Acurast Processor is answering", "ok");
      if (simulating) {
        say("switch the simulator off to play for the leaderboard again.", "info");
      }
    } else {
      say(`Acurast Processor is not answering — ${health.reason ?? "no response"}`, "bad");
      if (!simulating) {
        say("the job may have ended. You can simulate the enclave in this tab to see the flow.", "info");
      }
    }
  }, [health.status, health.reason, simulating, say]);

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
    // No wallet check here any more. `mode.player` is always an address — a
    // guest's if there is no account — and the guest tier is pinned to the
    // in-tab enclave, so there is nothing left that a missing wallet could
    // break at this point. What a guest cannot do is submit, and that is
    // checked where submitting happens.
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
        // Worth saying out loud rather than leaving to be discovered: the board
        // on screen is game GAME_ID, and a run attested for a different one
        // would land somewhere the player is not looking.
        if (id.gameId !== GAME_ID) {
          say(`the board shown is game ${GAME_ID}, but this enclave attests game ${id.gameId}`, "bad");
        }
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
    if (!session || !game.result || !enclave) return;

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

      // Remember the run now, before submitting. Whether it *lands* is a
      // separate fact — marked below if it does — but the run happened and the
      // enclave signed for it, and a submit that reverts should not erase that
      // from the player's own list.
      const attested = remember(history, {
        player,
        score: att.claim.score,
        ticks: att.ticks,
        epoch: session.epoch,
        k: session.k,
        at: Date.now(),
        agreed: theirs === ours,
        landed: false,
      });
      setHistory(attested);

      // The one gate, asked once. Every reason a run cannot reach the contract
      // — guest identity, simulated enclave, no host — is already decided in
      // `mode`, and re-deriving any of them here is how the three drift apart.
      //
      // Each reason matters for the same underlying purpose: a submit that
      // cannot succeed would spend a transaction to be told what is already
      // known, and would let the rail claim an on-chain step the run never
      // honestly reached.
      if (!mode.canSubmit) {
        say(`stopping before submit — ${mode.blockedReason ?? "this run cannot be submitted"}`, "info");
        if (mode.tier === "live") {
          // The attestation is real and still worth something without a host.
          say("the attestation below is valid and can be landed from the CLI.", "info");
        }
        return;
      }

      // Narrowing, not a second gate: `canSubmit` is only ever true when a host
      // is present, and TypeScript cannot see that through the Mode type.
      if (!app) return;

      stage = 6;
      setBusy("submit");
      say("submitting to the leaderboard…");
      // The enclave address only picks the signature's recovery id; the
      // contract recovers the signer itself and checks its own verifier set,
      // so a wrong value here reverts rather than forging an acceptance.
      const out = await submitAttestation(app, att, addressOf(enclave.secp256k1), () =>
        // A one-time `map_account`, and the reason two wallet prompts appear on
        // a player's first ever submit rather than one.
        say("first submit for this product — approving its one-time chain mapping…", "info"),
      );
      setLanded(out.matches);
      if (!out.matches) setFailed(6);
      say(`best(${att.claim.gameId}) is now ${out.best}`, out.matches ? "ok" : "bad");

      // Only an accepted submit consumes the session on-chain. A revert —
      // `NotAnImprovement` most often — leaves the attempt open, so the player
      // keeps the level rather than being charged for a rejected transaction.
      if (out.matches) {
        setRecord({ player, epoch: session.epoch, k: session.k, seed: session.seed, spent: true });
        setHistory(markLanded(attested, { player, epoch: session.epoch, k: session.k }));
        // The board just changed, and this is the one moment the app knows it.
        setBoardKey((k) => k + 1);
        const left = MAX_ATTEMPTS - (session.k + 1);
        say(left > 0 ? `session consumed — ${left} runs left this hour` : "no runs left this hour", "info");
      }
    } catch (e) {
      setFailed(stage);
      say(`failed: ${e instanceof Error ? e.message : String(e)}`, "bad");
    } finally {
      setBusy(null);
    }
  }, [
    verifier,
    simulating,
    sim,
    session,
    game.result,
    mode,
    player,
    enclave,
    app,
    setRecord,
    history,
    setHistory,
    say,
  ]);

  /**
   * Switch between the deployed enclave and the one in this tab.
   *
   * The in-flight session is dropped rather than carried across. The seed the
   * player holds was derived from a key only one of the two has, so attesting
   * it against the other would replay a different level and produce a score
   * that looks like a cheat rather than a mismatch of endpoints.
   */
  const toggleSimulation = useCallback(() => {
    // A guest is pinned to the in-tab enclave, so flipping the stored
    // preference here would change nothing visible and read as a broken
    // button. Say why instead. The preference is still recorded, so it takes
    // effect the moment an account is connected.
    if (mode.tier === "guest") {
      setSimulated(!simulated);
      say("playing as a guest, so the enclave stays in this tab — connect an account to reach the deployed one.", "info");
      return;
    }

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
  }, [simulated, setSimulated, mode.tier, say]);

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

  /**
   * The Processor's situation, for the strip on the cabinet.
   *
   * The same derivation the diagram's Processor box uses, so the two cannot
   * tell different stories about one machine. Memoised for the same reason it
   * is memoised there — `actions` is a fresh array each call, and this component
   * re-renders ten times a second for the whole length of a run.
   */
  const processor = useMemo(
    () =>
      processorState({
        health: health.status,
        simulated: simulating,
        simulationForced: mode.tier === "guest",
        onRecheck: health.recheck,
        onToggleSimulation: toggleSimulation,
      }),
    [health.status, health.recheck, simulating, mode.tier, toggleSimulation],
  );

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
  const attestSettled = attestation !== null && (landed || !mode.canSubmit);

  const attestLabel =
    busy === "attest"
      ? "Attesting…"
      : busy === "submit"
        ? "Submitting…"
        : landed
          ? "On the leaderboard"
          : attestSettled
            ? "Attested"
            : mode.canSubmit
              ? "Attest & submit"
              : mode.tier === "guest"
                ? "Attest (guest)"
                : "Attest (simulated)";

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

  /** Wide enough to draw the four parties rather than list the six steps. */
  const wide = useMedia("(min-width: 720px)");

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
      id: "account",
      short: "Account",
      where: "app",
      what: "Connect an account to this app",
      why: "Your seed is derived from your address, so nobody can play your session for you.",
      state: at(1, player !== null, player === null),
    },
    {
      id: "seed",
      short: "Seed issued",
      where: "processor",
      what: "This app asks the Processor for a seed, and it answers",
      why: "The verifier runs on an Acurast Processor — a phone dedicated to the network. It derives the seed inside its secure element, so nobody can work out the level in advance.",
      state: at(2, session !== null, player !== null && session === null),
    },
    {
      id: "run",
      short: "Run played",
      where: "you",
      what: "You play the run, here in this app",
      why: "Every keypress is recorded as a tick-stamped log. The score stays on this device for now — it is not what gets sent.",
      state: at(3, game.result !== null, session !== null && game.result === null),
    },
    {
      id: "log",
      short: "Log sent",
      where: "handoff",
      what: "This app sends the log to the Processor",
      why: "Your keypresses go, your score does not. The request has no score field at all, so there is nothing to inflate.",
      state: at(4, attestation !== null, game.result !== null && attestation === null),
    },
    {
      id: "signed",
      short: "Enclave signed",
      where: "processor",
      what: "The Processor replays the log and signs its own answer",
      why: "Same sim.wasm, same seed, worked out again inside the TEE — and signed by a key that never leaves the Processor.",
      state: at(5, attestation !== null, busy === "attest"),
    },
    {
      id: "chain",
      short: "On-chain",
      where: "chain",
      what: "The leaderboard contract checks that signature",
      why: "This app hands the signed score to the contract on Asset Hub, which recovers the signer, matches it against its own verifier set, and only then takes the score.",
      state: at(6, landed, busy === "submit"),
    },
  ];

  return (
    <section className="play" id="play">
      <div className="container">
        {/* The cabinet gets the full width; everything else sits under it. */}
        <div className="cabinet" ref={cabinetRef}>
          {/* Above the picture, not below it. A job that has ended is found out
              mid-play, so this has to be on the cabinet — it is the only place
              that says so at every width and inside fullscreen — but it must not
              come out of the game's own space. At the top of the column it is a
              band across the bezel; between the stage and the HUD it was a slice
              taken off the bottom of the screen. */}
          <StageNotice state={processor} />

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
              {/* Named rather than a gear, because there are no settings behind
                  it any more — the account, the verifier and the simulator have
                  each moved to where they are part of the picture. What is left
                  is the trace, which is for diagnosing something rather than for
                  playing, so it stays one press away. */}
              <button
                onClick={() => setLogOpen(true)}
                aria-expanded={logOpen}
                title="What the app has done, step by step"
              >
                Log
              </button>
            </div>

            {logOpen && (
              <Log onClose={() => setLogOpen(false)} lines={lines} attestation={attestation} />
            )}
          </div>

          <Hud
            hud={game.hud}
            result={game.result}
            seed={session?.seed ?? null}
            icons={game.icons}
          />
          <TouchPad onPress={game.press} />
        </div>

        {/* The diagram needs room to be a diagram. Below that it would be four
            boxes scaled into illegibility, so the narrow screen keeps the rail
            — same six steps, same state, read as a line instead of a map. */}
        <section className="panel stepper" aria-label="Proof trace">
          {wide ? (
            <ProofFlow
              steps={steps}
              // A guest's address is a shared placeholder, not theirs. Drawing
              // it here would turn step one into a claim that an account is
              // connected, which is exactly the step that has not happened.
              address={mode.isGuest ? null : short(player)}
              verifier={simulating ? null : verifier}
              simulationForced={mode.tier === "guest"}
              health={health.status}
              simulated={simulating}
              onToggleSimulation={toggleSimulation}
              onRecheck={health.recheck}
            />
          ) : (
            <ProofRail steps={steps} />
          )}
        </section>

        {attestation && game.result && (
          <Verdict device={game.result.score} enclave={BigInt(attestation.claim.score)} ticks={attestation.ticks} />
        )}

        {/* What the page under the game is *for*. The contract keeps a score per
            player and, since this deployment, the roster needed to enumerate
            them — so the board is chain state, ranked here for display. Your own
            runs sit beside it as this browser's memory of what the enclave
            signed, which is a weaker claim and labelled as one.

            The session controls and the technical log that used to occupy these
            two slots are behind the gear on the stage. */}
        <div className="play-below">
          <TopBoard view={board} you={player} onRefresh={() => setBoardKey((k) => k + 1)} />
          <YourRuns
            history={history}
            you={player}
            onChainBest={board.yourBest}
            simulated={simulating}
            guest={mode.isGuest}
          />
        </div>
      </div>
    </section>
  );
}
