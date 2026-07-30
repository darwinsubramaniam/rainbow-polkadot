// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Leaderboard} from "../src/Leaderboard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @dev Every reject path gets a test. The whole point of this contract is refusing
///      things, so an untested revert is an untested contract.
contract LeaderboardTest is Test {
    Leaderboard internal board;

    uint256 internal verifierKey = 0xA11CE;
    address internal verifier;
    uint256 internal rogueKey = 0xBAD;
    address internal rogue;

    address internal alice = address(0xA1);
    address internal bob = address(0xB0B);
    address internal relayer = address(0x2E1A);

    uint64 internal constant GAME = 1;
    uint64 internal EPOCH_SECS;
    uint32 internal MAX_K;
    bytes32 internal constant RULES = keccak256("sim-v1");

    /// secp256k1 group order, for constructing a malleable signature.
    uint256 internal constant N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function setUp() public {
        verifier = vm.addr(verifierKey);
        rogue = vm.addr(rogueKey);

        board = new Leaderboard();
        board.setVerifier(verifier, true);
        board.registerGame(GAME, RULES);

        // Read the pinned rules back rather than duplicating them in the test.
        EPOCH_SECS = board.epochSeconds();
        MAX_K = board.maxSessionsPerEpoch();

        // Start well past epoch 0 so "epoch in the past" is expressible.
        vm.warp(100 days);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function _claim(address player, uint64 score, uint64 epoch, uint32 k)
        internal
        view
        returns (Leaderboard.ScoreClaim memory)
    {
        return Leaderboard.ScoreClaim({
            player: player,
            gameId: GAME,
            score: score,
            epoch: epoch,
            k: k,
            rulesHash: RULES,
            expiry: uint64(block.timestamp + 1 days)
        });
    }

    function _sign(uint256 key, Leaderboard.ScoreClaim memory c)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, board.scoreDigest(c));
        return abi.encodePacked(r, s, v);
    }

    function _submit(Leaderboard.ScoreClaim memory c) internal {
        board.submit(c, _sign(verifierKey, c));
    }

    /// @dev Expect `submit` to revert with `selector`.
    ///
    ///      The signing MUST happen before `vm.expectRevert`. `expectRevert` attaches
    ///      to the next *external* call, and `_sign` makes one (`board.scoreDigest`),
    ///      which would otherwise swallow the expectation and make the test assert
    ///      nothing. This helper exists so that ordering cannot be got wrong per-test.
    function _expectRevert(bytes4 selector, Leaderboard.ScoreClaim memory c) internal {
        _expectRevertSignedBy(selector, verifierKey, c);
    }

    function _expectRevertSignedBy(bytes4 selector, uint256 key, Leaderboard.ScoreClaim memory c)
        internal
    {
        bytes memory sig = _sign(key, c);
        vm.expectRevert(selector);
        board.submit(c, sig);
    }

    // -----------------------------------------------------------------------
    // Happy path
    // -----------------------------------------------------------------------

    function test_acceptsAValidAttestation() public {
        Leaderboard.ScoreClaim memory c = _claim(alice, 1000, board.currentEpoch(), 0);
        bytes32 sid = board.sessionIdFor(alice, c.epoch, c.k);

        vm.expectEmit(true, true, false, true);
        emit Leaderboard.NewBest(GAME, alice, 1000, sid, c.epoch);
        _submit(c);

        assertEq(board.best(GAME, alice), 1000);
        assertTrue(board.usedSession(sid));
    }

    function test_anyoneMayRelay_scoreCreditsThePlayer() public {
        // `player` is bound inside the signed payload, so relaying is safe and the
        // sender is irrelevant. This is what lets submission be gasless.
        Leaderboard.ScoreClaim memory c = _claim(alice, 500, board.currentEpoch(), 0);
        bytes memory sig = _sign(verifierKey, c);

        vm.prank(relayer);
        board.submit(c, sig);

        assertEq(board.best(GAME, alice), 500, "credits player, not relayer");
        assertEq(board.best(GAME, relayer), 0);
    }

    function test_improvingOverwritesPreviousBest() public {
        _submit(_claim(alice, 100, board.currentEpoch(), 0));
        _submit(_claim(alice, 250, board.currentEpoch(), 1));
        assertEq(board.best(GAME, alice), 250);
    }

    function test_pastEpochsAreAccepted() public {
        // Only the FUTURE is rejected; `expiry` bounds staleness, not the epoch.
        Leaderboard.ScoreClaim memory c = _claim(alice, 10, board.currentEpoch() - 50, 0);
        _submit(c);
        assertEq(board.best(GAME, alice), 10);
    }

    // -----------------------------------------------------------------------
    // D1 — anti-grinding
    // -----------------------------------------------------------------------

    function test_rejectsSessionIndexAtOrAboveTheCap() public {
        Leaderboard.ScoreClaim memory c = _claim(alice, 1, board.currentEpoch(), MAX_K);
        _expectRevert(Leaderboard.SessionIndexOutOfRange.selector, c);
    }

    function test_acceptsTheLastValidSessionIndex() public {
        _submit(_claim(alice, 1, board.currentEpoch(), MAX_K - 1));
        assertEq(board.best(GAME, alice), 1);
    }

    function test_rejectsAnEpochInTheFuture() public {
        Leaderboard.ScoreClaim memory c = _claim(alice, 1, board.currentEpoch() + 1, 0);
        _expectRevert(Leaderboard.EpochInFuture.selector, c);
    }

    function test_grindingIsCappedPerEpoch() public {
        // A player gets exactly MAX_K sessions per epoch. The (MAX_K+1)-th slot is
        // unusable, so re-rolling seeds is bounded rather than free.
        uint64 e = board.currentEpoch();
        for (uint32 k = 0; k < MAX_K; k++) {
            _submit(_claim(alice, uint64(k) + 1, e, k));
        }
        Leaderboard.ScoreClaim memory extra = _claim(alice, 999, e, MAX_K);
        _expectRevert(Leaderboard.SessionIndexOutOfRange.selector, extra);
    }

    function test_sessionIdIsPerPlayer_soSlotsDoNotCollide() public {
        uint64 e = board.currentEpoch();
        _submit(_claim(alice, 10, e, 0));
        _submit(_claim(bob, 20, e, 0)); // same epoch and slot, different player
        assertEq(board.best(GAME, alice), 10);
        assertEq(board.best(GAME, bob), 20);
        assertTrue(board.sessionIdFor(alice, e, 0) != board.sessionIdFor(bob, e, 0));
    }

    // -----------------------------------------------------------------------
    // D3 — per-game boards and pinned rules
    // -----------------------------------------------------------------------

    function test_bestIsKeyedByGame() public {
        uint64 other = 2;
        bytes32 otherRules = keccak256("sim-v2");
        board.registerGame(other, otherRules);

        _submit(_claim(alice, 900, board.currentEpoch(), 0));

        Leaderboard.ScoreClaim memory c = _claim(alice, 5, board.currentEpoch(), 1);
        c.gameId = other;
        c.rulesHash = otherRules;
        _submit(c);

        // A low score in game 2 must not be shadowed by a high score in game 1.
        assertEq(board.best(GAME, alice), 900);
        assertEq(board.best(other, alice), 5);
    }

    function test_rejectsAnUnregisteredGame() public {
        Leaderboard.ScoreClaim memory c = _claim(alice, 1, board.currentEpoch(), 0);
        c.gameId = 99;
        _expectRevert(Leaderboard.UnknownGame.selector, c);
    }

    function test_rejectsAMismatchedRulesHash() public {
        // An attestation produced by a verifier running a different ruleset must not
        // land on this board, even though its signature is perfectly valid.
        Leaderboard.ScoreClaim memory c = _claim(alice, 1, board.currentEpoch(), 0);
        c.rulesHash = keccak256("sim-v2");
        _expectRevert(Leaderboard.RulesMismatch.selector, c);
    }

    function test_gameRulesAreWriteOnce() public {
        vm.expectRevert(Leaderboard.GameAlreadyRegistered.selector);
        board.registerGame(GAME, keccak256("sim-v2"));
    }

    function test_rejectsZeroRulesHash() public {
        vm.expectRevert(Leaderboard.ZeroRulesHash.selector);
        board.registerGame(7, bytes32(0));
    }

    // -----------------------------------------------------------------------
    // Replay, expiry, monotonicity
    // -----------------------------------------------------------------------

    function test_rejectsAReplayedSession() public {
        uint64 e = board.currentEpoch();
        _submit(_claim(alice, 100, e, 0));

        Leaderboard.ScoreClaim memory again = _claim(alice, 200, e, 0); // same slot
        _expectRevert(Leaderboard.SessionAlreadyUsed.selector, again);
    }

    function test_rejectsAnExpiredAttestation() public {
        Leaderboard.ScoreClaim memory c = _claim(alice, 100, board.currentEpoch(), 0);
        bytes memory sig = _sign(verifierKey, c);
        vm.warp(c.expiry + 1);
        vm.expectRevert(Leaderboard.Expired.selector);
        board.submit(c, sig);
    }

    function test_acceptsExactlyAtExpiry() public {
        Leaderboard.ScoreClaim memory c = _claim(alice, 100, board.currentEpoch(), 0);
        vm.warp(c.expiry); // boundary is inclusive
        _submit(c);
        assertEq(board.best(GAME, alice), 100);
    }

    function test_rejectsAScoreThatDoesNotImprove() public {
        uint64 e = board.currentEpoch();
        _submit(_claim(alice, 500, e, 0));

        _expectRevert(Leaderboard.NotAnImprovement.selector, _claim(alice, 400, e, 1));
        // equal is not an improvement either
        _expectRevert(Leaderboard.NotAnImprovement.selector, _claim(alice, 500, e, 2));
    }

    // -----------------------------------------------------------------------
    // Signature validation
    // -----------------------------------------------------------------------

    function test_rejectsASignatureFromANonVerifier() public {
        Leaderboard.ScoreClaim memory c = _claim(alice, 100, board.currentEpoch(), 0);
        _expectRevertSignedBy(Leaderboard.BadAttestation.selector, rogueKey, c);
    }

    function test_rejectsGarbageSignature() public {
        Leaderboard.ScoreClaim memory c = _claim(alice, 100, board.currentEpoch(), 0);
        vm.expectRevert(Leaderboard.BadAttestation.selector);
        board.submit(c, hex"deadbeef");
    }

    function test_rejectsAMalleableSignature() public {
        // Raw ECDSA is malleable: (r, n-s) verifies just as well as (r, s). If the
        // contract keyed replay protection on the signature this would defeat it.
        // OpenZeppelin rejects high-s outright; this proves we inherit that.
        Leaderboard.ScoreClaim memory c = _claim(alice, 100, board.currentEpoch(), 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierKey, board.scoreDigest(c));

        bytes32 flippedS = bytes32(N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;

        vm.expectRevert(Leaderboard.BadAttestation.selector);
        board.submit(c, abi.encodePacked(r, flippedS, flippedV));
    }

    function test_rejectsATamperedScore() public {
        Leaderboard.ScoreClaim memory c = _claim(alice, 100, board.currentEpoch(), 0);
        bytes memory sig = _sign(verifierKey, c);
        c.score = 999_999; // inflate after signing
        vm.expectRevert(Leaderboard.BadAttestation.selector);
        board.submit(c, sig);
    }

    function test_rejectsSwappingThePlayer() public {
        // An attestation earned by alice must not be redirectable to bob.
        Leaderboard.ScoreClaim memory c = _claim(alice, 100, board.currentEpoch(), 0);
        bytes memory sig = _sign(verifierKey, c);
        c.player = bob;
        vm.expectRevert(Leaderboard.BadAttestation.selector);
        board.submit(c, sig);
    }

    function test_rejectsExtendingExpiry() public {
        Leaderboard.ScoreClaim memory c = _claim(alice, 100, board.currentEpoch(), 0);
        bytes memory sig = _sign(verifierKey, c);
        c.expiry = uint64(block.timestamp + 3650 days);
        vm.expectRevert(Leaderboard.BadAttestation.selector);
        board.submit(c, sig);
    }

    function test_rejectsRedirectingToAnotherGame() public {
        // The interesting case, and the reason it needs its own test: mutating `gameId`
        // alone dies on `RulesMismatch` long before recovery, so it proves nothing about
        // the signature. Moving `rulesHash` in step with it keeps the claim structurally
        // valid all the way through the cheap checks, so this is the version that
        // actually reaches `ECDSA.tryRecover` — and is refused there.
        uint64 other = 2;
        bytes32 otherRules = keccak256("sim-v2");
        board.registerGame(other, otherRules);

        Leaderboard.ScoreClaim memory c = _claim(alice, 100, board.currentEpoch(), 0);
        bytes memory sig = _sign(verifierKey, c);

        c.gameId = other;
        c.rulesHash = otherRules;

        // Assert the premise, so a future change to the check order cannot silently
        // turn this back into a `RulesMismatch` test that looks like it still passes.
        assertEq(board.gameRules(c.gameId), c.rulesHash, "claim must survive the cheap checks");
        assertFalse(board.usedSession(board.sessionIdFor(c.player, c.epoch, c.k)));
        assertGt(c.score, board.best(c.gameId, c.player));

        vm.expectRevert(Leaderboard.BadAttestation.selector);
        board.submit(c, sig);

        // And nothing leaked onto either board.
        assertEq(board.best(other, alice), 0);
        assertEq(board.best(GAME, alice), 0);
    }

    // -----------------------------------------------------------------------
    // Verifier set management
    // -----------------------------------------------------------------------

    function test_verifierRotation_bothKeysWorkWhileBothRegistered() public {
        // Every Acurast redeploy mints a new signing key. Adding without removing
        // keeps in-flight attestations from the old deployment valid.
        board.setVerifier(rogue, true);
        uint64 e = board.currentEpoch();

        _submit(_claim(alice, 100, e, 0)); // old key

        Leaderboard.ScoreClaim memory c = _claim(alice, 200, e, 1);
        board.submit(c, _sign(rogueKey, c)); // new key
        assertEq(board.best(GAME, alice), 200);
    }

    function test_removingAVerifierInvalidatesItsAttestations() public {
        Leaderboard.ScoreClaim memory c = _claim(alice, 100, board.currentEpoch(), 0);
        bytes memory sig = _sign(verifierKey, c); // sign while still trusted
        board.setVerifier(verifier, false);
        vm.expectRevert(Leaderboard.BadAttestation.selector);
        board.submit(c, sig);
    }

    function test_onlyOwnerMayAdminister() public {
        vm.startPrank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        board.setVerifier(bob, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        board.registerGame(42, keccak256("x"));
        vm.stopPrank();
    }

    // -----------------------------------------------------------------------
    // Construction & digest shape
    // -----------------------------------------------------------------------

    function test_freshDeploymentFailsClosed() public {
        // `cdm deploy` passes no constructor arguments, so a new board starts with no
        // verifier and no games. It must reject everything until the owner opens it —
        // otherwise the setup window would be front-runnable.
        Leaderboard fresh = new Leaderboard();
        assertEq(fresh.owner(), address(this));
        assertTrue(fresh.epochSeconds() > 0);
        assertTrue(fresh.maxSessionsPerEpoch() > 0);

        Leaderboard.ScoreClaim memory c = _claim(alice, 1, fresh.currentEpoch(), 0);
        bytes memory sig = _sign(verifierKey, c);
        vm.expectRevert(Leaderboard.UnknownGame.selector);
        fresh.submit(c, sig);

        // With a game registered but still no verifier, it fails on the signature.
        fresh.registerGame(GAME, RULES);
        vm.expectRevert(Leaderboard.BadAttestation.selector);
        fresh.submit(c, sig);
    }

    function test_digestMatchesEip712ComputedIndependently() public view {
        // Recomputed from first principles, so a typehash or field-order change
        // fails here loudly instead of silently invalidating every attestation.
        Leaderboard.ScoreClaim memory c = _claim(alice, 1234, board.currentEpoch(), 2);

        bytes32 typeHash = keccak256(
            "Score(address player,uint64 gameId,uint64 score,uint64 epoch,uint32 k,bytes32 rulesHash,uint64 expiry)"
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("RainbowLeaderboard"),
                keccak256("1"),
                block.chainid,
                address(board)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(typeHash, c.player, c.gameId, c.score, c.epoch, c.k, c.rulesHash, c.expiry)
        );
        bytes32 expected = keccak256(abi.encodePacked(hex"1901", domain, structHash));

        assertEq(board.scoreDigest(c), expected);
    }

    function test_digestIsBoundToThisContractAndChain() public {
        // The EIP-712 domain supplies chainId and verifyingContract, which is what
        // stops an attestation being replayed on another chain or a redeploy.
        Leaderboard other = new Leaderboard();
        other.setVerifier(verifier, true);
        other.registerGame(GAME, RULES);
        Leaderboard.ScoreClaim memory c = _claim(alice, 100, board.currentEpoch(), 0);

        assertTrue(board.scoreDigest(c) != other.scoreDigest(c), "domain must separate deployments");

        // Concretely: a signature for `board` is worthless against `other`.
        bytes memory sig = _sign(verifierKey, c);
        vm.expectRevert(Leaderboard.BadAttestation.selector);
        other.submit(c, sig);
    }

    // -----------------------------------------------------------------------
    // Acurast integration shape (E0.3)
    // -----------------------------------------------------------------------

    /// @dev E0.3 established, by experiment on a live processor, that Acurast's
    ///      `signer_sign` signs the 32 bytes it is given as a pre-computed digest —
    ///      no envelope, no pre-hash — and returns **64 bytes of r||s with no
    ///      recovery id**. `ECDSA.recover` needs 65 bytes with v in {27,28}.
    ///
    ///      This reproduces that exactly: start from r||s only, reconstruct v the way
    ///      the verifier job must, and submit. It is the seam between the enclave and
    ///      this contract, and it is the easiest place in the whole system to get a
    ///      silent, permanent failure.
    function test_enclaveShapedSignature_requiresRecoveryIdReconstruction() public {
        Leaderboard.ScoreClaim memory c = _claim(alice, 4242, board.currentEpoch(), 0);
        bytes32 digest = board.scoreDigest(c);

        (uint8 realV, bytes32 r, bytes32 s) = vm.sign(verifierKey, digest);

        // What signer_sign actually hands back: 64 bytes, no v.
        bytes memory rs = abi.encodePacked(r, s);
        assertEq(rs.length, 64, "signer_sign returns r||s only");

        // Naively submitting r||s must fail — there is no recovery id to use.
        vm.expectRevert(Leaderboard.BadAttestation.selector);
        board.submit(c, rs);

        // The job recovers v by trying both candidates and keeping the one that
        // yields its own known address.
        uint8 found;
        for (uint8 cand = 27; cand <= 28; cand++) {
            if (ecrecover(digest, cand, r, s) == verifier) {
                found = cand;
                break;
            }
        }
        assertTrue(found != 0, "one recovery id must yield the verifier address");
        assertEq(found, realV, "reconstruction agrees with the true v");

        board.submit(c, abi.encodePacked(r, s, found));
        assertEq(board.best(GAME, alice), 4242);
    }

    /// @dev The other recovery id must NOT work — otherwise "try both and keep the
    ///      one that matches" would be picking arbitrarily rather than uniquely.
    function test_theWrongRecoveryIdIsRejected() public {
        Leaderboard.ScoreClaim memory c = _claim(alice, 100, board.currentEpoch(), 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierKey, board.scoreDigest(c));
        uint8 wrong = v == 27 ? 28 : 27;

        vm.expectRevert(Leaderboard.BadAttestation.selector);
        board.submit(c, abi.encodePacked(r, s, wrong));
    }

    // -----------------------------------------------------------------------
    // Fuzz
    // -----------------------------------------------------------------------

    function testFuzz_onlyImprovementsEverLand(uint64 first, uint64 second) public {
        vm.assume(first > 0);
        uint64 e = board.currentEpoch();
        _submit(_claim(alice, first, e, 0));

        Leaderboard.ScoreClaim memory c = _claim(alice, second, e, 1);
        if (second > first) {
            _submit(c);
            assertEq(board.best(GAME, alice), second);
        } else {
            _expectRevert(Leaderboard.NotAnImprovement.selector, c);
            assertEq(board.best(GAME, alice), first);
        }
    }

    function testFuzz_sessionIdIsInjective(address p1, uint64 e1, uint32 k1, uint64 e2, uint32 k2)
        public
        view
    {
        vm.assume(e1 != e2 || k1 != k2);
        assertTrue(board.sessionIdFor(p1, e1, k1) != board.sessionIdFor(p1, e2, k2));
    }
}
