/**
 * slasher.js — Calls ArcIDBond.slash() on-chain when the adjudicator returns a breach verdict.
 *
 * In DEV_MODE=true: logs the slash without sending an on-chain tx (no RPC needed locally).
 * In production:    sends a real tx to Arc testnet.
 */

const { ethers } = require("ethers");
const config     = require("./config");

// Human-readable ABI — ethers v6 parses these directly
const BOND_ABI = [
  "function slash(address agent, address consumer, string calldata reason) external",
  "function isActiveBondedAgent(address agent) external view returns (bool)",
  "function bonds(address) external view returns (uint256 amount, uint64 postedAt, bool slashed)",
];

function getBondContract(signerOrProvider) {
  return new ethers.Contract(config.BOND_CONTRACT_ADDRESS, BOND_ABI, signerOrProvider);
}

/**
 * Execute a slash on-chain (or simulate in dev mode).
 *
 * @param {string} agentAddress    Oracle provider wallet to slash
 * @param {string} consumerAddress Consumer wallet that receives the bond
 * @param {string} reason          LLM-authored rationale (written to AgentSlashed event)
 * @returns {Promise<{txHash: string|null, simulated: boolean}>}
 */
async function executeSlash(agentAddress, consumerAddress, reason) {
  if (config.DEV_MODE) {
    console.log(`  [slash] DEV_MODE — simulated slash`);
    console.log(`  [slash] agent:    ${agentAddress}`);
    console.log(`  [slash] consumer: ${consumerAddress}`);
    console.log(`  [slash] reason:   ${reason.slice(0, 120)}...`);
    return { txHash: null, simulated: true };
  }

  const provider = new ethers.JsonRpcProvider(config.ARC_RPC_URL);
  const signer   = new ethers.Wallet(config.CONSUMER_PRIVATE_KEY, provider);
  const bond     = getBondContract(signer);

  // Confirm there's an active bond to slash before sending the tx
  const isActive = await bond.isActiveBondedAgent(agentAddress);
  if (!isActive) {
    console.warn(`  [slash] WARNING: agent ${agentAddress} has no active bond — skipping slash`);
    return { txHash: null, simulated: false, skipped: true };
  }

  const tx      = await bond.slash(agentAddress, consumerAddress, reason);
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
