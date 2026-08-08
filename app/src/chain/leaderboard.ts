// Landing an attestation on the Leaderboard contract.
//
// Two jobs live here. The first is recovering the signature's `v` byte, which
// the enclave cannot supply. The second is the contract call itself, which goes
// through the host wallet — a Product never holds keys of its own.

// @noble v2 publishes explicit ".js" subpath exports; the extensionless form
// does not resolve.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { Attestation } from "./enclave";

// The failure vocabulary lives in `revert.ts`; re-exported so callers keep
// reaching for one module when they talk to this contract.
export { revertMessage } from "./revert";

// The deployed Leaderboard address. Re-exported here so existing importers keep
// working; `contract.ts` owns it, because it comes out of `cdm.json` alongside
// the ABI and the two must never be picked apart.
export { CONTRACT } from "./contract";

// The ABI used to live here — ~150 hand-written lines, "minimal" on the grounds
// that the bundle should carry a few hundred bytes instead of the full artifact.
// It is now `cdm.json`'s, via `contract.ts`. The saving was real but the cost
// was not visible: the table declared nine errors and the deployed contract has
// thirteen, so four of them reached a player as raw selectors, and every call
// site had to cast the handle to `Record<string, unknown>` because a
// hand-written array carries no types.

/** Ethereum address for a secp256k1 public key. */
export function addressOf(pub: string): string {
  const uncompressed = secp256k1.Point.fromHex(pub.replace(/^0x/, "")).toBytes(false).slice(1);
  return "0x" + bytesToHex(keccak_256(uncompressed)).slice(-40);
}

/**
 * Rebuild the 65-byte signature the contract needs.
 *
 * Acurast's `signer_sign` returns 64 bytes of `r‖s` with no recovery id, while
 * `ECDSA.recover` needs 65 with `v ∈ {27,28}`. Both candidates are tried and the
 * one recovering to the enclave's known address wins.
 *
 * Guessing wrong is not a hazard: a wrong `v` recovers some other address, the
 * contract's `isVerifier` check fails, and the call reverts. It cannot be
 * steered into recovering to a *different* trusted verifier.
 */
export function reconstructSignature(att: Attestation, enclaveAddress: string): string {
  const rs = hexToBytes(att.signature.replace(/^0x/, ""));
  if (rs.length !== 64) throw new Error(`expected 64-byte r‖s, got ${rs.length}`);

  const digest = hexToBytes(att.digest.replace(/^0x/, ""));
  const want = enclaveAddress.toLowerCase();

  for (const rec of [0, 1]) {
    const packed = new Uint8Array(65);
    packed[0] = rec;
    packed.set(rs, 1);
    try {
      const pub = secp256k1.recoverPublicKey(packed, digest, { prehash: false });
      if (addressOf(bytesToHex(pub)).toLowerCase() === want) {
        return "0x" + bytesToHex(rs) + (27 + rec).toString(16).padStart(2, "0");
      }
    } catch {
      // This recovery id yields no valid point; try the other.
    }
  }
  throw new Error("no recovery id yields the enclave address");
}

/** The claim tuple, shaped for the contract call. */
export function claimTuple(att: Attestation) {
  const c = att.claim;
  return {
    player: c.player,
    gameId: BigInt(c.gameId),
    score: BigInt(c.score),
    epoch: BigInt(c.epoch),
    k: c.k,
    rulesHash: c.rulesHash,
    expiry: BigInt(c.expiry),
  };
}
