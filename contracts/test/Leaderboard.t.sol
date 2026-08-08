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
        uint64 day = board.dayOf(c.epoch);

        vm.expectEmit(true, true, true, true);
        emit Leaderboard.ScoreRecorded(GAME, day, alice, 1000, sid, c.epoch);
        _submit(c);

        assertEq(board.best(GAME, alice), 1000);
        assertEq(board.dailyBest(GAME, day, alice), 1000, "both boards, one submission");
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
    // Enumeration — what makes an off-chain ranking possible
    // -----------------------------------------------------------------------

    function test_boardIsEmptyBeforeAnyoneScores() public view {
        assertEq(board.playerCount(GAME), 0);
        (address[] memory players, uint64[] memory scores) = board.board(GAME, 0, 10);
        assertEq(players.length, 0);
        assertEq(scores.length, 0);
    }

    function test_scoringEnrolsThePlayer() public {
        _submit(_claim(alice, 100, board.currentEpoch(), 0));

        assertEq(board.playerCount(GAME), 1);
        (address[] memory players, uint64[] memory scores) = board.board(GAME, 0, 10);
        assertEq(players.length, 1);
        assertEq(players[0], alice);
        assertEq(scores[0], 100);
    }

    function test_improvingDoesNotEnrolTwice() public {
        // The whole reason enrolment is keyed on an explicit flag: a player who submits
        // eleven times must appear once, or the board fills with one name.
        uint64 e = board.currentEpoch();
        _submit(_claim(alice, 100, e, 0));
        _submit(_claim(alice, 200, e, 1));
        _submit(_claim(alice, 300, e, 2));

        assertEq(board.playerCount(GAME), 1, "one row per player, not per score");

        (address[] memory players, uint64[] memory scores) = board.board(GAME, 0, 10);
        assertEq(players.length, 1);
        assertEq(scores[0], 300, "and the row carries the current best");
    }

    function test_boardReadsScoresLive() public {
        // Scores are not copied into the roster, so this cannot drift from `best`.
        uint64 e = board.currentEpoch();
        _submit(_claim(alice, 100, e, 0));
        _submit(_claim(bob, 900, e, 0));
        _submit(_claim(alice, 950, e, 1));

        (address[] memory players, uint64[] memory scores) = board.board(GAME, 0, 10);
        assertEq(players.length, 2);
        for (uint256 i; i < players.length; ++i) {
            assertEq(scores[i], board.best(GAME, players[i]), "board must agree with best()");
        }
    }

    function test_boardIsUnsortedInFirstScoreOrder() public {
        // Asserted rather than left implicit: the client sorts, and a client that
        // assumed this came back ranked would show a wrong board with no error.
        uint64 e = board.currentEpoch();
        _submit(_claim(alice, 10, e, 0)); // low score, but first to arrive
        _submit(_claim(bob, 5000, e, 0));

        (address[] memory players,) = board.board(GAME, 0, 10);
        assertEq(players[0], alice, "insertion order, not rank order");
        assertEq(players[1], bob);
    }

    function test_boardPagesAndClampsTheLastPage() public {
        uint64 e = board.currentEpoch();
        for (uint160 i = 1; i <= 5; ++i) {
            _submit(_claim(address(i), uint64(i) * 10, e, 0));
        }
        assertEq(board.playerCount(GAME), 5);

        (address[] memory first,) = board.board(GAME, 0, 2);
        assertEq(first.length, 2);
        assertEq(first[0], address(uint160(1)));

        // A limit that overruns the end yields a short page rather than reverting —
        // which is what lets a client page until it sees one.
        (address[] memory last, uint64[] memory lastScores) = board.board(GAME, 4, 2);
        assertEq(last.length, 1);
        assertEq(last[0], address(uint160(5)));
        assertEq(lastScores[0], 50);
    }

    function test_boardOffsetPastTheEndIsEmptyNotARevert() public {
        _submit(_claim(alice, 100, board.currentEpoch(), 0));
        (address[] memory players,) = board.board(GAME, 99, 10);
        assertEq(players.length, 0);
    }

    function test_boardZeroLimitIsEmpty() public {
        _submit(_claim(alice, 100, board.currentEpoch(), 0));
        (address[] memory players, uint64[] memory scores) = board.board(GAME, 0, 0);
        assertEq(players.length, 0);
        assertEq(scores.length, 0);
    }

    function test_rostersAreKeyedByGame() public {
        // Same defect as D3, one layer up: two games sharing a roster would show each
        // other's players, with the other board's scores read as zero.
        uint64 other = 2;
        bytes32 otherRules = keccak256("sim-v2");
        board.registerGame(other, otherRules);

        _submit(_claim(alice, 100, board.currentEpoch(), 0));

        Leaderboard.ScoreClaim memory c = _claim(bob, 7, board.currentEpoch(), 0);
        c.gameId = other;
        c.rulesHash = otherRules;
        _submit(c);

        assertEq(board.playerCount(GAME), 1);
        assertEq(board.playerCount(other), 1);

        (address[] memory g1,) = board.board(GAME, 0, 10);
        (address[] memory g2,) = board.board(other, 0, 10);
        assertEq(g1[0], alice);
        assertEq(g2[0], bob);
    }

    function test_rejectedSubmissionsDoNotEnrol() public {
        // A revert must leave no trace on the board, or a player could get a row by
        // submitting something the contract refuses.
        Leaderboard.ScoreClaim memory c = _claim(alice, 100, board.currentEpoch(), 0);
        _expectRevertSignedBy(Leaderboard.BadAttestation.selector, rogueKey, c);
        assertEq(board.playerCount(GAME), 0);
    }

    function test_relayedScoreEnrolsThePlayerNotTheRelayer() public {
        Leaderboard.ScoreClaim memory c = _claim(alice, 500, board.currentEpoch(), 0);
        bytes memory sig = _sign(verifierKey, c);

        vm.prank(relayer);
        board.submit(c, sig);

        (address[] memory players,) = board.board(GAME, 0, 10);
        assertEq(players.length, 1);
        assertEq(players[0], alice, "the roster follows the claim, not msg.sender");
    }

    // -----------------------------------------------------------------------
    // The daily board
    // -----------------------------------------------------------------------

    function test_dayIsDerivedFromTheSignedEpoch() public view {
        // Load-bearing: because the day comes out of `c.epoch`, which the enclave
        // already signs, the daily board needs no new claim field — so SCORE_TYPEHASH,
        // every digest, and the verifier job are all untouched by this feature.
        assertEq(board.currentDay(), board.currentEpoch() / 24);
        assertEq(board.dayOf(board.currentEpoch()), board.currentDay());
    }

    function test_dailyBoardIsEmptyBeforeAnyoneScores() public view {
        uint64 day = board.currentDay();
        assertEq(board.dailyPlayerCount(GAME, day), 0);
        (address[] memory players, uint64[] memory scores) = board.dailyBoard(GAME, day, 0, 10);
        assertEq(players.length, 0);
        assertEq(scores.length, 0);
    }

    function test_dailyBoardResetsAndTheAllTimeBoardDoesNot() public {
        // The whole point of the split. One submission today; tomorrow the daily board
        // is empty for that player while their all-time best is exactly where it was.
        uint64 today = board.currentDay();
        _submit(_claim(alice, 900, board.currentEpoch(), 0));

        assertEq(board.dailyBest(GAME, today, alice), 900);
        assertEq(board.dailyPlayerCount(GAME, today), 1);

        vm.warp(block.timestamp + 1 days);
        uint64 tomorrow = board.currentDay();
        assertTrue(tomorrow != today, "the warp must actually cross a boundary");

        assertEq(board.dailyBest(GAME, tomorrow, alice), 0, "today starts empty");
        assertEq(board.dailyPlayerCount(GAME, tomorrow), 0);
        assertEq(board.best(GAME, alice), 900, "all-time survives the reset");
        assertEq(board.playerCount(GAME), 1);

        // And yesterday is still readable — nothing is deleted, it just stops being
        // the board anyone asks for.
        assertEq(board.dailyBest(GAME, today, alice), 900);
    }

    function test_scoreIsFiledUnderThePlayDayNotTheSubmitDay() public {
        // A run finished at 23:59 belongs to that day even if the transaction lands two
        // minutes later. The alternative — dating by `block.timestamp` — would let the
        // network's latency decide which board a player competed on.
        uint64 playEpoch = board.currentEpoch();
        uint64 playDay = board.dayOf(playEpoch);

        Leaderboard.ScoreClaim memory c = _claim(alice, 700, playEpoch, 0);
        bytes memory sig = _sign(verifierKey, c);

        vm.warp(block.timestamp + 1 days); // still inside the attestation's expiry
        assertTrue(board.currentDay() != playDay, "submitting on a later day");
        assertLe(block.timestamp, c.expiry, "and the attestation is still valid");

        board.submit(c, sig);

        assertEq(board.dailyBest(GAME, playDay, alice), 700, "credited to the day played");
        assertEq(board.dailyBest(GAME, board.currentDay(), alice), 0, "not to the day submitted");
    }

    function test_dailyBestIsTheMaximumWithinTheDay() public {
        uint64 e = board.currentEpoch();
        uint64 day = board.dayOf(e);

        _submit(_claim(alice, 300, e, 0));
        _submit(_claim(alice, 100, e, 1));
        _submit(_claim(alice, 800, e, 2));

        assertEq(board.dailyBest(GAME, day, alice), 800);
        assertEq(board.dailyPlayerCount(GAME, day), 1, "one row per player per day");
    }

    function test_dailyBoardReadsScoresLiveAndPagesLikeTheAllTimeBoard() public {
        uint64 e = board.currentEpoch();
        uint64 day = board.dayOf(e);
        for (uint160 i = 1; i <= 5; ++i) {
            _submit(_claim(address(i), uint64(i) * 10, e, 0));
        }
        assertEq(board.dailyPlayerCount(GAME, day), 5);

        (address[] memory first,) = board.dailyBoard(GAME, day, 0, 2);
        assertEq(first.length, 2);
        assertEq(first[0], address(uint160(1)), "insertion order, not rank order");

        (address[] memory last, uint64[] memory lastScores) = board.dailyBoard(GAME, day, 4, 2);
        assertEq(last.length, 1, "a limit past the end clamps");
        assertEq(lastScores[0], 50);

        (address[] memory none,) = board.dailyBoard(GAME, day, 99, 10);
        assertEq(none.length, 0, "an offset past the end is empty, not a revert");

        (address[] memory all, uint64[] memory scores) = board.dailyBoard(GAME, day, 0, 10);
        for (uint256 i; i < all.length; ++i) {
            assertEq(scores[i], board.dailyBest(GAME, day, all[i]), "must agree with dailyBest");
        }
    }

    function test_dailyRostersAreKeyedByGameAndDay() public {
        uint64 other = 2;
        bytes32 otherRules = keccak256("sim-v2");
        board.registerGame(other, otherRules);

        uint64 e = board.currentEpoch();
        uint64 day = board.dayOf(e);
        _submit(_claim(alice, 100, e, 0));

        Leaderboard.ScoreClaim memory c = _claim(bob, 7, e, 0);
        c.gameId = other;
        c.rulesHash = otherRules;
        _submit(c);

        assertEq(board.dailyPlayerCount(GAME, day), 1);
        assertEq(board.dailyPlayerCount(other, day), 1);

        (address[] memory g1,) = board.dailyBoard(GAME, day, 0, 10);
        (address[] memory g2,) = board.dailyBoard(other, day, 0, 10);
        assertEq(g1[0], alice);
        assertEq(g2[0], bob);
    }

    function test_aZeroScoreEnrolsExactlyOnce() public {
        // The bug that dropping the improvement check would have introduced. A run
        // where the player never moves right scores exactly zero, and the old
        // enrolment test — `best == 0` means "never scored here" — was exact only
        // while `score > best` was required. Without the explicit flag, each of these
        // would push alice onto both rosters again.
        uint64 e = board.currentEpoch();
        uint64 day = board.dayOf(e);

        _submit(_claim(alice, 0, e, 0));
        _submit(_claim(alice, 0, e, 1));
        _submit(_claim(alice, 0, e, 2));

        assertEq(board.best(GAME, alice), 0);
        assertEq(board.playerCount(GAME), 1, "enrolled once despite a zero best");
        assertEq(board.dailyPlayerCount(GAME, day), 1);

        (address[] memory players, uint64[] memory scores) = board.board(GAME, 0, 10);
        assertEq(players.length, 1);
        assertEq(players[0], alice);
        assertEq(scores[0], 0);
    }

    function test_rejectedSubmissionsDoNotEnrolOnEitherBoard() public {
        uint64 e = board.currentEpoch();
        uint64 day = board.dayOf(e);
        Leaderboard.ScoreClaim memory c = _claim(alice, 100, e, 0);
        _expectRevertSignedBy(Leaderboard.BadAttestation.selector, rogueKey, c);

        assertEq(board.playerCount(GAME), 0);
        assertEq(board.dailyPlayerCount(GAME, day), 0);
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

    function test_recordsAScoreThatDoesNotImprove() public {
        // The behaviour this contract exists to demonstrate: a run that beats nothing
        // still lands a transaction, still consumes its session, and still leaves the
        // board holding the better number.
        uint64 e = board.currentEpoch();
        uint64 day = board.dayOf(e);
        _submit(_claim(alice, 500, e, 0));

        _submit(_claim(alice, 400, e, 1));
        assertEq(board.best(GAME, alice), 500, "a weaker run must not overwrite");
        assertTrue(board.usedSession(board.sessionIdFor(alice, e, 1)), "but it is consumed");

        // Equal is not an improvement either, and is likewise recorded rather than
        // refused. This is the case that used to strand a player for a whole epoch:
        // replaying a held seed to the same score reverted and consumed nothing, so the
        // same seed came back forever.
        _submit(_claim(alice, 500, e, 2));
        assertEq(board.best(GAME, alice), 500);
        assertEq(board.dailyBest(GAME, day, alice), 500);
        assertTrue(board.usedSession(board.sessionIdFor(alice, e, 2)));

        assertEq(board.playerCount(GAME), 1, "three submissions, one row");
        assertEq(board.dailyPlayerCount(GAME, day), 1);
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

    function testFuzz_everySubmissionLandsAndBestIsTheMaximum(uint64 first, uint64 second)
        public
    {
        // No `vm.assume` on either score, including zero: the point of the change is
        // that there is no score the contract refuses.
        uint64 e = board.currentEpoch();
        uint64 day = board.dayOf(e);

        _submit(_claim(alice, first, e, 0));
        _submit(_claim(alice, second, e, 1));

        uint64 expected = second > first ? second : first;
        assertEq(board.best(GAME, alice), expected);
        assertEq(board.dailyBest(GAME, day, alice), expected);
        assertEq(board.playerCount(GAME), 1, "two submissions, one row, any scores");
        assertEq(board.dailyPlayerCount(GAME, day), 1);
    }

    function testFuzz_dayIsEpochOverTwentyFour(uint64 epoch) public view {
        assertEq(board.dayOf(epoch), epoch / 24);
    }

    function testFuzz_sessionIdIsInjective(address p1, uint64 e1, uint32 k1, uint64 e2, uint32 k2)
        public
        view
    {
        vm.assume(e1 != e2 || k1 != k2);
        assertTrue(board.sessionIdFor(p1, e1, k1) != board.sessionIdFor(p1, e2, k2));
    }
}
