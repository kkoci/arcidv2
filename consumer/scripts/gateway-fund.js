"use strict";
/**
 * gateway-fund.js — Check the consumer wallet's raw USDC + Circle Gateway
 * balance, and optionally deposit into the Gateway Wallet contract.
 *
 * Real Gateway payments (settlement.js and oracle.js's fetchViaGateway(),
 * both DEV_MODE=false) draw from the Gateway "available" balance, NOT the
 * raw wallet USDC balance — deposit() moves funds from one to the other.
 * Neither payment path auto-deposits (see oracle.js/settlement.js's own
 * comments) so this is the manual pre-flight step before running the
 * consumer loop with DEV_MODE=false for real.
 *
 * Reads CONSUMER_PRIVATE_KEY from consumer/.env only — never a CLI arg
 * (see CLAUDE.md's private-key rule).
 *
 * Usage (from consumer/):
 *   npm run gateway:status
 *   npm run gateway:fund -- --amount 1
 */

const config = require("../src/config");

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

async function main() {
  const { GatewayClient } = require("@circle-fin/x402-batching/client");
  const client = new GatewayClient({ chain: "arcTestnet", privateKey: config.CONSUMER_PRIVATE_KEY });

  const balances = await client.getBalances();
  console.log(`Consumer wallet: ${config.CONSUMER_WALLET_ADDRESS}`);
  console.log(`  Raw USDC balance:      ${balances.wallet.formatted} USDC`);
  console.log(`  Gateway available:     ${balances.gateway.formattedAvailable} USDC`);
  console.log(`  Gateway withdrawing:   ${balances.gateway.formattedWithdrawing} USDC`);

  const amount = argValue(process.argv.slice(2), "--amount");
  if (!amount) {
    console.log(`\nEach real Gateway call costs $${config.PRICE_USDC} USDC. Two real calls happen per clean` +
      ` cycle (oracle fetch + settlement) once both consumer/.env and oracle/.env are DEV_MODE=false.`);
    console.log(`\nTo deposit into the Gateway Wallet: npm run gateway:fund -- --amount <usdc>`);
    return;
  }

  console.log(`\nDepositing ${amount} USDC into the Gateway Wallet...`);
  const result = await client.deposit(amount);
  if (result.approvalTxHash) console.log(`  Approval tx: ${result.approvalTxHash}`);
  console.log(`  Deposit tx:  ${result.depositTxHash}`);

  const after = await client.getBalances();
  console.log(`\nGateway available balance is now: ${after.gateway.formattedAvailable} USDC`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
