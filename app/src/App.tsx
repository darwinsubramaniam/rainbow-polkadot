import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { ProductSDKContext } from "@parity/product-sdk/react";

import { useGame } from "./game/useGame";
import { attest, identity, openSession, type Attestation, type Identity, type Session } from "./chain/enclave";
import { playerAddress, submitAttestation } from "./chain/submit";
import { addressOf } from "./chain/leaderboard";
import { connectWallet, useSignerState } from "./chain/wallet";
import { Hud } from "./ui/Hud";
import { TouchPad } from "./ui/TouchPad";
import { useStoredString } from "./ui/useStoredString";
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

type LogKind = "info" | "ok" | "bad";
interface Line {
  kind: LogKind;
  text: string;
}

export function App() {
  // Read the context rather than `useProductSDK()`: that hook throws when the
  // provider is absent, and absent is a supported state here — no host means no
  // chain access, but the game and the enclave round-trip still work.
  const app = useContext(ProductSDKContext);
  const signer = useSignerState();
  const mountRef = useRef<HTMLDivElement | null>(null);
  const game = useGame(mountRef);

  const [verifier, setVerifier] = useStoredString("rainbow.verifier", DEFAULT_VERIFIER);
  const [draft, setDraft] = useState("");
  const [slot, setSlot] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const [enclave, setEnclave] = useState<Identity | null>(null);
  const [attestation, setAttestation] = useState<Attestation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);

  const say = useCallback((text: string, kind: LogKind = "info") => {
    setLines((l) => [...l.slice(-60), { kind, text }]);
  }, []);

  useEffect(() => {
    if (verifier && !draft) setDraft(verifier);
  }, [verifier, draft]);

  // Announce standalone mode once, so the missing Submit button is explained
  // rather than just broken.
  useEffect(() => {
    if (!app && standaloneReason.value) {
      say(`no Polkadot host: ${standaloneReason.value}`, "info");
      say("running standalone — play and attestation work, on-chain submit does not.", "info");
    }
  }, [app, say]);

  const account = signer.selectedAccount ?? signer.accounts[0] ?? null;
  // The H160 pallet-revive maps this account to. It is what the contract
  // credits AND what the enclave hashes into sessionId, so it must be derived
  // identically on both sides.
  const player = account ? playerAddress(account.address) : null;
  const connecting = signer.status === "connecting";

  // -- session -------------------------------------------------------------

  const newSession = useCallback(async () => {
    const base = (draft || verifier || "").trim();
    if (!base) return say("set the verifier URL first", "bad");
    if (!player) return say("connect a wallet first — the seed is bound to your address", "bad");

    setBusy("session");
    setAttestation(null);
    try {
      setVerifier(base);

      const id = await identity(base);
      setEnclave(id);
      say(`enclave gameId ${id.gameId}, rulesHash ${id.rulesHash.slice(0, 14)}…`);

      const s = await openSession(base, player, slot);
      setSession(s);
      say(`session epoch ${s.epoch} slot ${s.k} — seed ${s.seed}`, "ok");
      say(`the level below was generated from that seed, inside sim.wasm`);

      game.start(BigInt(s.seed));
    } catch (e) {
      say(`session failed: ${e instanceof Error ? e.message : String(e)}`, "bad");
    } finally {
      setBusy(null);
    }
  }, [draft, verifier, player, slot, setVerifier, say, game]);

  // -- attest + submit -----------------------------------------------------

  const finish = useCallback(async () => {
    const base = (draft || verifier || "").trim();
    if (!session || !game.result || !player || !enclave) return;

    setBusy("attest");
    try {
      say(`sending ${game.result.inputLog.length} log entries — no score is sent…`);
      const att = await attest(base, player, session.epoch, session.k, game.result.inputLog);
      setAttestation(att);

      const theirs = BigInt(att.claim.score);
      const ours = game.result.score;
      say(`enclave replayed ${att.ticks} ticks and computed ${theirs}`);
      if (theirs === ours) {
        say(`AGREES with this device (${ours}) — same wasm, same log, same answer`, "ok");
      } else {
        say(`DISAGREES: device ${ours}, enclave ${theirs}. The enclave's is authoritative.`, "bad");
      }

      if (!app) {
        say("no host — stopping before submit. The attestation below is valid and", "info");
        say("can be landed from the CLI with scripts/serve-game.mjs.", "info");
        return;
      }

      setBusy("submit");
      say("submitting to the leaderboard…");
      // The enclave address only picks the signature's recovery id; the
      // contract recovers the signer itself and checks its own verifier set,
      // so a wrong value here reverts rather than forging an acceptance.
      const out = await submitAttestation(app, att, addressOf(enclave.secp256k1));
      say(`best(${att.claim.gameId}) is now ${out.best}`, out.matches ? "ok" : "bad");
    } catch (e) {
      say(`failed: ${e instanceof Error ? e.message : String(e)}`, "bad");
    } finally {
      setBusy(null);
    }
  }, [draft, verifier, session, game.result, player, enclave, app, say]);

  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  return (
    <div className="wrap">
      <header>
        <h1>Rainbow</h1>
        <p>Run, jump, stomp. The score is recomputed inside a TEE and proven on-chain.</p>
      </header>

      <div className="stage">
        <div ref={mountRef} className="pixi" />
        {!game.ready && !game.error && <div className="overlay">loading sim.wasm…</div>}
        {game.error && <div className="overlay bad">{game.error}</div>}
        {game.ready && !session && <div className="overlay">press <b>New session</b> for a seed</div>}
        {game.result && (
          <div className="overlay">
            <h2>{game.result.won ? "REACHED THE GOAL" : game.result.lives === 0 ? "OUT OF LIVES" : "TIME UP"}</h2>
            <p>
              device score <b>{String(game.result.score)}</b> over {game.result.ticks} ticks
              <br />
              <span className="dim">{game.result.inputLog.length} log entries — now let the enclave recompute it</span>
            </p>
          </div>
        )}
      </div>

      <Hud hud={game.hud} result={game.result} seed={session?.seed ?? null} />
      <TouchPad onPress={game.press} />

      <section className="panel">
        <div className="row">
          <label htmlFor="account">account</label>
          {account ? (
            <span className="mono">
              {short(account.address)} <span className="dim">→ player</span> {player ? short(player) : "—"}
            </span>
          ) : (
            <button
              onClick={() => {
                connectWallet()
                  .then((m) =>
                    say(
                      m === "host"
                        ? "connected through the Polkadot host"
                        : "no host found — using dev accounts. Play and attestation work; on-chain submit needs the host.",
                      m === "host" ? "ok" : "info",
                    ),
                  )
                  .catch((e: unknown) =>
                    say(`wallet: ${e instanceof Error ? e.message : String(e)}`, "bad"),
                  );
              }}
              disabled={connecting}
            >
              {connecting ? "connecting…" : "Connect wallet"}
            </button>
          )}
        </div>

        <div className="row">
          <label htmlFor="verifier">verifier</label>
          <input
            id="verifier"
            value={draft}
            spellCheck={false}
            placeholder="https://<tunnel>.trycloudflare.com"
            onChange={(e) => setDraft(e.target.value)}
          />
          <label htmlFor="slot">slot k</label>
          <input
            id="slot"
            type="number"
            min={0}
            max={11}
            value={slot}
            onChange={(e) => setSlot(Number(e.target.value))}
          />
        </div>

        <div className="row">
          <button onClick={() => void newSession()} disabled={busy !== null || !game.ready}>
            {busy === "session" ? "asking the enclave…" : "New session"}
          </button>
          <button
            className="ghost"
            onClick={() => void finish()}
            disabled={busy !== null || !game.result || !session}
          >
            {busy === "attest" ? "attesting…" : busy === "submit" ? "submitting…" : "Attest & submit"}
          </button>
          {session && (
            <button className="ghost" onClick={() => game.start(BigInt(session.seed))} disabled={busy !== null}>
              Replay seed
            </button>
          )}
          <span className="dim">← → move · space jump</span>
        </div>
      </section>

      <section className="panel log">
        {lines.length === 0 && <div className="dim">Connect a wallet, set the verifier URL, then start a session.</div>}
        {lines.map((l, i) => (
          <div key={i} className={l.kind}>
            {l.text}
          </div>
        ))}
        {attestation && (
          <details>
            <summary className="dim">attestation</summary>
            <pre>{JSON.stringify(attestation, null, 2)}</pre>
          </details>
        )}
      </section>
    </div>
  );
}
