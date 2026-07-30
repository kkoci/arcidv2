/**
 * slasher.js — Calls ArcIDBond.slash() on-chain when the adjudicator returns a breach verdict.
 *
 * In DEV_MODE=true: logs the slash without sending an on-chain tx (no RPC needed locally).
 * In production:    sends a real tx to Arc testnet.
 *
 * Phase 6 (post-submission — see CHANGELOG.md): when config.SESSION_GUARD_ADDRESS
 * is set, CONSUMER_PRIVATE_KEY is treated as a bounded session key and the call
 * routes through ConsumerSessionKeyGuard.guardedSlash() instead of hitting
 * ArcIDBond.slash() directly. The guard enforces its own fixed payout address
 * on-chain, so `consumerAddress` below is only used for the pre-flight bond
 * check and log lines in that mode, not as the actual on-chain recipient.
 *
 * Tiered adjudication, Phase 3 (post-submission — see CHANGELOG.md): every
 * call runs through slashGate.js's gateSlash() first — payee, target,
 * breach-classification, and verdict-hash checks — BEFORE the DEV_MODE
 * branch, so gate violations are demonstrable without a funded testnet
 * wallet, same reasoning Phase 8 applied to the circuit breaker. A gate
 * rejection throws SlashGateError, which propagates to the caller exactly
 * like any other slash failure already did.
 */

const { ethers } = require("ethers");
const config     = require("./config");
const { gateSlash } = require("./slashGate");

// Human-readable ABI — ethers v6 parses these directly
const BOND_ABI = [
  "function slash(address agent, address consumer, string calldata reason) external",
  "function isActiveBondedAgent(address agent) external view returns (bool)",
  "function bonds(address) external view returns (uint256 amount, uint64 postedAt, bool slashed)",
];

const GUARD_ABI = [
  "function guardedSlash(address agent, string calldata reason) external",
  "function payoutAddress() external view returns (address)",
  "function hasActiveSession() external view returns (bool)",
];

function getBondContract(signerOrProvider) {
  return new ethers.Contract(config.BOND_CONTRACT_ADDRESS, BOND_ABI, signerOrProvider);
}

function getGuardContract(signerOrProvider) {
  return new ethers.Contract(config.SESSION_GUARD_ADDRESS, GUARD_ABI, signerOrProvider);
}

/**
 * Execute a slash on-chain (or simulate in dev mode).
 *
 * @param {object} params
 * @param {string} params.agentAddress     Oracle provider wallet to slash
 * @param {string} params.consumerAddress  Consumer wallet that receives the bond (ignored
 *                                         on-chain when routing through the session guard —
 *                                         the guard's fixed payoutAddress wins instead)
 * @param {string} params.reason           LLM-authored (or Tier 1 machine-generated) rationale,
 *                                         written to AgentSlashed event
 * @param {object} params.oracleResponse   The raw oracle response this verdict was adjudicated over
 * @param {object} params.verdict          The finalized verdict object (either tier)
 * @param {string} params.expectedHash     Verdict-hash captured at verdict-finalization time
 * @returns {Promise<{txHash: string|null, simulated: boolean}>}
 */
async function executeSlash({ agentAddress, consumerAddress, reason, oracleResponse, verdict, expectedHash }) {
  await gateSlash({ agentAddress, consumerAddress, oracleResponse, verdict, expectedHash });

  if (config.DEV_MODE) {
    console.log(`  [slash] DEV_MODE — simulated slash`);
    console.log(`  [slash] agent:    ${agentAddress}`);
    console.log(`  [slash] consumer: ${consumerAddress}`);
    console.log(`  [slash] reason:   ${reason.slice(0, 120)}...`);
    return { txHash: null, simulated: true };
  }

  const provider = new ethers.JsonRpcProvider(config.ARC_RPC_URL);
  const signer   = new ethers.Wallet(config.CONSUMER_PRIVATE_KEY, provider);
  const bond     = getBondContract(provider);

  // Confirm there's an active bond to slash before sending the tx
  const isActive = await bond.isActiveBondedAgent(agentAddress);
  if (!isActive) {
    console.warn(`  [slash] WARNING: agent ${agentAddress} has no active bond — skipping slash`);
    return { txHash: null, simulated: false, skipped: true };
  }

  if (config.SESSION_GUARD_ADDRESS) {
    const guard = getGuardContract(signer);

    const active = await guard.hasActiveSession();
    if (!active) {
      console.warn(`  [slash] WARNING: no active session key on the guard — skipping slash`);
      return { txHash: null, simulated: false, skipped: true };
    }

    const guardPayout = await guard.payoutAddress();
    if (guardPayout.toLowerCase() !== consumerAddress.toLowerCase()) {
      console.warn(
        `  [slash] NOTE: guard payoutAddress (${guardPayout}) differs from ` +
        `CONSUMER_WALLET_ADDRESS (${consumerAddress}) — funds go to the guard's ` +
        `fixed payout address regardless.`
      );
    }

    const tx      = await guard.guardedSlash(agentAddress, reason);
    const receipt = await tx.wait();
    return { txHash: receipt.hash, simulated: false };
  }

  const tx      = await bond.connect(signer).slash(agentAddress, consumerAddress, reason);
  const receipt = await tx.wait();

  return { txHash: receipt.hash, simulated: false };
}

/**
 * Read current bond info for an agent (useful for display / traction logging).
 * @returns {Promise<{amount: string, postedAt: number, slashed: boolean}|null>}
 */
async function getBondInfo(agentAddress) {
  try {
    const provider = new ethers.JsonRpcProvider(config.ARC_RPC_URL);
    const bond     = getBondContract(provider);
    const info     = await bond.bonds(agentAddress);
    return {
      amount:   ethers.formatUnits(info.amount, 6), // USDC has 6 decimals
      postedAt: Number(info.postedAt),
      slashed:  info.slashed,
    };
  } catch {
    return null;
  }
}

module.exports = { executeSlash, getBondInfo };
