"use strict";
/**
 * attest.js — TDX DCAP attestation for the ingestion enclave. Direct port
 * of oracle/src/attest.js's exact pattern (same USE_REAL_PHALA split, same
 * dstack Unix-socket integration, same quote layout) — the ingestion
 * service is deployed the same way the oracle already is: a small Docker
 * container running inside a real Phala TDX CVM.
 *
 * USE_REAL_PHALA=true  → connects to the Phala dstack guest agent over its
 *                        Unix domain socket (@phala/dstack-sdk's
 *                        DstackClient) for a real Intel TDX quote.
 * USE_REAL_PHALA=false → structurally-valid prototype TDX v4 quote,
 *                        self-signed with the ingestor private key (local
 *                        dev only — passes DCAPVerifier's shape checks but
 *                        proves nothing about real hardware).
 */

const { ethers } = require("ethers");
const config     = require("./config");

const QUOTE_SIZE   = 592;
const MRTD_OFFSET  = 0x70;
const RDATA_OFFSET = 0x230;

function buildPrototypeQuote(reportData32, mrtd48) {
  const quote = Buffer.alloc(QUOTE_SIZE, 0);
  quote.writeUInt16LE(4, 0);           // version = 4
  quote.writeUInt16LE(2, 2);           // att_key_type = ECDSA_P256
  quote.writeUInt32LE(0x00000081, 4);  // tee_type = TDX
  mrtd48.copy(quote, MRTD_OFFSET);
  reportData32.copy(quote, RDATA_OFFSET);
  return quote;
}

let dstackClient = null;
function getDstackClient() {
  if (!dstackClient) {
    const { DstackClient } = require("@phala/dstack-sdk");
    dstackClient = new DstackClient();
  }
  return dstackClient;
}

async function getAttestation() {
  const ingestorAddress = config.INGESTOR_WALLET_ADDRESS;

  // report_data = keccak256(ingestor wallet address)
  const reportData32 = Buffer.from(
    ethers.solidityPackedKeccak256(["address"], [ingestorAddress]).slice(2),
    "hex"
  );

  // mrtd = keccak256("arcid-ingestor-v1") zero-padded to 48 bytes — distinct
  // measurement identity from the price-oracle's "arcid-oracle-v2", since
  // this is a genuinely different enclave workload.
  const mrtd48 = Buffer.alloc(48, 0);
  Buffer.from(
    ethers.solidityPackedKeccak256(["string"], ["arcid-ingestor-v1"]).slice(2),
    "hex"
  ).copy(mrtd48, 0, 0, 32);

  const signingKey = new ethers.SigningKey(config.INGESTOR_PRIVATE_KEY);
  const rawSig     = signingKey.sign(ethers.keccak256(reportData32));
  const sig65      = ethers.concat([rawSig.r, rawSig.s, ethers.toBeHex(rawSig.v, 1)]);

  if (config.USE_REAL_PHALA) {
    const client = getDstackClient();
    const { quote } = await client.getQuote(reportData32);
    const quoteHex  = quote.startsWith("0x") ? quote : "0x" + quote;

    const quoteBytes = Buffer.from(quoteHex.slice(2), "hex");
    const realMrtd = quoteBytes.length >= MRTD_OFFSET + 48
      ? "0x" + quoteBytes.subarray(MRTD_OFFSET, MRTD_OFFSET + 48).toString("hex")
      : null;

    return {
      quote:           quoteHex,
      report_data:     "0x" + reportData32.toString("hex"),
      report_data_sig: sig65,
      attested_signer: ingestorAddress,
      mrtd:            realMrtd,
      real_tdx:        true,
    };
  }

  const quote = buildPrototypeQuote(reportData32, mrtd48);
  return {
    quote:           "0x" + quote.toString("hex"),
    report_data:     "0x" + reportData32.toString("hex"),
    report_data_sig: sig65,
    attested_signer: ingestorAddress,
    mrtd:            "0x" + mrtd48.toString("hex"),
    real_tdx:        false,
  };
}

module.exports = { getAttestation };
