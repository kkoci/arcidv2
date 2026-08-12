// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IArcIDRegistry} from "./interfaces/IArcIDRegistry.sol";

/// @notice Minimal read+write surface CompensationClaim needs from
///         TrainingPool — kept local rather than importing the full
///         contract, same "small interface, not the whole ABI" discipline
///         IArcIDRegistry already establishes.
interface ITrainingPoolForClaim {
    function pools(uint256 poolId) external view returns (
        address company, bytes32 corpusRoot, uint256 amount, bool distributed, bool withdrawn
    );
    function distributeToClaimContract(uint256 poolId, address claimContract) external;
}

/// @title CompensationClaim
/// @notice Licensed AI Training Compensation Rail — the N-recipient payout
///         layer. The TEE-attested ingestion enclave (ingestor/, Phase 3)
///         submits an attested `allocationRoot` for a pool; each artist
///         then claims their own leaf via a real Merkle proof — not a
///         simplified direct-transfer loop, per the Phase 0 correction.
///
/// @dev Ingestor gating mirrors ExploitBounty.submitVerdict() exactly: two
///      independent checks (a settable authorizedIngestor address, plus a
///      per-call IArcIDRegistry.agentIdBySigner() TEE check) — msg.sender
///      IS the proof of identity for this call, the same way it is for
///      ExploitBounty's verifier. The enclave's own off-chain ECDSA
///      signature (ingestor/src/signer.js) is evidence/audit material, not
///      re-verified here — msg.sender already provides an equivalent,
///      simpler guarantee for a direct submission, so re-checking the
///      signature on top would duplicate a check without adding a new one.
///
///      Leaf encoding MUST match ingestor/src/merkle.js's hashLeaf(
///      ["address","uint256"], [artist, amount]) exactly:
///      keccak256(bytes.concat(keccak256(abi.encode(artist, amount)))).
contract CompensationClaim is Ownable, ReentrancyGuard {
    // -------------------------------------------------------------------------
    // types
    // -------------------------------------------------------------------------

    struct Allocation {
        bytes32 allocationRoot;
        uint256 totalAmount;   // pulled from TrainingPool at submission time
        uint256 claimedAmount; // running total actually paid out so far
        bool submitted;
    }

    // -------------------------------------------------------------------------
    // storage
    // -------------------------------------------------------------------------

    IERC20 public immutable collateralToken;
    IArcIDRegistry public immutable registry;
    ITrainingPoolForClaim public immutable trainingPool;

    /// @notice The single wallet allowed to submit allocations — expected to
    ///         be the ingestion enclave's wallet, mirroring ExploitBounty's
    ///         authorizedVerifier pattern.
    address public authorizedIngestor;

    mapping(uint256 => Allocation) public allocations;              // poolId -> allocation
    mapping(uint256 => mapping(address => bool)) public claimed;    // poolId -> artist -> claimed

    // -------------------------------------------------------------------------
    // events
    // -------------------------------------------------------------------------

    event AllocationSubmitted(uint256 indexed poolId, bytes32 allocationRoot, uint256 totalAmount);
    event Claimed(uint256 indexed poolId, address indexed artist, uint256 amount);
    event IngestorUpdated(address indexed oldIngestor, address indexed newIngestor);

    // -------------------------------------------------------------------------
    // errors
    // -------------------------------------------------------------------------

    error ZeroAddress();
    error NotAuthorizedIngestor();
    error IngestorNotTEEVerified();
    error PoolNotFound();
    error AlreadySubmitted();
    error NotSubmitted();
    error AlreadyClaimed();
    error InvalidProof();

    // -------------------------------------------------------------------------
    // constructor
    // -------------------------------------------------------------------------

    constructor(address _collateralToken, address _registry, address _trainingPool) Ownable(msg.sender) {
        if (_collateralToken == address(0) || _registry == address(0) || _trainingPool == address(0)) {
            revert ZeroAddress();
        }
        collateralToken   = IERC20(_collateralToken);
        registry          = IArcIDRegistry(_registry);
        trainingPool      = ITrainingPoolForClaim(_trainingPool);
        authorizedIngestor = msg.sender; // default: deployer, same pattern as ExploitBounty.authorizedVerifier
    }

    // -------------------------------------------------------------------------
    // allocation submission — the payout-critical path
    // -------------------------------------------------------------------------

    /// @notice Submits the enclave's attested allocation for a pool and
    ///         pulls that pool's escrowed funds in from TrainingPool in the
    ///         same call — the allocation record and the funds it pays out
    ///         against always land together, never one without the other.
    function submitAllocation(uint256 poolId, bytes32 allocationRoot) external nonReentrant {
        if (msg.sender != authorizedIngestor) revert NotAuthorizedIngestor();
        if (registry.agentIdBySigner(msg.sender) == bytes32(0)) revert IngestorNotTEEVerified();
        if (allocations[poolId].submitted) revert AlreadySubmitted();

        (address company, , uint256 amount, , ) = trainingPool.pools(poolId);
        if (company == address(0)) revert PoolNotFound();

        allocations[poolId] = Allocation({
            allocationRoot: allocationRoot,
            totalAmount:    amount,
            claimedAmount:  0,
            submitted:      true
        });

        emit AllocationSubmitted(poolId, allocationRoot, amount);

        // Reverts naturally (AlreadyDistributed/AlreadyWithdrawn) if the pool
        // was already released or reclaimed on TrainingPool's side — no need
        // to duplicate those checks here.
        trainingPool.distributeToClaimContract(poolId, address(this));
    }

    // -------------------------------------------------------------------------
    // claim — the N-recipient payout path
    // -------------------------------------------------------------------------

    /// @notice An artist claims their share of a submitted allocation via a
    ///         real Merkle proof against the attested allocationRoot.
    function claim(uint256 poolId, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        Allocation storage a = allocations[poolId];
        if (!a.submitted) revert NotSubmitted();
        if (claimed[poolId][msg.sender]) revert AlreadyClaimed();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, amount))));
        if (!MerkleProof.verify(proof, a.allocationRoot, leaf)) revert InvalidProof();

        claimed[poolId][msg.sender] = true;
        a.claimedAmount += amount;

        bool ok = collateralToken.transfer(msg.sender, amount);
        require(ok, "transfer failed");

        emit Claimed(poolId, msg.sender, amount);
    }

    // -------------------------------------------------------------------------
    // admin
    // -------------------------------------------------------------------------

    function setAuthorizedIngestor(address newIngestor) external onlyOwner {
        if (newIngestor == address(0)) revert ZeroAddress();
        address old = authorizedIngestor;
        authorizedIngestor = newIngestor;
        emit IngestorUpdated(old, newIngestor);
    }
}
