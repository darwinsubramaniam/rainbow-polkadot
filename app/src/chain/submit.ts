// Submitting an attestation through the Product host.
//
// A Product holds no keys. Signing and chain RPC are both lent by the host —
// the Polkadot app on mobile/desktop, or the web gateway — so everything here
// goes through the SDK rather than through a local signer or a relay server.

import { createContractFromClient, type AbiEntry } from "@parity/product-sdk/contracts";
import { ss58ToH160 } from "@parity/product-sdk/address";
import type { App } from "@parity/product-sdk/core";

import type { Attestation } from "./enclave";
import { CONTRACT, LEADERBOARD_ABI, claimTuple, reconstructSignature } from "./leaderboard";
import { ASSET_HUB } from "./network";
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

async function contractHandle(app: App) {
  // Idempotent: connections are cached by the SDK, so calling this per submit
  // costs nothing after the first.
  await app.chain.connect({ assetHub: ASSET_HUB });
  const client = app.chain.getRawClient(ASSET_HUB);

  // `signerManager` resolves the selected account at call time, so switching
  // accounts is reflected without rebuilding the handle.
  return createContractFromClient(
    client,
    ASSET_HUB,
    CONTRACT as `0x${string}`,
    LEADERBOARD_ABI as unknown as AbiEntry[],
    { signerManager: currentManager() },
  );
}

/** Method handle by name. The generic contract type indexes as possibly-undefined. */
function method(contract: ReturnType<typeof createContractFromClient>, name: string) {
  const m = (contract as Record<string, unknown>)[name];
  if (!m) throw new Error(`contract has no method ${name}`);
  return m as {
    query: (...args: unknown[]) => Promise<{ value: unknown }>;
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
 * Land an attestation on the leaderboard.
 *
 * `enclaveAddress` comes from the enclave's `/identity`, but note that trusting
 * it is not required: it is used only to pick the right recovery id. The
 * contract independently recovers the signer and checks it against its own
 * `isVerifier` set, so a wrong address here produces a revert, never a forged
 * acceptance.
 */
export async function submitAttestation(
  app: App,
  att: Attestation,
  enclaveAddress: string,
): Promise<SubmitOutcome> {
  const signature = reconstructSignature(att, enclaveAddress);
  const contract = await contractHandle(app);

  // `.tx()` reports failure on the `err` channel rather than throwing, so an
  // unchecked call would look like success and then read back an unchanged best.
  const result = await method(contract, "submit").tx(claimTuple(att), signature);
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
