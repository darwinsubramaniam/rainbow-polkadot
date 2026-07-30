// Submitting an attestation through the Product host.
//
// A Product holds no keys. Signing and chain RPC are both lent by the host —
// the Polkadot app on mobile/desktop, or the web gateway — so everything here
// goes through the SDK rather than through a local signer or a relay server.

import { createContractFromClient, type AbiEntry } from "@parity/product-sdk/contracts";
import { ss58ToH160 } from "@parity/product-sdk/address";
import { applyWeightBuffer, ensureAccountMapped, type ReviveApi, type Weight } from "@parity/product-sdk-tx";
import { requestResourceAllocation } from "@parity/product-sdk/host";
import type { SignerAccount } from "@parity/product-sdk/wallet";
import type { App } from "@parity/product-sdk/core";

import type { Attestation } from "./enclave";
import { CONTRACT, LEADERBOARD_ABI, claimTuple, reconstructSignature } from "./leaderboard";
import { ASSET_HUB, CONTRACT_ACCOUNT_INDEX, PRODUCT_NAME } from "./network";
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
  // Idempotent: connections are cached by the SDK, so calling this per submit
  // costs nothing after the first.
  await app.chain.connect({ assetHub: ASSET_HUB });
  const client = app.chain.getRawClient(ASSET_HUB);
  const account = await contractAccount();

  // `defaultSigner`/`defaultOrigin` rather than `signerManager`, and
  // deliberately not both: the documented resolution order puts `signerManager`
  // *above* the static signer, so passing the manager as well would silently
  // reinstate the player's wallet as the sender and undo the whole point.
  return createContractFromClient(
    client,
    ASSET_HUB,
    CONTRACT as `0x${string}`,
    LEADERBOARD_ABI as unknown as AbiEntry[],
    { defaultSigner: account.getSigner(), defaultOrigin: account.address },
  );
}

/** Method handle by name. The generic contract type indexes as possibly-undefined. */
function method(contract: ReturnType<typeof createContractFromClient>, name: string) {
  const m = (contract as Record<string, unknown>)[name];
  if (!m) throw new Error(`contract has no method ${name}`);
  return m as {
    query: (
      ...args: unknown[]
    ) => Promise<{ success: boolean; value: unknown; gasRequired?: Weight }>;
    tx: (...args: unknown[]) => Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
  };
}

/** Current best score on the board for a player. Read-only, needs no account. */
export async function readBest(app: App, gameId: number, player: string): Promise<bigint> {
  const contract = await contractHandle(app);
  const res = await method(contract, "best").query(BigInt(gameId), player);
  return BigInt(res.value as bigint);
}

export interface SubmitOutcome {
  txHash?: string;
  best: bigint;
  matches: boolean;
}

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
async function ensureContractAllowance(): Promise<void> {
  const result = await requestResourceAllocation([
    { tag: "SmartContractAllowance", value: CONTRACT_ACCOUNT_INDEX },
  ]);

  if (!result.ok) {
    throw new Error(`the host refused the contract allowance request: ${result.error.message}`);
  }

  const [outcome] = result.value;
  if (outcome !== "Allocated") {
    // "Rejected" means the user declined; "NotAvailable" means this host build
    // does not offer it. Both are worth distinguishing from a chain failure.
    throw new Error(
      `host did not grant a smart-contract allowance (outcome: ${outcome}). ` +
        `Without it Polkadot Desktop will not submit contract transactions.`,
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
 * `ensureAccountMapped` is the SDK's own helper and returns `ok(null)` when the
 * account is already mapped, so this stays a cheap read rather than a
 * transaction each time.
 *
 * @returns true if a mapping transaction was actually submitted.
 */
async function ensureMapped(app: App): Promise<boolean> {
  // The *product* account, not the player's: it is the one that will sign, so
  // it is the one `pallet-revive` needs a mapping for. Mapping the player's
  // wallet would be both impossible (no allowance to submit with) and pointless
  // (it never sends anything).
  const account = await contractAccount();

  // `getClient` requires the chain to be connected, and this runs *before*
  // `contractHandle` does it. Connecting is cached by the SDK, so doing it here
  // costs nothing and removes the ordering dependency between the two.
  await app.chain.connect({ assetHub: ASSET_HUB });

  // `ASSET_HUB` is a union across the three networks the build can target, so
  // the typed client widens to a union too and TypeScript will not see `Revive`
  // as present on all arms — even though every Asset Hub here has it. Narrowed
  // rather than loosened: the shape asserted below is exactly the two calls this
  // function makes, so a descriptor that genuinely lacked `Revive` would still
  // fail at runtime on the very next line rather than somewhere unrelated.
  const api = app.chain.getClient(ASSET_HUB) as unknown as ReviveApi & {
    query: {
      Revive: { OriginalAccount: { getValue(h160: string): Promise<unknown> } };
    };
  };

  const checker = {
    addressIsMapped: async (addr: string) =>
      (await api.query.Revive.OriginalAccount.getValue(ss58ToH160(addr))) !== undefined,
  };

  const result = await ensureAccountMapped(account.address, account.getSigner(), checker, api);
  if (!result.ok) {
    // Surface the mapping failure as itself. Letting it fall through to the
    // contract call would resurface as AccountUnmapped, which reads like the
    // mapping was never attempted.
    const e = result.error;
    throw new Error(`could not map your account for contract calls: ${e.message ?? String(e)}`);
  }
  return result.value !== null;
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
 */
export async function submitAttestation(
  app: App,
  att: Attestation,
  enclaveAddress: string,
  onMapping?: () => void,
): Promise<SubmitOutcome> {
  const signature = reconstructSignature(att, enclaveAddress);

  // Order matters: the allowance is what lets the host submit anything at all,
  // and `map_account` is itself a contract-adjacent transaction that needs it.
  // Both are one-time and both are prompts, so they run before the contract
  // call rather than surfacing as a failure after the player has already played.
  await ensureContractAllowance();
  if (await ensureMapped(app)) onMapping?.();

  const contract = await contractHandle(app);
  const submit = method(contract, "submit");

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
    // The dry-run already knows this will revert. Submitting anyway would spend
    // a transaction to be told the same thing, and would consume the session.
    throw new Error(`the leaderboard rejected this attestation: ${JSON.stringify(dry.value)}`);
  }

  const gasLimit = dry.gasRequired
    ? applyWeightBuffer(dry.gasRequired, { percent: 100 })
    : undefined;

  // `.tx()` reports failure on the `err` channel rather than throwing, so an
  // unchecked call would look like success and then read back an unchanged best.
  const result = await submit.tx(claimTuple(att), signature, gasLimit ? { gasLimit } : undefined);
  if (!result.ok) {
    const err = result.error;
    throw err instanceof Error ? err : new Error(String(err));
  }

  const best = await readBest(app, att.claim.gameId, att.claim.player);
  return {
    txHash: (result.value as { txHash?: string } | undefined)?.txHash,
    best,
    matches: best === BigInt(att.claim.score),
  };
}
