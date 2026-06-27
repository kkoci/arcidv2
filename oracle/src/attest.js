"use strict";
/**
 * attest.js — TDX DCAP attestation for the oracle service.
 *
 * USE_REAL_PHALA=true  → calls the Phala dstack agent at PHALA_ENDPOINT/attestation/quote
 *                        for a real Intel TDX quote from the running CVM.
 * USE_REAL_PHALA=false → builds a structurally-valid prototype TDX v4 quote self-signed
 *                        with the oracle private key (safe for local dev; passes DCAPVerifier).
 *
 * Quote format (TDX DCAP v4, 592 bytes minimum):
 *   [0x00] uint16 version      = 4
 *   [0x02] uint16 att_key_type = 2  (ECDSA P-256)
 *   [0x04] uint32 tee_type     = 0x00000081  (TDX)
 *   [0x70] bytes48 mrtd        (48 bytes, non-zero)
 *   [0x230] bytes32 report_data (first 32 of 64-byte field)
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

async function getAttestation() {
  const oracleAddress = config.ORACLE_WALLET_ADDRESS;

  // report_data = keccak256(oracle wallet address)
  const reportData32 = Buffer.from(
    ethers.solidityPackedKeccak256(["address"], [oracleAddress]).slice(2),
    "hex"
  );

  // mrtd = keccak256("arcid-oracle-v2") zero-padded to 48 bytes
  const mrtd48 = Buffer.alloc(48, 0);
  Buffer.from(
    ethers.solidityPackedKeccak256(["string"], ["arcid-oracle-v2"]).slice(2),
    "hex"
  ).copy(mrtd48, 0, 0, 32);

  // Sign report_data with raw ECDSA (no EIP-191) — matches DCAPVerifier._recover()
  const signingKey = new ethers.SigningKey(config.ORACLE_PRIVATE_KEY);
  const rawSig     = signingKey.sign(ethers.keccak256(reportData32));
  const sig65      = ethers.concat([rawSig.r, rawSig.s, ethers.toBeHex(rawSig.v, 1)]);

  if (config.USE_REAL_PHALA) {
    const endpoint = config.PHALA_ENDPOINT;
    const resp = await fetch(`${endpoint}/attestation/quote`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ report_data: "0x" + reportData32.toString("hex") }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.status);
      throw new Error(`Phala dstack returned ${resp.status}: ${text}`);
    }
    const body       = await resp.json();
    const quoteB64   = body.quote ?? body.Quote;
    if (!quoteB64) throw new Error("Phala response missing 'quote' field");
    const quoteHex   = "0x" + Buffer.from(quoteB64, "base64").toString("hex");

    return {
      quote:           quoteHex,
      report_data:     "0x" + reportData32.toString("hex"),
      report_data_sig: sig65,
      attested_signer: oracleAddress,
      mrtd:            "0x" + mrtd48.toString("hex"),
      real_tdx:        true,
    };
  }

  // Prototype path — structurally valid, self-signed
  const quote = buildPrototypeQuote(reportData32, mrtd48);
  return {
    quote:           "0x" + quote.toString("hex"),
    report_data:     "0x" + reportData32.toString("hex"),
    report_data_sig: sig65,
    attested_signer: oracleAddress,
    mrtd:            "0x" + mrtd48.toString("hex"),
    real_tdx:        false,
  };
}

module.exports = { getAttestation };
