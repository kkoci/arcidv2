"use strict";
/**
 * settle.js — the settlement handoff, extracted so both the CLI
 * (scripts/cli/demo-acquisition.js) and the live HTTP endpoint
 * (acquisition/server.js) share one implementation instead of two
 * copies drifting. This is the exact same TrainingPool -> ingestion
 * enclave -> CompensationClaim sequence Phases 1-7 already built and
 * proved — nothing new here, only reused.
 *
 * Deliberately blockchain-aware (unlike agent.js, which stays pure) —
 * this module's whole job IS the on-chain handoff.
 */

const { buildTree } = require("../../ingestor/src/merkle");
const { corpusLeaf } = require("../../ingestor/src/allocator");

/**
 * @param {object} p
 * @param {object[]} p.selected                    selected catalog tracks [{id, artistKey, ...}]
 * @param {Record<string,string>} p.fpByTrackId     trackId -> fingerprintHash (already committed on-chain)
 * @param {number} p.pricePerTrack                  whole-USDC flat price per track
 * @param {import("ethers").Wallet} p.company        funded wallet that creates the pool
 * @param {import("ethers").Wallet} p.ingestor       TEE-registered wallet that submits the allocation
 * @param {Record<string, import("ethers").Wallet>} p.artistWalletByKey  artistKey -> wallet
 * @param {import("ethers").Contract} p.usdc
 * @param {import("ethers").Contract} p.pool         TrainingPool
 * @param {import("ethers").Contract} p.claimContract CompensationClaim
 * @param {string} p.ingestorUrl
 * @param {(event:string, data:object) => void} [p.onStep] optional progress callback
 * @returns {Promise<{poolId:string, poolAmountUsdc:number, corpusRoot:string, allocationRoot:string, submitAllocationTx:string, claims:object[]}>}
 */
async function settleSelection({
  selected, fpByTrackId, pricePerTrack, company, ingestor, artistWalletByKey,
  usdc, pool, claimContract, ingestorUrl, onStep = () => {},
}) {
  if (!selected || selected.length === 0) throw new Error("settleSelection: nothing selected");

  const selectedFps = selected.map((t) => fpByTrackId[t.id]);
  const { root: corpusRoot } = buildTree(selectedFps.map(corpusLeaf));
  const totalCost = Math.round(selected.length * pricePerTrack * 100) / 100;
  const poolAmount = BigInt(Math.round(totalCost * 1e6));

  const provider = company.provider;
  let companyNonce = await provider.getTransactionCount(company.address, "pending");

  onStep("funding_pool", { poolAmountUsdc: totalCost });
  const poolAddress = await pool.getAddress();
  await (await usdc.connect(company).approve(poolAddress, poolAmount, { nonce: companyNonce++ })).wait();
  const poolId = await pool.nextPoolId();
  await (await pool.connect(company).createPool(corpusRoot, poolAmount, { nonce: companyNonce++ })).wait();
  onStep("pool_created", { poolId: poolId.toString(), corpusRoot });

  onStep("ingesting", { poolId: poolId.toString() });
  const r = await fetch(`${ingestorUrl}/api/ingest`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ poolId: poolId.toString(), corpus: selectedFps }),
  });
  const ingestResp = await r.json();
  if (!r.ok) throw new Error(ingestResp.error || `ingest HTTP ${r.status}`);
  onStep("ingested", { allocationRoot: ingestResp.allocationRoot });

  const submitTx = await claimContract.connect(ingestor).submitAllocation(poolId, ingestResp.allocationRoot);
  const submitReceipt = await submitTx.wait();
  onStep("allocation_submitted", { tx: submitReceipt.hash });

  const claims = [];
  for (const a of ingestResp.allocations) {
    const entry = Object.entries(artistWalletByKey).find(
      ([, w]) => w.address.toLowerCase() === a.artist.toLowerCase()
    );
    if (!entry) continue;
    const [artistKey, wallet] = entry;
    const tx = await claimContract.connect(wallet).claim(poolId, BigInt(a.amount), a.proof);
    const receipt = await tx.wait();
    const amountUsdc = Number(a.amount) / 1e6;
    claims.push({ artistKey, address: wallet.address, amountUsdc, tx: receipt.hash });
    onStep("artist_claimed", { artistKey, amountUsdc, tx: receipt.hash });
  }

  return {
    poolId: poolId.toString(),
    poolAmountUsdc: totalCost,
    corpusRoot,
    allocationRoot: ingestResp.allocationRoot,
    submitAllocationTx: submitReceipt.hash,
    claims,
  };
}

module.exports = { settleSelection };
