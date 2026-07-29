#!/usr/bin/env node
// Call a PolkaVM contract on Asset Hub as the *Substrate* account.
//
// Two things make this necessary rather than reaching for `cast`:
//
// 1. `pallet-revive` gives a Substrate account a **mapped** H160. This contract's
//    owner is that mapped address (0x50AFf5a5… for sr25519 5GmrGRR2…), and there
//    is no ECDSA key behind it. `cast send --mnemonic` derives an Ethereum BIP44
//    key and signs as an entirely different address, so owner-only calls fail
//    with OwnableUnauthorizedAccount.
//
// 2. It uses **polkadot-api (papi)**, not @polkadot/api. Asset Hub Paseo expects
//    the newer extrinsic format; @polkadot/api builds version 4 and the runtime
//    then panics while decoding — `wasm 'unreachable' instruction executed` inside
//    TaggedTransactionQueue_validate_transaction. That failure looks like a bad
//    call but reproduces on `system.remark`, so it is the client, not the call.
//    dotns uses papi for the same reason.
//
//   node scripts/revive-call.mjs --to 0xCONTRACT --data 0xCALLDATA [--value 0] [--dry-run]
//
// Build calldata with: cast calldata "fn(type,...)" arg ...

// papi 0.21 exposes the ws provider at "polkadot-api/ws" (not
// "polkadot-api/ws-provider/node", which is the older layout) and ships no
// polkadot-sdk-compat subpath — Asset Hub is current enough not to need it.
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { getPolkadotSigner } from "polkadot-api/signer";
import { ah } from "@polkadot-api/descriptors";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const hexToBytes = (h) =>
  Uint8Array.from(h.replace(/^0x/, "").match(/../g)?.map((b) => parseInt(b, 16)) ?? []);

const DEFAULT_RPC = "wss://asset-hub-paseo-rpc.n.dwellir.com";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const to = arg("to");
const data = arg("data");
const value = BigInt(arg("value", "0"));
const rpc = arg("rpc", DEFAULT_RPC);
const network = arg("network", "devnet");
const dryRunOnly = process.argv.includes("--dry-run");

if (!to || !data) {
  console.error("usage: revive-call.mjs --to 0x… --data 0x… [--value 0] [--dry-run]");
  process.exit(1);
}

function mnemonic() {
  if (process.env.CDM_MNEMONIC) return process.env.CDM_MNEMONIC;
  const accts = JSON.parse(readFileSync(`${homedir()}/.cdm/accounts.json`, "utf8"));
  const m = accts?.[network]?.mnemonic;
  if (!m) throw new Error(`no mnemonic for "${network}" in ~/.cdm/accounts.json`);
  return m;
}

const kp = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(mnemonic())))("");
const signer = getPolkadotSigner(kp.publicKey, "Sr25519", kp.sign);

const client = createClient(getWsProvider(rpc));
const api = client.getTypedApi(ah);

console.log(`contract : ${to}`);
console.log(`data     : ${data.slice(0, 74)}${data.length > 74 ? "…" : ""}`);

try {
  // Field shapes taken from the generated descriptor, not guessed:
  //   dest: SizedHex<20>  — a plain hex string, NOT Binary
  //   weight_limit        — note: `weight_limit`, not `gas_limit`
  //   data: Uint8Array    — raw bytes, NOT Binary
  // Getting any of these wrong yields only "Incompatible runtime entry".
  const tx = api.tx.Revive.call({
    dest: to,
    value,
    // Ceilings, not charges: unused weight and deposit are not billed.
    weight_limit: {ref_time: 8_000_000_000n, proof_size: 800_000n},
    storage_deposit_limit: 20_000_000_000n,
    data: hexToBytes(data),
  });

  const fee = await tx.getEstimatedFees(kp.publicKey);
  console.log(`est. fee : ${fee}`);

  if (dryRunOnly) {
    client.destroy();
    process.exit(0);
  }

  const result = await tx.signAndSubmit(signer);
  console.log(`block    : ${result.block.hash} #${result.block.number}`);
  console.log(`ok       : ${result.ok}`);
  if (!result.ok) {
    console.error("dispatch error:", JSON.stringify(result.dispatchError));
    client.destroy();
    process.exit(1);
  }
  for (const ev of result.events) {
    if (ev.type === "Revive") console.log(`  event  : Revive.${ev.value.type}`);
  }
  console.log("OK");
} catch (e) {
  console.error("failed:", e.message);
  if (/gas_limit|dest|storage_deposit/i.test(e.message)) {
    console.error("\nRevive.call expects:", Object.keys(e.args ?? {}).join(", ") || "(introspect metadata)");
  }
  client.destroy();
  process.exit(1);
}

client.destroy();
process.exit(0);
