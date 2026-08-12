// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title TrainingPool
/// @notice Licensed AI Training Compensation Rail — an AI company deposits
///         USDC and commits `corpusRoot = MerkleRoot(fingerprintHash[])`
///         over the training corpus it intends to use, before training.
///
/// @dev Structurally closest to ExploitBounty.sol, not ArcIDBond.sol — same
///      reasoning ExploitBounty's own header comment gives: a pool is
///      funded voluntarily by the company and isn't being punished for
///      anything, so there's no slashing/escalation/dispute-window
///      machinery to reuse. createPool / distributeToClaimContract /
///      withdrawPool mirror registerTarget / submitVerdict / withdrawBounty
///      directly: single full-amount payout, no proportional schedule,
///      mutual-exclusion between the "paid out" and "reclaimed" paths.
///
///      Deliberately does NOT check IArcIDRegistry itself. The TEE-attested
///      identity in this vertical belongs to the ingestion enclave, and
///      that check belongs in CompensationClaim.sol (next phase) at the
///      point the enclave submits its attested allocation — this contract
///      only needs to trust whichever address is wired up as
///      authorizedDistributor, expected to be the deployed
///      CompensationClaim contract itself, not an EOA. Not wired yet:
///      CompensationClaim.sol doesn't exist as of this contract.
contract TrainingPool is Ownable, ReentrancyGuard {
    // -------------------------------------------------------------------------
    // types
    // -------------------------------------------------------------------------

    struct Pool {
        address company;      // funded the pool; can withdraw if never distributed
        bytes32 corpusRoot;   // MerkleRoot(fingerprintHash[]) committed before training
        uint256 amount;       // remaining escrowed balance (atomic units of collateralToken)
        bool distributed;     // true once released to a claim contract
        bool withdrawn;       // true once the company has reclaimed an undistributed pool
    }

    // -------------------------------------------------------------------------
    // storage
    // -------------------------------------------------------------------------

    IERC20 public immutable collateralToken;

    /// @notice The single address allowed to trigger distribution — expected
    ///         to be the CompensationClaim contract once deployed, mirroring
    ///         ExploitBounty's authorizedVerifier pattern.
    address public authorizedDistributor;

    mapping(uint256 => Pool) public pools;
    uint256 public nextPoolId = 1; // 1-based so 0 unambiguously means "not found"

    // -------------------------------------------------------------------------
    // events
    // -------------------------------------------------------------------------

    event PoolCreated(uint256 indexed poolId, address indexed company, bytes32 corpusRoot, uint256 amount);
    event PoolDistributed(uint256 indexed poolId, address indexed claimContract, uint256 amount);
    event PoolWithdrawn(uint256 indexed poolId, address indexed company, uint256 amount);
    event DistributorUpdated(address indexed oldDistributor, address indexed newDistributor);

    // -------------------------------------------------------------------------
    // errors
    // -------------------------------------------------------------------------

    error ZeroAmount();
    error ZeroAddress();
    error ZeroCorpusRoot();
    error PoolNotFound();
    error NotAuthorizedDistributor();
    error NotPoolCompany();
    error AlreadyDistributed();
    error AlreadyWithdrawn();

    // -------------------------------------------------------------------------
    // constructor
    // -------------------------------------------------------------------------

    constructor(address _collateralToken) Ownable(msg.sender) {
        if (_collateralToken == address(0)) revert ZeroAddress();
        collateralToken       = IERC20(_collateralToken);
        authorizedDistributor = msg.sender; // default: deployer, same pattern as ExploitBounty.authorizedVerifier
    }

    // -------------------------------------------------------------------------
    // pool creation
    // -------------------------------------------------------------------------

    /// @notice Anyone can create a pool on their own corpus commitment — no
    ///         gating here, same reasoning as ExploitBounty.registerTarget():
    ///         the trust claim is about the DISTRIBUTOR's eventual attested
    ///         allocation, not about who's allowed to fund a pool.
    function createPool(bytes32 corpusRoot, uint256 amount)
        external
        nonReentrant
        returns (uint256 poolId)
    {
        if (amount == 0) revert ZeroAmount();
        if (corpusRoot == bytes32(0)) revert ZeroCorpusRoot();

        poolId = nextPoolId++;
        pools[poolId] = Pool({
            company:     msg.sender,
            corpusRoot:  corpusRoot,
            amount:      amount,
            distributed: false,
            withdrawn:   false
        });

        bool ok = collateralToken.transferFrom(msg.sender, address(this), amount);
        require(ok, "transferFrom failed");

        emit PoolCreated(poolId, msg.sender, corpusRoot, amount);
    }

    // -------------------------------------------------------------------------
    // distribution — the payout-critical path
    // -------------------------------------------------------------------------

    /// @notice Releases a pool's full escrowed balance to `claimContract` —
    ///         expected to be CompensationClaim, called as part of its own
    ///         attested-allocation submission, not by an EOA directly.
    ///         Single full-amount release, no partial/proportional payout —
    ///         same demo-scope simplicity as ExploitBounty's fixed
    ///         full-bounty-per-finding payout.
    function distributeToClaimContract(uint256 poolId, address claimContract)
        external
        nonReentrant
    {
        if (msg.sender != authorizedDistributor) revert NotAuthorizedDistributor();
        if (claimContract == address(0)) revert ZeroAddress();

        Pool storage p = pools[poolId];
        if (p.company == address(0)) revert PoolNotFound();
        if (p.distributed) revert AlreadyDistributed();
        if (p.withdrawn) revert AlreadyWithdrawn();

        p.distributed = true;
        uint256 amount = p.amount;
        p.amount = 0;

        bool ok = collateralToken.transfer(claimContract, amount);
        require(ok, "transfer failed");

        emit PoolDistributed(poolId, claimContract, amount);
    }

    // -------------------------------------------------------------------------
    // withdrawal
    // -------------------------------------------------------------------------

    /// @notice Company reclaims a pool that was never distributed — e.g.
    ///         training was cancelled, or the corpus commitment needs to be
    ///         redone. Blocked once distribution has happened, mirroring
    ///         ExploitBounty's AlreadyClaimed/AlreadyWithdrawn mutual
    ///         exclusion.
    function withdrawPool(uint256 poolId) external nonReentrant {
        Pool storage p = pools[poolId];
        if (p.company == address(0)) revert PoolNotFound();
        if (msg.sender != p.company) revert NotPoolCompany();
        if (p.distributed) revert AlreadyDistributed();
        if (p.withdrawn) revert AlreadyWithdrawn();

        p.withdrawn = true;
        uint256 amount = p.amount;
        p.amount = 0;

        bool ok = collateralToken.transfer(p.company, amount);
        require(ok, "transfer failed");

        emit PoolWithdrawn(poolId, p.company, amount);
    }

    // -------------------------------------------------------------------------
    // admin
    // -------------------------------------------------------------------------

    function setAuthorizedDistributor(address newDistributor) external onlyOwner {
        if (newDistributor == address(0)) revert ZeroAddress();
        address old = authorizedDistributor;
        authorizedDistributor = newDistributor;
        emit DistributorUpdated(old, newDistributor);
    }
}
