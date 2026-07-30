// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Rainbow leaderboard — TEE-attested high scores
/// @notice A score is only accepted if a trusted verifier running a deterministic
///         replay inside an Acurast processor's secure enclave has signed for it.
///         A signature proves *who* signed, not *what is true*, so the authority over
///         score computation lives in the enclave and this contract only checks that
///         the attestation is well-formed, fresh, unspent, and actually an improvement.
///
/// @dev Ranking is deliberately NOT maintained on-chain. Insertion into a sorted array
///      is unbounded gas; clients rank off-chain, reading the board through {board}.
///
/// @custom:cdm @dw3labs/rainbow-leaderboard
contract Leaderboard is EIP712, Ownable {
    // -----------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------

    /// @notice A claimed score, exactly as the enclave signs it.
    /// @dev Field order here MUST match {SCORE_TYPEHASH}; EIP-712 encodes positionally.
    struct ScoreClaim {
        address player;
        uint64 gameId;
        uint64 score;
        uint64 epoch;
        uint32 k;
        bytes32 rulesHash;
        uint64 expiry;
    }

    /// @dev The typed payload the enclave signs. `sessionId` is deliberately absent:
    ///      it is *derived* from (player, epoch, k) rather than supplied, so a
    ///      malformed session identifier cannot exist. See {sessionIdFor}.
    bytes32 private constant SCORE_TYPEHASH = keccak256(
        "Score(address player,uint64 gameId,uint64 score,uint64 epoch,uint32 k,bytes32 rulesHash,uint64 expiry)"
    );

    // -----------------------------------------------------------------------
    // Rules constants
    // -----------------------------------------------------------------------
    //
    // These are compile-time constants rather than constructor arguments, for two
    // reasons. Practically, `cdm deploy` passes no constructor arguments, so anything
    // configurable that way cannot be deployed through it. Conceptually they are part
    // of the *rules* — changing the grind cap changes what a score means — so pinning
    // them to the deployment, exactly as `rulesHash` pins the simulation, is the
    // consistent choice. To change them, deploy a new contract.

    /// @notice Length of a session epoch, in seconds.
    /// @dev Anti-grinding (defect D1). The enclave derives a run's seed from
    ///      (player, epoch, k) with a secret root key, and only issues seeds for the
    ///      current epoch. A player therefore gets at most {maxSessionsPerEpoch} seeds
    ///      per epoch instead of unlimited re-rolls, and cannot compute seeds offline.
    uint64 public constant epochSeconds = 1 hours;

    /// @notice How many session slots a player gets per epoch. The grinding cap.
    /// @dev Generous against honest play — a run is capped at 36,000 ticks (10 minutes),
    ///      so twelve slots exceeds what an hour physically allows — while still
    ///      bounding how many seeds an attacker can sample and discard.
    uint32 public constant maxSessionsPerEpoch = 12;

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    /// @notice Best score per game, per player.
    /// @dev Keyed by gameId (defect D3). A single mapping would have made two games
    ///      share one scoreboard while `gameId` sat decoratively in the payload.
    mapping(uint64 gameId => mapping(address player => uint64)) public best;

    /// @notice Every player who has ever scored on a game, in first-score order.
    ///
    /// @dev The enumeration {best} alone cannot give. A mapping has no key set, so a
    ///      client holding only `best` can look up a score it already has an address
    ///      for and nothing else — it cannot ask "who is on this board", which is the
    ///      one question a leaderboard exists to answer.
    ///
    ///      The original plan was for clients to reconstruct that set from {NewBest}
    ///      logs. That does not work here: submissions arrive as Substrate
    ///      `Revive.call` extrinsics, and the Ethereum-RPC view of this chain reports
    ///      such blocks as having no transactions at all — `eth_getLogs` over this
    ///      contract's whole history returns an empty array while `eth_call` against
    ///      the same address answers correctly. The events are real, but unreadable by
    ///      any Ethereum-shaped client, and no indexer covers this chain.
    ///
    ///      So the set lives in storage instead. Append-only and unsorted: one SSTORE
    ///      on a player's *first* accepted score and never again, which keeps {submit}
    ///      O(1) and leaves the ordering — the part that is unbounded — off-chain
    ///      where {board} hands a client everything it needs to do it.
    mapping(uint64 gameId => address[]) private roster;

    /// @notice Consumed sessions. Makes an attestation single-use.
    mapping(bytes32 sessionId => bool) public usedSession;

    /// @notice Addresses whose attestations are accepted.
    /// @dev A *set*, not a single address: an Acurast deployment's signing key is
    ///      scoped to that deployment, so every redeploy mints a new verifier address
    ///      unless `reuseKeysFrom` is used. Add the new key without removing the old so
    ///      attestations already in flight stay valid until they expire.
    mapping(address verifier => bool) public isVerifier;

    /// @notice The ruleset each game is played under.
    /// @dev Defect D3. Write-once: a new ruleset means a new gameId, never a mutated
    ///      hash. Mutating it would leave scores earned under the old rules sitting in
    ///      the same board as scores earned under the new ones.
    mapping(uint64 gameId => bytes32) public gameRules;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event NewBest(
        uint64 indexed gameId,
        address indexed player,
        uint64 score,
        bytes32 sessionId,
        uint64 epoch
    );
    event GameRegistered(uint64 indexed gameId, bytes32 rulesHash);
    event VerifierSet(address indexed verifier, bool allowed);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error Expired();
    error SessionAlreadyUsed();
    error NotAnImprovement();
    error BadAttestation();
    error UnknownGame();
    error RulesMismatch();
    error EpochInFuture();
    error SessionIndexOutOfRange();
    error GameAlreadyRegistered();
    error ZeroRulesHash();

    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    /// @dev Takes no arguments, because `cdm deploy` supplies none. The deployer
    ///      becomes owner and must then call {setVerifier} and {registerGame} before
    ///      any submission can succeed.
    ///
    ///      There is no uninitialised-window risk: with no game registered every
    ///      {submit} reverts `UnknownGame`, and with no verifier registered every
    ///      attestation reverts `BadAttestation`. The contract fails closed until the
    ///      owner opens it, so front-running setup is not possible.
    constructor() EIP712("RainbowLeaderboard", "1") Ownable(msg.sender) {}

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    /// @notice The epoch a timestamp falls in.
    function currentEpoch() public view returns (uint64) {
        return uint64(block.timestamp) / epochSeconds;
    }

    /// @notice Deterministic session identifier for a (player, epoch, slot) triple.
    /// @dev Both sides derive this identically; it is never transmitted as a claim.
    function sessionIdFor(address player, uint64 epoch, uint32 k) public pure returns (bytes32) {
        return keccak256(abi.encode(player, epoch, k));
    }

    /// @notice The exact EIP-712 digest the enclave must sign.
    /// @dev Exposed so the verifier job and the tests compute it from one source of
    ///      truth rather than reimplementing the encoding and drifting.
    function scoreDigest(ScoreClaim calldata c) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SCORE_TYPEHASH, c.player, c.gameId, c.score, c.epoch, c.k, c.rulesHash, c.expiry
                )
            )
        );
    }

    /// @notice How many players have ever scored on a game.
    /// @dev The bound a client needs before it can page through {board}.
    function playerCount(uint64 gameId) external view returns (uint256) {
        return roster[gameId].length;
    }

    /// @notice A slice of a game's board: players and their current best scores.
    ///
    /// @dev **Unsorted**, in first-score order, and that is deliberate — see the note
    ///      on {roster}. The client sorts. Ten rows sorted in a browser costs nothing;
    ///      keeping them sorted in storage costs an unbounded write on every submit.
    ///
    ///      Paginated for the same reason ranking is off-chain: the roster has no upper
    ///      bound, so a view that returned all of it would eventually exceed the gas a
    ///      read is allowed and start failing — silently, from the caller's point of
    ///      view, and only once the board got popular. `offset`/`limit` make that the
    ///      caller's problem to bound rather than a cliff the contract walks off.
    ///
    ///      Scores are read live from {best} rather than stored alongside the address,
    ///      so an improvement never has to be written in two places and the two can
    ///      never disagree.
    ///
    ///      An `offset` past the end returns empty arrays rather than reverting: a
    ///      client paging until it gets a short page is the normal way to consume this,
    ///      and racing a new player joining mid-page should not throw at it.
    function board(uint64 gameId, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory players, uint64[] memory scores)
    {
        address[] storage all = roster[gameId];
        uint256 total = all.length;
        if (offset >= total) return (new address[](0), new uint64[](0));

        uint256 n = total - offset;
        if (n > limit) n = limit;

        players = new address[](n);
        scores = new uint64[](n);
        for (uint256 i; i < n; ++i) {
            address p = all[offset + i];
            players[i] = p;
            scores[i] = best[gameId][p];
        }
    }

    // -----------------------------------------------------------------------
    // Submission
    // -----------------------------------------------------------------------

    /// @notice Submit an enclave-attested score.
    ///
    /// @dev Anyone may relay this; the score always credits `player`, who is bound
    ///      inside the signed payload. Goal.md bound `msg.sender` instead, to stop a
    ///      third party submitting someone else's attestation and being credited for
    ///      it. Naming `player` explicitly defeats that attack directly *and* permits
    ///      gasless relaying, so the sender is not constrained here.
    ///
    ///      Order matters: the cheap structural checks run before the ~3k-gas
    ///      signature recovery, so a malformed submission is rejected cheaply.
    function submit(ScoreClaim calldata c, bytes calldata signature) external {
        if (block.timestamp > c.expiry) revert Expired();

        // --- D1: the session must be one the enclave could legitimately have issued.
        if (c.k >= maxSessionsPerEpoch) revert SessionIndexOutOfRange();
        if (c.epoch > currentEpoch()) revert EpochInFuture();

        // --- D3: the game must exist and the attestation must name its exact ruleset.
        bytes32 expectedRules = gameRules[c.gameId];
        if (expectedRules == bytes32(0)) revert UnknownGame();
        if (expectedRules != c.rulesHash) revert RulesMismatch();

        bytes32 sessionId = sessionIdFor(c.player, c.epoch, c.k);
        if (usedSession[sessionId]) revert SessionAlreadyUsed();

        // Cherry-picking is enforced here rather than trusted to the player: a
        // submission that does not beat their own best simply reverts.
        if (c.score <= best[c.gameId][c.player]) revert NotAnImprovement();

        // OpenZeppelin's ECDSA, never raw ecrecover: the precompile returns a garbage
        // address instead of reverting on an invalid signature, and raw ECDSA is
        // malleable, which would break the single-use session check.
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(scoreDigest(c), signature);
        if (err != ECDSA.RecoverError.NoError || !isVerifier[signer]) revert BadAttestation();

        usedSession[sessionId] = true;

        // First accepted score on this board: enrol the player so {board} can find
        // them. `best == 0` is an exact test for "never scored here", not an
        // approximation — the improvement check above requires `score > best`, so any
        // stored best is at least 1 and a zero-score claim can never land. Read before
        // the write below, which is the only order in which that holds.
        if (best[c.gameId][c.player] == 0) roster[c.gameId].push(c.player);

        best[c.gameId][c.player] = c.score;

        emit NewBest(c.gameId, c.player, c.score, sessionId, c.epoch);
    }

    // -----------------------------------------------------------------------
    // Administration
    // -----------------------------------------------------------------------

    /// @notice Register a game and pin the ruleset its scores are earned under.
    /// @dev Write-once by design (D3). To change the rules, register a new gameId —
    ///      that keeps each board internally comparable.
    function registerGame(uint64 gameId, bytes32 rulesHash) external onlyOwner {
        if (rulesHash == bytes32(0)) revert ZeroRulesHash();
        if (gameRules[gameId] != bytes32(0)) revert GameAlreadyRegistered();
        gameRules[gameId] = rulesHash;
        emit GameRegistered(gameId, rulesHash);
    }

    /// @notice Add or remove a verifier.
    /// @dev The single point of compromise in this design. For anything beyond a
    ///      vanity board, put ownership behind a multisig or governance.
    ///
    ///      An Acurast deployment publishes its signing key on-chain in the
    ///      assignment before the job runs, so the value passed here is independently
    ///      checkable against Acurast chain state rather than taken on trust — but
    ///      that check happens off-chain, since this contract lives on a different
    ///      chain and cannot read it.
    function setVerifier(address verifier, bool allowed) external onlyOwner {
        isVerifier[verifier] = allowed;
        emit VerifierSet(verifier, allowed);
    }
}
