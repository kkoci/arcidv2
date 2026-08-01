// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC8004ReputationAdapter} from "./interfaces/IERC8004ReputationAdapter.sol";
import {IERC8004ReputationRegistry} from "./interfaces/IERC8004ReputationRegistry.sol";

/// @title ERC8004ReputationAdapter
/// @notice Thin adapter between ArcIDBond and Arc's real, already-deployed
///         ERC-8004 ReputationRegistry (Phase 8.2, post-submission — see
///         CHANGELOG.md). A separate contract rather than logic inlined into
///         ArcIDBond.sol, deliberately — ArcIDBond is already 850+ lines
///         across six prior phases; all 8004-specific mapping/scaling logic
///         lives here instead, independently testable.
///
///         Value scale (per Phase 8.2's design decision — a real function of
///         numbers ArcIDBond already computes, not an arbitrary separate
///         scale): int128 in [-100, 100], valueDecimals = 0.
///           - Clean settlement  -> value = 100 (best).
///           - Slash             -> value = -(amountSlashed * 100 / bondBeforeSlash),
///                                  i.e. the negative percentage of the
///                                  remaining bond this specific slash took.
///                                  A full-drain escalation naturally computes
///                                  to -100 (worst) since amountSlashed ==
///                                  bondBeforeSlash in that case.
///
///         feedbackHash here is a commitment to arcid2's own evidentiary hash
///         (the same value used as the /api/verdict/:hash lookup key) — NOT a
///         keccak256 of feedbackURI's JSON body. Computing a real content-hash
///         on-chain isn't possible (this contract never sees that JSON); this
///         is a narrower guarantee than the EIP's IPFS-content-hash use case,
///         flagged here rather than silently equated.
///
/// @custom:security ArcIDBond wraps every call into this contract in
///         try/catch (see ArcIDBond.sol's _executeSlash()/recordSettlement()).
///         This contract additionally wraps its own call into the external
///         ReputationRegistry in try/catch, so a misbehaving, paused, or
///         unavailable external registry degrades ONLY the reputation
///         dual-write, never ArcIDBond's core slash/settlement logic. Two
///         independent layers of defense against the same failure mode,
///         deliberately — this contract cannot be relied upon to be the only
///         thing standing between a bad external call and a stuck slash.
contract ERC8004ReputationAdapter is Ownable, IERC8004ReputationAdapter {
    IERC8004ReputationRegistry public immutable reputationRegistry;

    /// @dev The only address allowed to call reportSlash()/reportSettlement().
    ///      Owner-settable rather than immutable so a redeployed ArcIDBond
    ///      (as has already happened once this project — see CHANGELOG.md's
    ///      Phase 6.1 redeploy entry) doesn't strand this adapter unusable.
    address public bondContract;

    /// @dev Real ERC-8004 agentId per arcid2 wallet, set once per agent after
    ///      registering it in Arc's IdentityRegistry (off-chain step — see
    ///      scripts/cli/register-8004-identity.js). Zero means "not
    ///      registered yet" — reportSlash()/reportSettlement() skip cleanly
    ///      (emit ReputationSkipped, don't revert) rather than write a bogus
    ///      agentId.
    mapping(address => uint256) public agentId8004;

    /// @dev Base URL for the off-chain verdict-detail route (oracle's
    ///      GET /api/verdict/:verdictHash — Phase 8.2). Owner-settable since
    ///      the oracle's public URL changes across redeploys (see the Phala
    ///      CVM redeploy history in CHANGELOG.md) — never hardcoded.
    string public verdictBaseURI;

    event AgentIdSet(address indexed wallet, uint256 indexed agentId);
    event BondContractUpdated(address indexed oldBond, address indexed newBond);
    event VerdictBaseURIUpdated(string oldURI, string newURI);
    event ReputationReported(address indexed agent, uint256 indexed agentId, int128 value, bool wasSlash);
    event ReputationWriteFailed(address indexed agent, uint256 indexed agentId, string reason);
    event ReputationSkipped(address indexed agent, string reason);

    error NotBondContract();

    modifier onlyBond() {
        if (msg.sender != bondContract) revert NotBondContract();
        _;
    }

    constructor(address _reputationRegistry, address _bondContract) Ownable(msg.sender) {
        reputationRegistry = IERC8004ReputationRegistry(_reputationRegistry);
        bondContract = _bondContract;
    }

    function setAgentId(address wallet, uint256 agentId) external onlyOwner {
        agentId8004[wallet] = agentId;
        emit AgentIdSet(wallet, agentId);
    }

    function setBondContract(address newBond) external onlyOwner {
        emit BondContractUpdated(bondContract, newBond);
        bondContract = newBond;
    }

    function setVerdictBaseURI(string calldata newURI) external onlyOwner {
        emit VerdictBaseURIUpdated(verdictBaseURI, newURI);
        verdictBaseURI = newURI;
    }

    function reportSlash(
        address agent,
        uint256 amountSlashed,
        uint256 bondBeforeSlash,
        bool isHard,
        bytes32 evidenceHash
    ) external onlyBond {
        uint256 agentId = agentId8004[agent];
        if (agentId == 0) {
            emit ReputationSkipped(agent, "agent not registered in ERC-8004 IdentityRegistry");
            return;
        }

        int128 value = bondBeforeSlash == 0
            ? int128(-100)
            : -int128(int256(amountSlashed * 100 / bondBeforeSlash));

        _giveFeedback(
            agent,
            agentId,
            value,
            "arcid2",
            isHard ? "hard" : "semantic",
            evidenceHash,
            true
        );
    }

    function reportSettlement(address agent, bytes32 verdictHash) external onlyBond {
        uint256 agentId = agentId8004[agent];
        if (agentId == 0) {
            emit ReputationSkipped(agent, "agent not registered in ERC-8004 IdentityRegistry");
            return;
        }

        _giveFeedback(agent, agentId, int128(100), "arcid2", "settlement", verdictHash, false);
    }

    function _giveFeedback(
        address agent,
        uint256 agentId,
        int128 value,
        string memory tag1,
        string memory tag2,
        bytes32 evidenceHash,
        bool wasSlash
    ) internal {
        string memory feedbackURI = string.concat(verdictBaseURI, _toHex(evidenceHash));

        try reputationRegistry.giveFeedback(
            agentId,
            value,
            0, // valueDecimals — plain integer percentage, no fractional precision needed
            tag1,
            tag2,
            "arcid2:ArcIDBond", // endpoint — identifies the service evaluated, not a fetchable URL
            feedbackURI,
            evidenceHash
        ) {
            emit ReputationReported(agent, agentId, value, wasSlash);
        } catch Error(string memory reason) {
            emit ReputationWriteFailed(agent, agentId, reason);
        } catch {
            emit ReputationWriteFailed(agent, agentId, "unknown revert");
        }
    }

    /// @dev Minimal bytes32 -> "0x…" hex encoder. No existing dependency in
    ///      this repo already provides this for a standalone contract file,
    ///      and OpenZeppelin's Strings.toHexString(bytes32) target isn't
    ///      pulled in elsewhere in this project — small enough to inline
    ///      rather than add a new OZ import surface for one helper.
    function _toHex(bytes32 data) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory str = new bytes(66);
        str[0] = "0";
        str[1] = "x";
        for (uint256 i = 0; i < 32; i++) {
            str[2 + i * 2]     = alphabet[uint8(data[i] >> 4)];
            str[2 + i * 2 + 1] = alphabet[uint8(data[i] & 0x0f)];
        }
        return string(str);
    }
}
