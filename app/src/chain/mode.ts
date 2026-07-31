// What this run can and cannot do, decided in one place.
//
// The app has always had two independent switches — where the enclave answers
// from, and whether a wallet is connected — and until now their consequences
// were spread across `Play` as a scattering of `if (simulating)` and
// `if (!player)` checks. Adding a third combination (no wallet at all) to that
// shape would have meant finding every one of them and getting every one right,
// which is the kind of change that half-lands and leaves a guest able to spend
// a real attempt against the deployed verifier.
//
// So the combinations are enumerated here instead, as a ladder of three tiers,
// and everything downstream asks this module rather than re-deriving it:
//
//   guest     no wallet, enclave simulated in-tab, nothing submitted
//   practice  wallet connected, enclave still simulated, nothing submitted
//   live      wallet connected, deployed enclave, submits to the contract
//
// The rule that makes the ladder safe is that **capability only ever comes from
// the tier**. There is no path where a caller assembles its own combination —
// no "guest, but against the real verifier", no "simulated, but submitting" —
// because those are the states that would either waste a player's real attempt
// budget on an identity nobody owns, or ask the contract to accept a signature
// from a key printed in this repository.

/**
 * The address a guest plays as.
 *
 * A constant, and deliberately not a generated one. The enclave requires an
 * H160 — `sessionId` is `keccak256(player, epoch, k)`, and both `mock.ts`'s
 * `check()` and the deployed verifier reject anything that is not
 * `/^0x[0-9a-fA-F]{40}$/` — so *some* address has to exist. Nothing requires it
 * to be unique, and minting a random one per browser bought two things that
 * were not worth their cost: a per-guest level, and a per-guest character.
 *
 * What it cost was honesty. A generated `0x…` shown next to the word "Account"
 * is indistinguishable from a wallet, and a guest reading it has been told
 * something false about what they have. This value is `guest` in ASCII with the
 * remaining bytes zeroed, so it is inspectable as a placeholder rather than
 * mistakable for a key that someone holds.
 *
 * The consequence, stated plainly: every guest in a given hour plays the same
 * level at the same attempt index, because the seed derives from this address.
 * Twelve levels an hour, shared by everyone who has not connected a wallet.
 * For a tier whose whole purpose is to show the machine working, that is fine —
 * and it is one line to revisit if it ever stops being fine.
 */
export const GUEST_PLAYER = "0x6775657374000000000000000000000000000000";

/** Where the enclave answers from. */
export type EnclaveSource = "simulated" | "remote";

/** The three supported combinations. See the file header for the ladder. */
export type Tier = "guest" | "practice" | "live";

/**
 * The localStorage suffix that keeps each tier's sessions and runs apart.
 *
 * Sessions must not cross tiers. A seed is `keccak256(player, epoch, k)` signed
 * by whichever enclave issued it, so a seed held from the simulator means
 * nothing to the deployed one and a guest's means nothing to either. Replaying
 * one against the other produces a score disagreement that looks exactly like a
 * cheat. Runs are separated for a plainer reason: a score that can never land
 * must not be listed under the same heading as ones that did.
 */
export type Slot = "" | ".sim" | ".guest";

export interface Mode {
  tier: Tier;

  /**
   * The H160 the seed is bound to. Never null — a guest gets one too, which is
   * what lets the game start without a wallet.
   */
  player: string;

  /** True when `player` is a guest address rather than a mapped account. */
  isGuest: boolean;

  enclave: EnclaveSource;

  /**
   * Whether an attestation from this tier can be sent to the contract.
   *
   * False for every tier but `live`, and false there too without a host to
   * submit through. Nothing else may re-derive this: it is the single check
   * standing between a dev-key signature and a wasted transaction.
   */
  canSubmit: boolean;

  /** Whether to ask the contract for this player's best. A guest has none. */
  hasOnChainRecord: boolean;

  /** Whether to probe the deployed Processor's liveness. */
  probesProcessor: boolean;

  slot: Slot;

  /** One clause for the HUD, naming the tier in the player's terms. */
  summary: string;

  /** Why submitting is unavailable, or null when it is available. */
  blockedReason: string | null;
}

export interface ModeInput {
  /** The H160 of the connected account, or null when none is connected. */
  walletPlayer: string | null;
  /** The enclave-simulation switch. Ignored in `guest`, which has no choice. */
  simulatorOn: boolean;
  /** Whether a Polkadot host is present to submit through. */
  hasHost: boolean;
}

/**
 * Resolve the tier and everything that follows from it.
 *
 * Pure and total: every input combination lands on exactly one tier, so there
 * is no unhandled state for a caller to invent a fallback for.
 */
export function resolveMode({ walletPlayer, simulatorOn, hasHost }: ModeInput): Mode {
  // No wallet is not an error state, and this is the line that says so. A
  // player who opens the app with nothing connected gets a guest identity and
  // the in-tab enclave, which is enough to see the whole machine work.
  //
  // The simulator switch is deliberately not consulted. A guest against the
  // deployed verifier would burn one of *that address's* twelve attempts an
  // hour to obtain a seed for a run nobody can ever submit — spending a real
  // resource for no reachable outcome.
  if (!walletPlayer) {
    return {
      tier: "guest",
      player: GUEST_PLAYER,
      isGuest: true,
      enclave: "simulated",
      canSubmit: false,
      hasOnChainRecord: false,
      probesProcessor: false,
      slot: ".guest",
      summary: "guest — simulated end to end, nothing submitted",
      blockedReason: "connect an account to play against the deployed enclave and land a score",
    };
  }

  if (simulatorOn) {
    return {
      tier: "practice",
      player: walletPlayer,
      isGuest: false,
      enclave: "simulated",
      canSubmit: false,
      hasOnChainRecord: true,
      probesProcessor: true,
      slot: ".sim",
      summary: "simulated enclave",
      blockedReason: "the simulator signs with a key printed in this repository; the contract does not trust it",
    };
  }

  return {
    tier: "live",
    player: walletPlayer,
    isGuest: false,
    enclave: "remote",
    canSubmit: hasHost,
    hasOnChainRecord: true,
    probesProcessor: true,
    slot: "",
    summary: hasHost ? "polkadot host connected" : "standalone — no host",
    blockedReason: hasHost ? null : "no Polkadot host, so there is nothing to submit through",
  };
}
