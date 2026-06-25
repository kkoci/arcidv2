// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IArcIDRegistry} from "./interfaces/IArcIDRegistry.sol";

/// @title ArcIDBond
/// @notice Bonded reputation contract for ArcID agents on Arc.
///
///         Agents post ERC-20 collateral (USDC or USYC) to register with the
///         bond contract.  A consumer agent that purchases a service via x402
///         nanopayments uses an LLM-driven adjudication step to decide whether
///         the provider delivered.  On a confirmed breach the consumer calls
///         slash(), which transfers the bond to the consumer wallet — making
///         reputation capital-at-risk rather than a score you ask to be trusted.
///
/// MOAT
///   TEE-gating:    Only agents whose wallet is registered in ArcIDRegistry
///                  (i.e. agentIdBySigner[address] != bytes32(0)) may post a
///                  bond.  Unverified wallets revert with the literal string
///                  "Agent not TEE-verified in ArcID registry" — this is your
///                  proof-of-gating screenshot.  A wrong answer is
///                  cryptographically attributable to a real verified agent.
///
///   USYC support:  Deploy with the USYC token address (Phase 5) to issue
///                  yield-bearing bonds.  Same contract, different constructor
///                  arg — no new code needed.
///
/// SIMPLIFICATIONS (deliberate, note in writeup)
///   - authorizedSlasher defaults to the deployer wallet.  For the hackathon
///     the consumer agent runs under this key.  A multi-slasher / dispute-
///     window model is deliberate future work noted in the README.
///   - No minimum bond enforced on-chain.  The consumer agent's adjudication
///     logic is the trust-but-verify layer; the contract handles the transfer.
///
/// @custom:security ReentrancyGuard on all state-mutating external functions.
contract ArcIDBond is Ownable, ReentrancyGuard {

    // -------------------------------------------------------------------------
    // types
    // -------------------------------------------------------------------------

    struct BondInfo {
        uint256 amount;     // collateral held in this contract
        uint64  postedAt;   // block.timestamp of postBond() call
        bool    slashed;    // true once slash() executes
    }

    // -------------------------------------------------------------------------
    // storage
    // -------------------------------------------------------------------------

    IERC20             public immutable collateralToken; // USDC or USYC — fixed at deploy
    IArcIDRegistry     public immutable registry;         // live ArcIDRegistry on Arc

    address public authorizedSlasher; // consumer agent wallet; owner can update

    mapping(address => BondInfo) public bonds;

    // -------------------------------------------------------------------------
    // events — consumed by the frontend live counters and the consumer agent log
    // -------------------------------------------------------------------------

    /// @dev Emitted on every successful postBond(). Frontend reads TVL from these.
    event BondPosted(
        address indexed agent,
        uint256 amount,
        address indexed token
    );

    /// @dev Emitted on slash(). Frontend flips badge Active → Slashed on this event.
    event AgentSlashed(
        address indexed agent,
        address indexed consumer,
        uint256 amount,
        string  reason      // LLM-authored rationale from the consumer agent
    );

    /// @dev Emitted on voluntarywithdrawal.
    event BondWithdrawn(address indexed agent, uint256 amount);

    /// @dev Emitted when the owner rotates the slasher key.
    event SlasherUpdated(address indexed oldSlasher, address indexed newSlasher);

    // -------------------------------------------------------------------------
    // custom errors (gas-efficient; BondPosted gating uses require() for demo UX)
    // -------------------------------------------------------------------------

    error ZeroAmount();
    error BondAlreadyActive();
    error NoBondFound();
    error AlreadySlashed();
    error NotAuthorizedSlasher();

    // -------------------------------------------------------------------------
    // constructor
    // -------------------------------------------------------------------------

    /// @param _collateralToken ERC-20 used as bond collateral. Arc testnet USDC:
    ///        0x3600000000000000000000000000000000000000
    ///        Arc testnet USYC (Phase 5):
    ///        0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C
    /// @param _registry        Live ArcIDRegistry contract address on Arc.
    constructor(address _collateralToken, address _registry) Ownable(msg.sender) {
        collateralToken  = IERC20(_collateralToken);
        registry         = IArcIDRegistry(_registry);
        authorizedSlasher = msg.sender; // default: deployer == consumer agent for hackathon
    }

    // -------------------------------------------------------------------------
    // core: bond posting
    // -------------------------------------------------------------------------

    /// @notice Post a bond. Caller must be TEE-verified in ArcIDRegistry and
    ///         must have approved this contract to spend `amount` of collateralToken.
    ///
    /// @dev    The gating revert string "Agent not TEE-verified in ArcID registry"
    ///         is intentionally a human-readable require() rather than a custom error
    ///         so it appears verbatim in explorers and curl output — it is the
    ///         proof-of-gating screenshot for the case study.
    function postBond(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        // THE MOAT: only TEE-attested wallets may post
        require(
            registry.agentIdBySigner(msg.sender) != bytes32(0),
            "Agent not TEE-verified in ArcID registry"
        );

        // Allow re-bonding after a slash (agent reposts after losing a bond)
        if (bonds[msg.sender].postedAt != 0 && !bonds[msg.sender].slashed) {
            revert BondAlreadyActive();
        }

        collateralToken.transferFrom(msg.sender, address(this), amount);

        bonds[msg.sender] = BondInfo({
            amount:   amount,
            postedAt: uint64(block.timestamp),
            slashed:  false
        });

        emit BondPosted(msg.sender, amount, address(collateralToken));
    }

    // -------------------------------------------------------------------------
    // core: slash
    // -------------------------------------------------------------------------

    /// @notice Slash a bonded agent on a confirmed service breach.
    ///         Transfers the full bond to `consumer`.
    ///
    /// @param agent    The bonded provider agent that underdelivered.
    /// @param consumer The consumer wallet that paid for the service.
    /// @param reason   LLM-authored rationale from the consumer adjudication agent.
    ///                 Logged in AgentSlashed event for on-chain accountability.
    function slash(
        address agent,
        address consumer,
        string calldata reason
    ) external nonReentrant {
        if (msg.sender != authorizedSlasher) revert NotAuthorizedSlasher();

        BondInfo storage b = bonds[agent];
        if (b.postedAt == 0) revert NoBondFound();
        if (b.slashed)       revert AlreadySlashed();

        b.slashed = true;
        uint256 amount = b.amount;

        collateralToken.transfer(consumer, amount);

        emit AgentSlashed(agent, consumer, amount, reason);
    }

    // -------------------------------------------------------------------------
    // core: voluntary withdrawal
    // -------------------------------------------------------------------------

    /// @notice Withdraw an unslashed bond. Only the bonded agent can call.
    function withdrawBond() external nonReentrant {
        BondInfo storage b = bonds[msg.sender];
        if (b.postedAt == 0) revert NoBondFound();
        if (b.slashed)       revert AlreadySlashed();

        uint256 amount = b.amount;
        delete bonds[msg.sender];

        collateralToken.transfer(msg.sender, amount);

        emit BondWithdrawn(msg.sender, amount);
    }

    // -------------------------------------------------------------------------
    // views
    // -------------------------------------------------------------------------

    /// @notice True if agent has an active (un-slashed) bond on file.
    ///         Used by the consumer agent before deciding whether to call slash().
    function isActiveBondedAgent(address agent) external view returns (bool) {
        BondInfo storage b = bonds[agent];
        return b.postedAt != 0 && !b.slashed;
    }

    // -------------------------------------------------------------------------
    // admin
    // -------------------------------------------------------------------------

    /// @notice Rotate the authorized slasher to a new consumer agent wallet.
    function setAuthorizedSlasher(address newSlasher) external onlyOwner {
        emit SlasherUpdated(authorizedSlasher, newSlasher);
        authorizedSlasher = newSlasher;
    }
}
