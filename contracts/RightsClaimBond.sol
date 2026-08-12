// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Minimal read surface RightsClaimBond needs from ArtistRegistry —
///         kept local rather than importing the full contract, same
///         discipline ITrainingPoolForClaim already establishes.
interface IArtistRegistryForClaim {
    function artistOf(bytes32 fingerprintHash) external view returns (address);
}

/// @title RightsClaimBond
/// @notice Tier 1 of a rights-verification trust ladder: self-assert + bond.
///         This contract does NOT verify legal ownership. It makes a false
///         rights claim carry real financial consequence, and gives anyone
///         with a conflicting claim a real, contestable, on-chain way to
///         challenge it and take the bond. Docs/copy referencing this
///         contract must say "bonded rights claim" — never "verified
///         rights" or "proven ownership."
///
/// @dev New contract, deliberately not an ArtistRegistry or ArcIDBond
///      extension (Phase 0 scoping — see CHANGELOG.md). ArtistRegistry.
///      registerTrack() is free/permissionless with existing tests and
///      real registered tracks on Arc testnet; ArcIDBond's dispute
///      machinery (fileIndictment/resolveDispute/finalizeExpiredDispute)
///      is single-sided by construction — only the accused's bond is ever
///      at stake, the accuser never bonds anything. This needs a
///      genuinely two-sided bond (claimant AND challenger both stake
///      capital, loser's moves to winner) — a real structural difference
///      from that pattern, not a relabel of its Dispute struct.
///
///      Deliberate v1 simplification, stated rather than hidden: a
///      Challenged claim has NO permissionless auto-resolution or
///      timeout — only resolveChallenge() (owner) can close it. Unlike
///      ArcIDBond's optimistic window (which defaults to approving an
///      indictment a professional adjudicator already vetted), a raw
///      counter-claim between two self-interested strangers has no
///      equivalent honest default winner — defaulting either way would be
///      arbitrary, not "optimistic." This means a challenged claim CAN
///      get stuck indefinitely if the owner never acts — an accepted,
///      known operational gap, same honesty standard as ArcIDBond's own
///      documented withdrawBond()-during-dispute gap. See README.
///
///      Also v1-scoped, deliberately not built: re-filing a claim after
///      Overturned (a fingerprintHash gets exactly one claim attempt,
///      ever, in this version) and withdrawing a claimant's bond after
///      Upheld (it stays locked, backing the claim, no exit path yet).
///      Both are real, statable limitations, not silent gaps.
contract RightsClaimBond is Ownable, ReentrancyGuard {
    // -------------------------------------------------------------------------
    // types
    // -------------------------------------------------------------------------

    enum ClaimState { None, Pending, Challenged, Upheld, Overturned }

    struct Claim {
        address claimant;
        bytes32 claimHash;        // hash of the off-chain claim text — same "hash the evidence" pattern as rationaleHash elsewhere
        uint256 claimantBond;
        uint256 windowDeadline;
        address challenger;       // zero until challenged
        bytes32 counterClaimHash;
        uint256 challengerBond;
        ClaimState state;
    }

    // -------------------------------------------------------------------------
    // storage
    // -------------------------------------------------------------------------

    IERC20 public immutable collateralToken;
    IArtistRegistryForClaim public immutable artistRegistry;

    /// @notice Owner-tunable, same pattern as every other window/threshold
    ///         config elsewhere in this repo.
    uint64 public disputeWindow;

    /// @notice One claim slot per fingerprintHash, ever — see the v1
    ///         no-refiling-after-Overturned note above.
    mapping(bytes32 => Claim) public claims;

    // -------------------------------------------------------------------------
    // events
    // -------------------------------------------------------------------------

    event ClaimFiled(bytes32 indexed fingerprintHash, address indexed claimant, bytes32 claimHash, uint256 bondAmount, uint256 windowDeadline);
    event ClaimChallenged(bytes32 indexed fingerprintHash, address indexed challenger, bytes32 counterClaimHash, uint256 bondAmount);
    event ClaimUpheldUnchallenged(bytes32 indexed fingerprintHash);
    event ChallengeResolved(bytes32 indexed fingerprintHash, bool claimantWon, address indexed claimant, address indexed challenger);
    event DisputeWindowUpdated(uint64 disputeWindow);

    // -------------------------------------------------------------------------
    // errors
    // -------------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error InvalidDisputeWindow();
    error NotTrackArtist();      // also covers "fingerprintHash not registered at all" — artistOf() returns address(0) either way
    error ClaimAlreadyExists();
    error ClaimNotPending();
    error ClaimNotChallenged();
    error WindowNotExpired();
    error WindowExpired();
    error BondMismatch();

    // -------------------------------------------------------------------------
    // constructor
    // -------------------------------------------------------------------------

    constructor(address _collateralToken, address _artistRegistry, uint64 _disputeWindow) Ownable(msg.sender) {
        if (_collateralToken == address(0) || _artistRegistry == address(0)) revert ZeroAddress();
        if (_disputeWindow == 0) revert InvalidDisputeWindow();
        collateralToken = IERC20(_collateralToken);
        artistRegistry  = IArtistRegistryForClaim(_artistRegistry);
        disputeWindow   = _disputeWindow;
    }

    // -------------------------------------------------------------------------
    // claim filing
    // -------------------------------------------------------------------------

    /// @notice The registered artist of `fingerprintHash` stakes a bond
    ///         alongside a rights claim. Opens a dispute window; anyone can
    ///         challenge before it closes.
    function fileClaim(bytes32 fingerprintHash, bytes32 claimHash, uint256 bondAmount) external nonReentrant {
        if (bondAmount == 0) revert ZeroAmount();
        if (artistRegistry.artistOf(fingerprintHash) != msg.sender) revert NotTrackArtist();
        if (claims[fingerprintHash].state != ClaimState.None) revert ClaimAlreadyExists();

        bool ok = collateralToken.transferFrom(msg.sender, address(this), bondAmount);
        require(ok, "transferFrom failed");

        uint256 deadline = block.timestamp + disputeWindow;
        claims[fingerprintHash] = Claim({
            claimant:         msg.sender,
            claimHash:        claimHash,
            claimantBond:     bondAmount,
            windowDeadline:   deadline,
            challenger:       address(0),
            counterClaimHash: bytes32(0),
            challengerBond:   0,
            state:            ClaimState.Pending
        });

        emit ClaimFiled(fingerprintHash, msg.sender, claimHash, bondAmount, deadline);
    }

    // -------------------------------------------------------------------------
    // challenge — the genuinely two-sided part
    // -------------------------------------------------------------------------

    /// @notice Anyone may challenge a Pending claim before its window
    ///         closes, by staking a bond that exactly matches the
    ///         claimant's (symmetric stake — a deliberate v1
    ///         simplification, not a minimum). Challenging is not free:
    ///         if the challenge fails, the challenger's own bond is what's
    ///         taken.
    function challengeClaim(bytes32 fingerprintHash, bytes32 counterClaimHash, uint256 bondAmount) external nonReentrant {
        Claim storage c = claims[fingerprintHash];
        if (c.state != ClaimState.Pending) revert ClaimNotPending();
        if (block.timestamp >= c.windowDeadline) revert WindowExpired();
        if (bondAmount != c.claimantBond) revert BondMismatch();

        bool ok = collateralToken.transferFrom(msg.sender, address(this), bondAmount);
        require(ok, "transferFrom failed");

        c.challenger       = msg.sender;
        c.counterClaimHash = counterClaimHash;
        c.challengerBond    = bondAmount;
        c.state             = ClaimState.Challenged;

        emit ClaimChallenged(fingerprintHash, msg.sender, counterClaimHash, bondAmount);
    }

    // -------------------------------------------------------------------------
    // resolution
    // -------------------------------------------------------------------------

    /// @notice Permissionlessly close out a claim that was never challenged
    ///         once its window has passed — the track becomes licensable.
    function finalizeUnchallenged(bytes32 fingerprintHash) external nonReentrant {
        Claim storage c = claims[fingerprintHash];
        if (c.state != ClaimState.Pending) revert ClaimNotPending();
        if (block.timestamp < c.windowDeadline) revert WindowNotExpired();

        c.state = ClaimState.Upheld;
        emit ClaimUpheldUnchallenged(fingerprintHash);
    }

    /// @notice Owner-only resolution of a Challenged claim — see the
    ///         contract-level NatSpec for why this is NOT permissionless
    ///         or auto-timing-out in v1. `claimantWins=true` moves the
    ///         challenger's bond to the claimant (claimant's own bond
    ///         stays locked, same as the unchallenged path). `false`
    ///         moves BOTH bonds to the challenger.
    function resolveChallenge(bytes32 fingerprintHash, bool claimantWins) external onlyOwner nonReentrant {
        Claim storage c = claims[fingerprintHash];
        if (c.state != ClaimState.Challenged) revert ClaimNotChallenged();

        if (claimantWins) {
            c.state = ClaimState.Upheld;
            bool ok = collateralToken.transfer(c.claimant, c.challengerBond);
            require(ok, "transfer failed");
        } else {
            c.state = ClaimState.Overturned;
            bool ok = collateralToken.transfer(c.challenger, c.claimantBond + c.challengerBond);
            require(ok, "transfer failed");
        }

        emit ChallengeResolved(fingerprintHash, claimantWins, c.claimant, c.challenger);
    }

    // -------------------------------------------------------------------------
    // views
    // -------------------------------------------------------------------------

    /// @notice True only once a claim has actually been upheld — either
    ///         unchallenged-and-window-passed, or challenged-and-resolved
    ///         in the claimant's favor. This is the gate the ingestion
    ///         enclave checks before including a track in a corpus.
    function isLicensable(bytes32 fingerprintHash) external view returns (bool) {
        return claims[fingerprintHash].state == ClaimState.Upheld;
    }

    // -------------------------------------------------------------------------
    // admin
    // -------------------------------------------------------------------------

    function setDisputeWindow(uint64 _disputeWindow) external onlyOwner {
        if (_disputeWindow == 0) revert InvalidDisputeWindow();
        disputeWindow = _disputeWindow;
        emit DisputeWindowUpdated(_disputeWindow);
    }
}
