import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { ah } from "@polkadot-api/descriptors";
const [, , to, data, label] = process.argv;
const hexToBytes = (h) => Uint8Array.from(h.replace(/^0x/, "").match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
const client = createClient(getWsProvider("wss://asset-hub-paseo-rpc.n.dwellir.com"));
const api = client.getTypedApi(ah);
try {
  const r = await api.apis.ReviveApi.call("5GmrGRR2a1q6PLdApBfYWCssNqkaYdnfo8jvzEW3wdUsh8V5", to, 0n, undefined, undefined, hexToBytes(data));
  const hex = r.result.success ? "0x" + Buffer.from(r.result.value?.data ?? []).toString("hex") : "REVERT";
  console.log(`${label.padEnd(26)} ${hex}`);
} finally { client.destroy(); }
