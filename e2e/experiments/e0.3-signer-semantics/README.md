# E0.3 — Acurast `signer_sign` semantics

A finished, one-off measurement. **Nothing at runtime depends on this directory** — it is
kept so the result can be re-measured if the Acurast Shell runtime changes.

**Result** (full writeup: [`docs/E0.3-E0.4-acurast.md`](../../../docs/E0.3-E0.4-acurast.md)):

```
CONCLUSION : signer_sign signs the input bytes directly as a pre-computed digest
SIG LAYOUT : r||s  (64 bytes) — the job recovers v itself, and OpenZeppelin wants v ∈ {27,28}
NONCE      : deterministic (RFC 6979)
```

That conclusion is what `acurast-verifier/app/verifier.mjs` and the contract's
`ECDSA.recover(_hashTypedDataV4(structHash), sig)` are built on. Had it gone the other way —
a forced `keccak256("acusig" ‖ SCRIPT_HASH ‖ msg)` envelope, as the Node.js runtime
documents — the contract would compile, deploy, and then silently reject every attestation
forever.

## Re-run it

```bash
cd e2e/experiments/e0.3-signer-semantics
cp .env.example .env          # add ACURAST_MNEMONIC (cACU funded)
node verify.mjs --selftest    # validate the detector FIRST
acurast estimate-fee e0-signer
acurast deploy e0-signer
sh pull-report.sh             # newest report from the sink -> verify.mjs
```

The deployed job is named `e0-signer` in `acurast.json`; that name is independent of this
directory's path and should not be renamed to match it — the webhook sink path
(`/e0-signer/report`) and `pull-report.sh` both key off it.

`results/380395-report.json` is the report the conclusion above was read from.
