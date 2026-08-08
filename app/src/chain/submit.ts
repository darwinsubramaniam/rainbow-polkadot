// Submitting an attestation through the Product host.
//
// A Product holds no keys. Signing and chain RPC are both lent by the host —
// the Polkadot app on mobile/desktop, or the web gateway — so everything here
// goes through the SDK rather than through a local signer or a relay server.

import { ss58ToH160 } from "@parity/product-sdk/address";
import { ensureContractAccountMapped } from "@parity/product-sdk/contracts";
import { applyWeightBuffer, type Weight } from "@parity/product-sdk-tx";
import { requestResourceAllocation } from "@parity/product-sdk/host";

import type { SignerAccount } from "@parity/product-sdk/wallet";
import type { App } from "@parity/product-sdk/core";

import { readCurrentDay, readSessionSpent, readYourBest } from "./board";
import { contractRuntime, leaderboard } from "./contract";
import type { Attestation } from "./enclave";
import { claimTuple, reconstructSignature } from "./leaderboard";
import { isContractRevert, revertMessage } from "./revert";
import { CONTRACT_ACCOUNT_INDEX, PRODUCT_NAME } from "./network";
import { currentManager } from "./wallet";

/**
 * The EVM address a Substrate account maps to under `pallet-revive`.
 *
 * This is the `player` the contract credits, and it is also what the enclave
 * hashes into `sessionId`. It must be derived the same way in both places or
 * the seed the player receives belongs to a different session than the one they
 * eventually submit.
 */
export const playerAddress = (ss58: string): string => ss58ToH160(ss58);

/**
 * How much head-room to add to the dry-run's weight estimate, or `null` to send
 * no `gasLimit` at all and let `.tx()` size the call itself.
 *
 * A knob rather than a literal because the two failure modes it sits between
 * are opposite, and only measurement tells them apart. Too little and the
 * transaction dispatches then dies with `Revive.OutOfGas` — the fee is spent
 * and nothing lands. That is why this was 100 rather than the 50 the SDK's own
 * examples use.
 *
 * But a buffered `Weight` is two u64s the app has *chosen*, and it is the only
 * value on this path the app invents rather than passes through — which makes
 * it the first thing to suspect when the host's transport fails to decode the
 * submission at all:
 *
 *     Transport error RangeError: Offset is outside the bounds of the DataView
 *
 * `null`, on evidence rather than preference: this is the only configuration
 * observed to land a score through the host. Setting a buffer sends the
 * three-argument form of `.tx()` and calls `applyWeightBuffer`, and a published
 * build doing so threw `TypeError: a is not a function` — a path that has never
 * completed a submit here.
 *
 * The cost is real and known: `.tx()` then sizes the call from its own dry-run,
 * which is the arrangement that once produced `Revive.OutOfGas` — the
 * transaction dispatches, dies, and the fee is spent for nothing. That is a
 * bounded, understood failure; the alternative currently throws every time.
 *
 * To revisit, reproduce on `localhost` first — Polkadot Desktop loads it
 * unminified, so the stack names the actual function instead of `a`. Do not
 * restore a number on reasoning alone; this constant has now been changed twice
 * on an argument and wrong both times.
 *
 * ## 2026-08-05: the premise above no longer holds, so this is a knob
 *
 * "The only configuration observed to land a score through the host" stopped
 * being true. On Polkadot Desktop, against the daily-board contract, `null`
 * *never* lands: `submit.query()` returns a real estimate through the host
 * (`ref_time 4724409599 proof_size 338849`) and the following `.tx()` then never
 * settles at all — no success, no rejection, until the 90s timeout gives up and
 * reads `usedSession` to confirm nothing landed. Reproducible, not flaky.
 *
 * The same signed claim lands in one block through papi and a direct RPC, so
 * the calldata and the contract are not implicated, and `@parity/product-sdk`
 * 0.20.0 → 0.20.1 is a version-bump cascade whose `dist` is byte-identical on
 * this path — the client is not obviously wrong either.
 *
 * That left the two-argument versus three-argument `.tx()` shape as the one
 * thing this app still controls, so the value is read from the environment
 * rather than edited — an A/B that needs a source change is an A/B nobody runs:
 *
 *     VITE_WEIGHT_BUFFER=none npm run dev    # default — 2-arg .tx()
 *     VITE_WEIGHT_BUFFER=100 npm run dev     # 3-arg .tx() with applyWeightBuffer
 *
 * ## The A/B has now been run, and the answer is no
 *
 * At 100, unminified on `localhost` inside Polkadot Desktop, the step marker
 * reported `dry-run: ref_time 2044408160 proof_size 154255 · sending: ref_time
 * 4088816320 proof_size 308510` — the buffer plainly applied — and `.tx()` then
 * hung for the full 90 seconds exactly as it does with no gas limit at all.
 * **Both shapes hang.** Gas sizing is not the cause and this knob does not fix
 * anything; it stays only so the next person can confirm that in one command
 * instead of a code change.
 *
 * ## 2026-08-08: that A/B was invalid, and its conclusion is withdrawn
 *
 * "Both shapes hang" was measured while the app and the host disagreed about the
 * wire format — `@parity/truapi` ≥ 0.6 encodes `DerivationIndex` with an extra tag
 * byte that shifts every field after the signer, so the host destroyed the payload
 * before it was ever sent (see the header comment in `network.ts`). *Every* `.tx()`
 * hung, at every buffer value, for a reason upstream of gas. The experiment could
 * not distinguish its two arms, so it said nothing about gas sizing.
 *
 * With the SDK pinned to 0.19.1 the transaction dispatches for real, and the
 * distinction is live again — immediately, on the first run:
 *
 *     gas — dry-run: ref_time 3760506106 proof_size 267146 · sending: none
 *     failed: Transaction dispatch failed: Revive.OutOfGas
 *
 * Which is exactly the failure this comment predicts for `null` thirty lines up.
 * `.tx()` sizes from its own dry-run with no headroom, and this submission was the
 * first entry on that day's board, so it wrote storage the measured path had not.
 * A dry-run is exact only for the path it measured.
 *
 * The session survived — `OutOfGas` reverts state, so `usedSession` stayed false
 * and only the fee was spent.
 *
 * One thing did improve: the three-argument path no longer throws
 * `TypeError: a is not a function`. That failure is fixed somewhere in the SDK
 * since it was recorded, so the historic reason for preferring `null` is gone
 * even though `null` remains the default on the "unchanged unless measured"
 * principle below.
 *
 * The warning above stands and applies to the *default*. Do not change what
 * this resolves to with no variable set on the strength of one good run; change
 * it when a build that ships it has landed a score.
 *
 * ## 2026-08-08: a score has landed, so the default is now 100
 *
 * That condition is met. With the SDK pinned to a host-compatible version, the
 * two arms finally separate — and they separate immediately and in opposite
 * directions, on consecutive runs of the same session:
 *
 *     none → dry-run ref_time 3760506106 proof_size 267146 · sending: none
 *            failed: Transaction dispatch failed: Revive.OutOfGas
 *     100  → landed: usedSession true, dailyPlayerCount 0 → 1, dailyBest 235
 *
 * So the default is `100`, and `none` is now the opt-out rather than the shipped
 * behaviour.
 *
 * `100` is a *percentage*: `applyWeightBuffer` computes `weight * (100 + percent)
 * / 100` on both components, so it doubles them. The SDK's own default is 25.
 *
 * Doubling stays inside the chain's limits, but by less margin than the two
 * components suggest, and it is worth knowing which one binds. Against Asset Hub's
 * normal-dispatch budget (~1.5e12 ref_time, ~3.9 MB PoV), the buffered submit above
 * declares ~0.5% of the ref_time and **~14% of the proof size**. `proof_size` is
 * the constraint here, not compute — this call touches a lot of storage and barely
 * computes. Anyone raising this further should check that number, not ref_time.
 *
 * Over-declaring is close to free: the fee is reserved from the declared limit and
 * Substrate refunds the difference between declared and actual weight after
 * dispatch. Under-declaring costs the whole fee and lands nothing. That asymmetry,
 * not the size of the estimate, is the argument for a buffer at all.
 *
 * What made the old default wrong was never the number. It was that its evidence
 * had been gathered through a broken codec, which failed every arm for a reason
 * that had nothing to do with gas — so an honest A/B produced a confident and
 * completely inverted conclusion. Worth remembering before trusting any other
 * measurement taken in that window.
 */
const WEIGHT_BUFFER_ENV = import.meta.env.VITE_WEIGHT_BUFFER;

/** The shipped buffer, applied when `VITE_WEIGHT_BUFFER` is unset. */
const DEFAULT_WEIGHT_BUFFER_PERCENT = 100;

/**
 * @see WEIGHT_BUFFER_PERCENT's note. Unset means the default buffer above;
 * `none` and `null` are the explicit opt-out and send no `gasLimit` at all.
 * Anything else must parse as a non-negative number, and fails at startup rather
 * than at the end of a run.
 *
 * For the record, since it looks like a suspect and is not one: the gas numbers
 * are unremarkable. The dry-run measured `ref_time 1977244047,
 * proof_size 145374`, and doubling those is nowhere near a u64 boundary. The
 * `RangeError` once blamed on this resolved, through Desktop's own source maps,
 * to `device-sync/transport.ts` — an unhealthy device session between Desktop
 * and the paired phone, fixed by re-syncing them.
 */
const WEIGHT_BUFFER_PERCENT: number | null = (() => {
  if (!WEIGHT_BUFFER_ENV) return DEFAULT_WEIGHT_BUFFER_PERCENT;
  if (WEIGHT_BUFFER_ENV === "none" || WEIGHT_BUFFER_ENV === "null") return null;
  const parsed = Number(WEIGHT_BUFFER_ENV);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `VITE_WEIGHT_BUFFER must be a non-negative number, "none" or unset — got "${WEIGHT_BUFFER_ENV}"`,
    );
  }
  return parsed;
})();

/**
 * The account that sends contract transactions.
 *
 * **Not the player's wallet**, and that is the whole point. A Product gets its
 * own accounts derived from its dotNS name, and the host sponsors them: that is
 * what `SmartContractAllowance` pre-warms. A player's personal wallet has no
 * allowance and is not meant to acquire one, so the host refuses to submit
 * anything signed by it —
 *
 *     HostFailure: Submit failed, no allowance set for account
 *
 * — including the `map_account` that would map it, which is why the player's
 * address stays unmapped no matter how many times you try.
 *
 * The player is still credited. The contract reads `player` out of the signed
 * claim, never `msg.sender`, so who *sends* the transaction is irrelevant to
 * who *owns* the score. This is the same relaying the devnet bring-up proved:
 * sent by one account, credited to another.
 *
 * Cached: the derivation is a host round-trip and this runs on every submit.
 */
let productAccount: SignerAccount | null = null;

async function contractAccount(): Promise<SignerAccount> {
  if (productAccount) return productAccount;

  const result = await currentManager().getProductAccount(PRODUCT_NAME, CONTRACT_ACCOUNT_INDEX);
  if (!result.ok) {
    throw new Error(
      `could not derive this product's contract account (${PRODUCT_NAME} #${CONTRACT_ACCOUNT_INDEX}): ${result.error.message}`,
    );
  }

  productAccount = result.value;
  return productAccount;
}

async function contractHandle(app: App) {
  const account = await contractAccount();

  // `defaultSigner`/`defaultOrigin` rather than `signerManager`, and
  // deliberately not both: the documented resolution order puts `signerManager`
  // *above* the static signer, so passing the manager as well would silently
  // reinstate the player's wallet as the sender and undo the whole point.
  return leaderboard(app, { defaultSigner: account.getSigner(), defaultOrigin: account.address });
}

/**
 * Current best score on a board for a player. Pass a day for the daily board.
 *
 * Delegated to the board's read-only handle rather than built on
 * `contractHandle` here, and the comment this replaced said why without acting
 * on it: a view "needs no account". The handle above binds the product's signer
 * and origin, which costs a host round trip to derive — wasted on a read, and
 * this path makes four of them.
 */
export const readBest = readYourBest;

export interface SubmitOutcome {
  txHash?: string;
  /** The player's all-time best after this submission landed. */
  best: bigint;
  /** The player's best on today's board after this submission landed. */
  dailyBest: bigint;
  /** The day index the score was filed under — `dayOf(epoch)`, from the chain. */
  day: number;
  /** True when this run raised the all-time best rather than merely being recorded. */
  improvedAllTime: boolean;
  /** True when this run raised today's best. */
  improvedToday: boolean;
}

/**
 * The contract has already consumed this session, so the attestation is dead.
 *
 * Its own class because the caller must do something specific about it: mark the
 * stored record spent so the next Play mints a fresh slot. Left unhandled, the
 * app offers the same seed forever and every submission of it reverts.
 *
 * Not a failure of the run. The run happened, the enclave signed for it, and
 * some *other* submission of the same slot landed — from another device, or from
 * `scripts/attest-and-submit.mjs` rescuing a submit the host hung on. The score
 * that beat it is on the board either way.
 */
export class SessionAlreadySpent extends Error {
  constructor(
    readonly epoch: number,
    readonly k: number,
  ) {
    super(
      `session ${k} of epoch ${epoch} has already been submitted — ` +
        `the board already holds whatever it scored. Play again for a fresh slot.`,
    );
    this.name = "SessionAlreadySpent";
  }
}

/*
 * `NotAnImprovement` used to be declared here, and its absence is the point of
 * this file now.
 *
 * The contract records every well-formed attestation, so there is no longer an
 * outcome where a genuine run is refused. What used to be the most common end
 * to a submit — "the board already holds a better number, nothing happened" —
 * is now a transaction that lands, consumes its session, and reports
 * `improvedAllTime: false`. The distinction the old error class existed to
 * carry is a boolean on the success path.
 */

/**
 * Ask the host to pre-allocate the allowance a contract call needs.
 *
 * This is a *host* gate, not a chain one. Polkadot Desktop refuses to submit a
 * contract transaction from an account it has no allowance for, and says so
 * before the chain is involved at all:
 *
 *     HostFailure: Submit failed, no allowance set for account
 *
 * `SmartContractAllowance` is described by the host API as a "pre-warmed PGAS
 * balance for the smart-contract account at the given derivation index". The
 * host prompts once; operations covered by the grant do not re-prompt.
 *
 * The index must be the same one `contractAccount()` derives with, or the host
 * pre-warms one account and we submit from another. Both read
 * `CONTRACT_ACCOUNT_INDEX` for that reason.
 *
 * The failure path reports the host's own outcome verbatim: "Rejected" means the
 * user declined, "NotAvailable" means this host build does not offer the
 * resource at all, and those want very different responses.
 */
async function ensureContractAllowance(step: (t: string) => void = () => {}): Promise<void> {
  // Log who this is for, next to who will sign.
  //
  // `no allowance set for account` names no account, and the failure it
  // describes is precisely a *mismatch* between two of them: the host pre-warms
  // the product account at `CONTRACT_ACCOUNT_INDEX`, and the transaction is
  // signed by whatever `contractAccount()` derived. If those ever differ, every
  // symptom is identical to the allowance simply not being granted, and nothing
  // in either log distinguishes the two. So print both before asking.
  const signer = await contractAccount();
  // `warn`, not `info`: Polkadot Desktop's console proxy forwards only `warn`
  // and `error` from a Product's webview, so an `info` line is invisible in the
  // one place these are read. Not a severity claim — a delivery one.
  console.warn(
    `[rainbow] allowance: product "${PRODUCT_NAME}" index ${CONTRACT_ACCOUNT_INDEX} · signer ${signer.address}`,
  );

  const result = await requestResourceAllocation([
    // Plain `u32`, for the reason recorded in `wallet.ts` and `network.ts`.
    { tag: "SmartContractAllowance", value: CONTRACT_ACCOUNT_INDEX },
    { tag: "AutoSigning" },
  ]);

  if (!result.ok) {
    console.warn("[rainbow] allowance: request returned err", result.error);
    throw new Error(`the host refused the contract allowance request: ${result.error.message}`);
  }

  // The whole array, not just the first entry. Outcomes are positional against
  // the resources asked for, so a length that is not 1 means the host answered
  // something other than the question — worth seeing rather than indexing past.
  console.warn(`[rainbow] allowance: outcomes ${JSON.stringify(result.value)}`);
  step(`allowance outcomes ${JSON.stringify(result.value)}`);

  // Positional against the resources asked for, so both are named rather than
  // indexed past. They fail differently and the difference is the diagnosis: no
  // allowance means the host refuses to submit at all and says so, whereas no
  // `AutoSigning` means signing has to go out to the Polkadot App per call —
  // which is the path observed accepting a transaction and never answering.
  const [allowance, autoSigning] = result.value;
  if (allowance !== "Allocated") {
    // "Rejected" means the user declined; "NotAvailable" means this host build
    // does not offer it. Both are worth distinguishing from a chain failure.
    throw new Error(
      `host did not grant a smart-contract allowance (outcome: ${allowance}). ` +
        `Without it Polkadot Desktop will not submit contract transactions.`,
    );
  }

  // Deliberately not fatal. Without it a submit still *should* work — it just
  // prompts per call instead of signing silently — so refusing to proceed would
  // turn a degraded path into no path. Said out loud because if the submit then
  // hangs, this line is the first thing worth reading.
  if (autoSigning !== "Allocated") {
    console.warn(`[rainbow] auto-signing not granted (outcome: ${autoSigning})`);
    step(
      `auto-signing not granted (${autoSigning}) — signing will need approval on your Polkadot App`,
    );
  }
}

/**
 * Give the product's contract account its `pallet-revive` mapping.
 *
 * Every account that signs a PolkaVM transaction needs a one-time `map_account`
 * first — the quickstart lists it as a prerequisite, but only for a developer's
 * CLI account. Without it the submit dry-run fails with:
 *
 *     Dry-run failed for "submit": Revive / AccountUnmapped
 *
 * which lands at the very end of a run, after the player has already earned an
 * enclave-signed attestation. The worst possible moment to hand someone a CLI
 * command, so the app does it itself.
 *
 * It is done once per *product*, not once per player, because the product
 * account is the sender. Every player after the first finds it already mapped.
 *
 * `ensureContractAccountMapped` is the SDK's own helper and returns `ok(null)`
 * when the account is already mapped, so this stays a cheap read rather than a
 * transaction each time.
 *
 * It replaced a hand-rolled equivalent, and what went with it is the point: a
 * `getClient` call cast through `unknown` to a `ReviveApi` intersection, and a
 * `checker` object reimplementing `Revive.OriginalAccount.getValue(ss58ToH160(…))`.
 * The cast existed because `ASSET_HUB` is a union across three networks, so the
 * typed client widens to a union and TypeScript will not see `Revive` on every
 * arm. The contracts package takes a `ContractRuntime` instead, which is built
 * from the raw client and carries no descriptor union to narrow.
 *
 * @returns true if a mapping transaction was actually submitted.
 */
async function ensureMapped(app: App, step: (t: string) => void = () => {}): Promise<boolean> {
  // The *product* account, not the player's: it is the one that will sign, so
  // it is the one `pallet-revive` needs a mapping for. Mapping the player's
  // wallet would be both impossible (no allowance to submit with) and pointless
  // (it never sends anything).
  const account = await contractAccount();

  // Connects if needed — the runtime is built from the host's raw client, and
  // that is cached, so this costs nothing after the first call.
  const runtime = await contractRuntime(app);

  // Which of the two transactions this function can trigger is which.
  //
  // `ensureContractAccountMapped` *submits* when the account is unmapped, so the
  // host's `Submit failed, no allowance set for account` can come from here
  // rather than from the contract call — and the two are indistinguishable in
  // Desktop's own log, which names neither the app nor the call. Saying "already
  // mapped" versus "submitting map_account" up front separates them for free.
  //
  // Which account is about to be mapped, said *before* the call so it is on the
  // record even if the call is the thing that hangs.
  //
  // This used to read the mapping first, via `isContractAccountMapped`, and say
  // "already mapped" versus "UNMAPPED — will submit map_account" up front. That
  // helper does not exist in `product-sdk-contracts` 0.9.2, which is the version
  // the host-compatible SDK pin brings with it (see `network.ts`), and the only
  // ways to keep the up-front form would be the `unknown`-cast `ReviveApi`
  // reimplementation this function was rewritten to delete. So the distinction is
  // reported after the fact instead — `ensureContractAccountMapped` resolves with
  // `null` when it found the account already mapped and a `TxResult` when it
  // actually submitted, which is the same fact one call later.
  console.warn(`[rainbow] mapping: checking ${account.address}`);
  step("checking whether the sender is mapped…");

  const result = await ensureContractAccountMapped(runtime, account.address, account.getSigner(), {
    // The helper's own progress, into the app's log. Mapping is one of the three
    // submits on this path that can fail with the same host message, and it is
    // the only one that used to report nothing at all between "submitting" and
    // whatever came back.
    onStatus: (s) => step(`map_account: ${s}`),
  });
  if (!result.ok) {
    // Surface the mapping failure as itself. Letting it fall through to the
    // contract call would resurface as AccountUnmapped, which reads like the
    // mapping was never attempted.
    const e = result.error;
    throw new Error(`could not map your account for contract calls: ${e.message ?? String(e)}`);
  }

  // The state the up-front probe used to print, now read off the outcome.
  const submitted = result.value !== null;
  console.warn(
    `[rainbow] mapping: ${account.address} ${submitted ? "was UNMAPPED — map_account submitted" : "already mapped"}`,
  );
  step(submitted ? "sender mapped by this run" : "sender already mapped");
  return submitted;
}

/**
 * How long any single *read* on this path may take before we stop waiting.
 *
 * Much shorter than the submit timeout, because these are dry-runs: no
 * signature, no block, no user to approve anything. A host that has not answered
 * a view call in twenty seconds is not busy, it is not answering.
 *
 * This exists because it was missing and the gap was visible: nothing bounded the
 * reads, so a host whose transport had
 * stopped responding left the app sitting on "reading the boards…" with no
 * error, no progress and no timeout — forever, since a promise that never
 * settles is not a failure any `catch` will ever see. Observed on Polkadot
 * Desktop after a previous submit had already hung.
 *
 * A read that times out is reported, not swallowed: it means the host is in a
 * state where the submit that follows cannot work either, and saying so early is
 * better than failing four steps later for a reason that looks unrelated.
 */
const READ_TIMEOUT_MS = 20_000;

/** Reject rather than hang if `what` does not settle. */
async function withReadTimeout<T>(what: Promise<T>, label: string): Promise<T> {
  const timeout = Symbol("timeout");
  const raced = await Promise.race([
    what,
    new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), READ_TIMEOUT_MS)),
  ]);
  if (raced === timeout) {
    throw new Error(
      `the host did not answer ${label} within ${READ_TIMEOUT_MS / 1000}s. ` +
        `This is a plain chain read — no signature and no transaction — so a host that ` +
        `cannot serve it will not be able to submit either. Reload the app, and if it ` +
        `persists restart Polkadot Desktop.`,
    );
  }
  return raced;
}


/**
 * Land an attestation on the leaderboard.
 *
 * `enclaveAddress` comes from the enclave's `/identity`, but note that trusting
 * it is not required: it is used only to pick the right recovery id. The
 * contract independently recovers the signer and checks it against its own
 * `isVerifier` set, so a wrong address here produces a revert, never a forged
 * acceptance.
 *
 * `onMapping` fires only when a one-time `map_account` was actually submitted,
 * so the UI can explain the extra wallet prompt instead of leaving the player
 * wondering what they just approved.
 *
 * `onStep` reports which stage is running, into the app's own log.
 *
 * Not decoration, and not temporary. This function performs four host round
 * trips — allowance, mapping, dry-run, submit — and three of them can fail with
 * the *same* host message, `Submit failed, no allowance set for account`,
 * because `map_account` and the contract call are both submits. Without a step
 * marker there is no way to tell which one died, and the host's own console
 * names neither the app nor the call. `console.warn` is not a substitute:
 * Polkadot Desktop forwards only some levels from a Product's webview, so the
 * app's own log panel is the one channel guaranteed to reach the player.
 */
export async function submitAttestation(
  app: App,
  att: Attestation,
  enclaveAddress: string,
  onMapping?: () => void,
  onStep?: (text: string) => void,
): Promise<SubmitOutcome> {
  const step = (text: string) => onStep?.(text);

  // The generated type for a `bytes` parameter is `Uint8Array`. The encoder
  // underneath disagrees, and the encoder is the one that has to be satisfied:
  // `@parity/product-sdk-contracts` hands positional arguments straight to
  // viem's `encodeFunctionData` with no normalisation, and viem's `bytes` path
  // wants a `0x…` string. Measured, not assumed — passing the 65 bytes as a
  // `Uint8Array` throws before anything reaches the chain:
  //
  //     TypeError: hex_.replace is not a function
  //
  // So the hex string stays and the cast goes here, alone, with this note.
  // Converting `reconstructSignature` to return bytes in order to satisfy
  // `cdm install`'s type would compile cleanly and break every submit.
  const signature = reconstructSignature(att, enclaveAddress) as unknown as Uint8Array;

  // Where the boards stood before this run. Read for the *report*, never to
  // decide whether to proceed — that distinction is the whole change.
  //
  // The pre-flight this replaced asked the same question and threw
  // `NotAnImprovement` on the answer, which stopped the most common submit in
  // the app before it started. Now the contract accepts every well-formed
  // attestation, so these two dry-runs exist only so the outcome can say "new
  // best" rather than making the UI guess by comparing against a board snapshot
  // that was read before the run and may be minutes stale.
  //
  // Two view calls, no wallet prompt, no gas.
  step("reading the boards…");
  const day = await withReadTimeout(readCurrentDay(app), "currentDay");
  const beforeAllTime = await withReadTimeout(
    readBest(app, att.claim.gameId, att.claim.player),
    "your all-time best",
  );
  const beforeToday = await withReadTimeout(
    readBest(app, att.claim.gameId, att.claim.player, day),
    "your best today",
  );

  // Before spending anything on a submit, ask whether this session is already
  // gone. It can be: a submit whose transaction landed while the host never
  // answered leaves the chain and this browser disagreeing, and so does a slot
  // rescued out of band. Both end in `SessionAlreadyUsed` after four host round
  // trips and a wallet prompt, which is a bad way to learn a free view call
  // could have said so first.
  //
  // Reported as its own error so `Play` can reconcile the stored record rather
  // than offering the same dead seed again.
  step("checking this session is still unspent…");
  const spent = await withReadTimeout(
    readSessionSpent(app, att.claim.player, att.claim.epoch, att.claim.k),
    "usedSession",
  );
  if (spent) throw new SessionAlreadySpent(att.claim.epoch, att.claim.k);

  // Order matters: the allowance is what lets the host submit anything at all,
  // and `map_account` is itself a contract-adjacent transaction that needs it.
  // Both are one-time and both are prompts, so they run before the contract
  // call rather than surfacing as a failure after the player has already played.
  const signer = await contractAccount();
  step(`sender ${signer.address} — ${PRODUCT_NAME} #${CONTRACT_ACCOUNT_INDEX}`);

  step("asking the host for a contract allowance…");
  await ensureContractAllowance(step);

  step("checking the sender's pallet-revive mapping…");
  if (await ensureMapped(app, step)) onMapping?.();

  const contract = await contractHandle(app);
  const submit = contract.submit;

  step("dry-running submit…");

  // Size the call ourselves rather than letting `.tx()` size it.
  //
  // `.tx()` runs its own dry-run and submits with what that returns, and on
  // this contract that estimate came back short — the transaction dispatched
  // and then died with `Revive.OutOfGas`, which costs the fee and lands
  // nothing. A dry-run measures one execution path; the real one re-runs
  // ECDSA recovery and touches storage the estimate can under-count.
  //
  // So take the estimate and give it room. `applyWeightBuffer` defaults to 25%,
  // which was evidently not enough; 100% is cheap insurance because a gas
  // *limit* is a ceiling, not a charge — pallet-revive refunds what the call
  // does not use, so over-provisioning costs nothing when the estimate was fine.
  const dry = await submit.query(claimTuple(att), signature);

  if (!dry.success) {
    // The dry-run already knows this will fail. Submitting anyway would spend a
    // transaction to be told the same thing, and would consume the session.
    //
    // Two different failures arrive here under one `success: false`, and they
    // blame opposite things. A *revert* is the leaderboard refusing the claim —
    // an expired attestation, an untrusted verifier, a session already spent.
    // A *dispatch* failure is the call never reaching the contract at all, and
    // `AccountNotMapped` is the one that matters: it means the mapping step four
    // lines up did not take, which is a fault in the sender, not in the run.
    // Calling that "the leaderboard rejected this attestation" sends whoever
    // reads it to the one place the bug is not.
    throw new Error(
      isContractRevert(dry.value)
        ? `the leaderboard rejected this attestation: ${revertMessage(dry.value)}`
        : `the submit could not run: ${revertMessage(dry.value)}`,
    );
  }

  const gasLimit =
    WEIGHT_BUFFER_PERCENT !== null && dry.gasRequired
      ? applyWeightBuffer(dry.gasRequired, { percent: WEIGHT_BUFFER_PERCENT })
      : undefined;

  // The actual numbers, because this is the one value the app *chooses* and the
  // transport has to encode. A `Weight` is two u64s, and a buffered one is the
  // only place here where a plausible number becomes an implausible one.
  const w = (x?: Weight) => (x ? `ref_time ${x.ref_time} proof_size ${x.proof_size}` : "none");
  step(`gas — dry-run: ${w(dry.gasRequired)} · sending: ${w(gasLimit)}`);

  // `.tx()` reports failure on the `err` channel rather than throwing, so an
  // unchecked call would look like success and then read back an unchanged best.
  step("dry-run passed — submitting the transaction…");

  // Omit the options argument entirely rather than passing `undefined`.
  //
  // `submit(claim, signature)` takes two parameters, and the SDK decides what a
  // third argument *is* by counting arguments, not by checking for undefined.
  // Passing `undefined` explicitly still makes `arguments.length === 3`, so it
  // is read as a call value and viem refuses to encode:
  //
  //     ABI encoding params/values length mismatch.
  //     Expected length (params): 2 · Given length (values): 3
  //
  // Latent until the gas limit became conditional — before that the third
  // argument was always an object.
  const result = await submit.tx(claimTuple(att), signature, { gasLimit });

  if (!result.ok) {
    const err = result.error;
    throw err instanceof Error ? err : new Error(String(err));
  }

  const best = await readBest(app, att.claim.gameId, att.claim.player);
  const dailyBest = await readBest(app, att.claim.gameId, att.claim.player, day);
  return {
    txHash: (result.value as { txHash?: string } | undefined)?.txHash,
    best,
    dailyBest,
    day,
    // Compared against the values read before the submit rather than against the
    // claimed score. `best === score` would call a run a new record when an
    // earlier run had already scored exactly the same, which is the one case a
    // "new best" badge must not get wrong.
    improvedAllTime: best > beforeAllTime,
    improvedToday: dailyBest > beforeToday,
  };
}
