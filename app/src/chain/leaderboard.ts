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

// The deployed Leaderboard address, chosen by the build's target network.
// Re-exported here so existing importers keep working; `network.ts` owns it,
// because the address and the chain it lives on must never be picked apart.
export { CONTRACT } from "./network";

/**
 * Minimal ABI — only what this app calls.
 *
 * Hand-written rather than pulled from forge's output so the bundle carries a
 * few hundred bytes instead of the full artifact. The tuple's field order is
 * load-bearing: EIP-712 encodes positionally, so a reordering here would
 * produce a digest the contract does not recognise.
 */
export const LEADERBOARD_ABI = [
  {
    type: "function",
    name: "submit",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "c",
        type: "tuple",
        components: [
          { name: "player", type: "address" },
          { name: "gameId", type: "uint64" },
          { name: "score", type: "uint64" },
          { name: "epoch", type: "uint64" },
          { name: "k", type: "uint32" },
          { name: "rulesHash", type: "bytes32" },
          { name: "expiry", type: "uint64" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "best",
    stateMutability: "view",
    inputs: [
      { name: "gameId", type: "uint64" },
      { name: "player", type: "address" },
    ],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function",
    name: "playerCount",
    stateMutability: "view",
    inputs: [{ name: "gameId", type: "uint64" }],
    outputs: [{ type: "uint256" }],
  },
  {
    // The output *names* are load-bearing, not documentation: the SDK decodes a
    // multi-output call into an object keyed by them, so dropping them would
    // hand back `{_0, _1}` instead of `{players, scores}`.
    type: "function",
    name: "board",
    stateMutability: "view",
    inputs: [
      { name: "gameId", type: "uint64" },
      { name: "offset", type: "uint256" },
      { name: "limit", type: "uint256" },
    ],
    outputs: [
      { name: "players", type: "address[]" },
      { name: "scores", type: "uint64[]" },
    ],
  },
  {
    type: "function",
    name: "currentEpoch",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function",
    name: "gameRules",
    stateMutability: "view",
    inputs: [{ name: "gameId", type: "uint64" }],
    outputs: [{ type: "bytes32" }],
  },
] as const;

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
