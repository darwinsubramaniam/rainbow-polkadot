import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * The seed derivation exists twice, and a divergence would not fail loudly.
 *
 * `acurast-verifier/app/verifier.mjs` derives the seed inside the enclave;
 * `app/src/chain/mock.ts` derives it in the browser tab so the simulator can be
 * played without a deployed job. They are separate implementations of one
 * scheme, in two languages, with no shared code — and nothing at runtime ever
 * compares them.
 *
 * If they drift, the simulator hands out a different level than the enclave
 * would. Every practice run then looks like it worked, right up to the point
 * where a real submission is attempted and the enclave replays the log against
 * geometry the player never saw. So the two sources are read as fixtures here
 * and compared, the same way `leaderboard.test.ts` reads the Solidity.
 *
 * This is a *source-level* test on purpose. Executing either side would need a
 * secure element on one and a `fetch` for `sim.wasm` on the other, and the thing
 * worth guarding — the preimage — is legible in the text.
 */

const VERIFIER = new URL("../../../acurast-verifier/app/verifier.mjs", import.meta.url);
const MOCK = new URL("./mock.ts", import.meta.url);

/** The body of `deriveSeed`, from `{` to the closing `}` at column 0. */
const deriveSeedBody = (url: URL): string => {
  const source = readFileSync(url, "utf8");
  const at = source.search(/function deriveSeed\(/);
  assert.notEqual(at, -1, `no deriveSeed in ${url.pathname}`);
  const end = source.indexOf("\n}", at);
  assert.notEqual(end, -1, `unterminated deriveSeed in ${url.pathname}`);
  return source.slice(at, end);
};

/** The `"rainbow-seed-vN"` domain prefix the preimage is tagged with. */
const domainPrefix = (body: string): string => {
  const m = body.match(/"(rainbow-seed-v\d+)"/);
  assert.ok(m, "deriveSeed must tag its preimage with a rainbow-seed-vN prefix");
  return m[1]!;
};

describe("seed derivation, across its two implementations", () => {
  const verifier = deriveSeedBody(VERIFIER);
  const mock = deriveSeedBody(MOCK);

  it("tags the preimage with the same domain prefix", () => {
    // A bump on one side only is the cheapest possible way to make the two
    // disagree, and produces no error anywhere — just different levels.
    assert.equal(domainPrefix(verifier), domainPrefix(mock));
  });

  it("takes (epoch, k) and nothing else", () => {
    for (const [name, body] of [
      ["verifier.mjs", verifier],
      ["mock.ts", mock],
    ] as const) {
      assert.match(body, /function deriveSeed\((epoch, k|epoch: number, k: number)\)/, name);
    }
  });

  it("does not put the player back into the preimage", () => {
    // The regression this whole change exists to prevent. Keying on the player
    // gives every account a private level, which makes two scores on one board
    // incomparable — and, because /session derives for any address you name and
    // addresses are free, lets a farmer shop for a friendly draw.
    for (const [name, body] of [
      ["verifier.mjs", verifier],
      ["mock.ts", mock],
    ] as const) {
      assert.doesNotMatch(body, /\bplayer\b/, `${name}: deriveSeed must not read the player`);
      assert.doesNotMatch(body, /\bsessionId\b/, `${name}: deriveSeed must not read the sessionId`);
    }
  });

  it("concatenates the same three parts, in the same order", () => {
    // Both files spell the ABI-word helper `word` and the UTF-8 helper
    // differently (`new TextEncoder().encode` vs `utf8`), so compare the shape
    // rather than the text: prefix, then the epoch word, then the k word.
    // Scanned with balanced parentheses rather than a regex: the two files wrap
    // the call differently (one across three lines, one on one), and both
    // arguments contain parentheses of their own.
    const parts = (body: string): string[] => {
      const open = body.indexOf("cat(");
      assert.notEqual(open, -1, "deriveSeed must build its preimage with cat(...)");

      let depth = 0;
      const args: string[] = [];
      let current = "";
      for (let i = open + "cat(".length; i < body.length; i++) {
        const c = body[i]!;
        if (c === "(") depth++;
        if (c === ")") {
          if (depth === 0) break;
          depth--;
        }
        // Only a comma at depth zero separates arguments; the ones inside
        // `word(...)` and `encode(...)` belong to those calls.
        if (c === "," && depth === 0) {
          args.push(current);
          current = "";
          continue;
        }
        current += c;
      }
      args.push(current);

      return args
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) =>
          p.includes("rainbow-seed") ? "PREFIX" : p.replace(/^word\((\w+)\)$/, "word:$1"),
        );
    };

    assert.deepEqual(parts(verifier), ["PREFIX", "word:epoch", "word:k"]);
    assert.deepEqual(parts(mock), ["PREFIX", "word:epoch", "word:k"]);
  });

  it("reduces the signature to a little-endian u64 the same way", () => {
    // `sim_verify` takes a u64 seed. Reading the hash big-endian on one side
    // would give a valid-looking seed for a completely different level.
    for (const [name, body] of [
      ["verifier.mjs", verifier],
      ["mock.ts", mock],
    ] as const) {
      assert.match(body, /getBigUint64\(0, true\)/, `${name}: seed is the first 8 bytes, LE`);
    }
  });
});
