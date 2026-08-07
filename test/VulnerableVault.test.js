/**
 * VulnerableVault.test.js — Proof-of-Exploit demo fixtures
 *
 * Covers: VulnerableVault's basic deposit/withdraw mechanics, the
 * ReentrancyAttacker exploit draining VulnerableVault beyond its own
 * deposit, and the negative control (the same exploit against
 * VulnerableVaultFixed draining nothing beyond its own deposit) — proving
 * the vulnerability (and the harness's invariant check built on top of it
 * in bounty/harness.js) isn't hardcoded to always report a breach.
 *
 * Run: npx hardhat test
 */

const { expect } = require("chai");
const { ethers }  = require("hardhat");

const ONE_ETH = ethers.parseEther("1.0");

describe("VulnerableVault / VulnerableVaultFixed / ReentrancyAttacker", function () {
  let deployer, victim1, victim2, victim3, other;

  beforeEach(async function () {
    [deployer, victim1, victim2, victim3, other] = await ethers.getSigners();
  });

  // ---------------------------------------------------------------------------
  // Basic deposit/withdraw mechanics — same for both vault variants
  // ---------------------------------------------------------------------------

  for (const contractName of ["VulnerableVault", "VulnerableVaultFixed"]) {
    describe(`${contractName} — basic mechanics`, function () {
      let vault;

      beforeEach(async function () {
        const Vault = await ethers.getContractFactory(contractName);
        vault = await Vault.deploy();
      });

      it("accepts a deposit and tracks the sender's balance", async function () {
        await vault.connect(victim1).deposit({ value: ONE_ETH });
        expect(await vault.balances(victim1.address)).to.equal(ONE_ETH);
        expect(await vault.totalBalance()).to.equal(ONE_ETH);
      });

      it("accumulates multiple deposits from the same sender", async function () {
        await vault.connect(victim1).deposit({ value: ONE_ETH });
        await vault.connect(victim1).deposit({ value: ONE_ETH });
        expect(await vault.balances(victim1.address)).to.equal(ONE_ETH * 2n);
      });

      it("lets a depositor withdraw their own balance", async function () {
        await vault.connect(victim1).deposit({ value: ONE_ETH });
        const before = await ethers.provider.getBalance(victim1.address);

        const tx = await vault.connect(victim1).withdraw();
        const receipt = await tx.wait();
        const gasCost = receipt.gasUsed * receipt.gasPrice;

        const after = await ethers.provider.getBalance(victim1.address);
        expect(after).to.equal(before + ONE_ETH - gasCost);
        expect(await vault.balances(victim1.address)).to.equal(0n);
      });

      it("reverts withdraw() for an account with no balance", async function () {
        await expect(vault.connect(other).withdraw()).to.be.revertedWith("no balance");
      });

      it("reverts a second withdraw() after balance is already zeroed", async function () {
        await vault.connect(victim1).deposit({ value: ONE_ETH });
        await vault.connect(victim1).withdraw();
        await expect(vault.connect(victim1).withdraw()).to.be.revertedWith("no balance");
      });
    });
  }

  // ---------------------------------------------------------------------------
  // The exploit itself
  // ---------------------------------------------------------------------------

  describe("ReentrancyAttacker vs. VulnerableVault", function () {
    let vault, attacker;

    beforeEach(async function () {
      const Vault = await ethers.getContractFactory("VulnerableVault");
      vault = await Vault.deploy();

      for (const victim of [victim1, victim2, victim3]) {
        await vault.connect(victim).deposit({ value: ONE_ETH });
      }

      const Attacker = await ethers.getContractFactory("ReentrancyAttacker");
      attacker = await Attacker.deploy(await vault.getAddress());
    });

    it("drains the vault beyond the attacker's own deposit", async function () {
      await attacker.connect(deployer).attack({ value: ONE_ETH });

      const attackerBalance = await ethers.provider.getBalance(await attacker.getAddress());
      expect(attackerBalance).to.be.gt(ONE_ETH);
      // 3 victims + attacker's own deposit = 4 ETH total available to drain.
      expect(attackerBalance).to.equal(ONE_ETH * 4n);
    });

    it("leaves the vault empty after a full drain", async function () {
      await attacker.connect(deployer).attack({ value: ONE_ETH });
      expect(await vault.totalBalance()).to.equal(0n);
    });

    it("leaves victims unable to withdraw their now-drained deposits", async function () {
      await attacker.connect(deployer).attack({ value: ONE_ETH });
      // Victim's tracked balance still shows 1 ETH (never zeroed — that's
      // the bug) but the vault has no ETH left to actually pay it out.
      expect(await vault.balances(victim1.address)).to.equal(ONE_ETH);
      await expect(vault.connect(victim1).withdraw()).to.be.reverted;
    });

    it("stops reentering once the vault can no longer cover one more withdrawal, without reverting the whole attack", async function () {
      // Regression test for the exact bug found while building the spike
      // this was ported from: a naive fixed-iteration-count reentry
      // attempts a withdrawal the vault can't pay, which reverts every
      // nested vault.withdraw() frame's require(ok, ...) on the way back
      // out and erases the entire attack. If that regressed, this attack
      // call would revert instead of succeeding.
      await expect(attacker.connect(deployer).attack({ value: ONE_ETH })).to.not.be.reverted;
      expect(await attacker.reentryCount()).to.equal(3n); // one per victim
    });
  });

  describe("ReentrancyAttacker vs. VulnerableVaultFixed (negative control)", function () {
    let vault, attacker;

    beforeEach(async function () {
      const Vault = await ethers.getContractFactory("VulnerableVaultFixed");
      vault = await Vault.deploy();

      for (const victim of [victim1, victim2, victim3]) {
        await vault.connect(victim).deposit({ value: ONE_ETH });
      }

      const Attacker = await ethers.getContractFactory("ReentrancyAttacker");
      attacker = await Attacker.deploy(await vault.getAddress());
    });

    it("the same exploit contract gets back only its own deposit, nothing more", async function () {
      await attacker.connect(deployer).attack({ value: ONE_ETH });
      const attackerBalance = await ethers.provider.getBalance(await attacker.getAddress());
      expect(attackerBalance).to.equal(ONE_ETH);
    });

    it("never attempts a reentrant withdraw against the fixed vault", async function () {
      await attacker.connect(deployer).attack({ value: ONE_ETH });
      // Balance is zeroed before the external call on the fixed vault, so
      // receive()'s owed > 0 check is false on the first (only) callback —
      // reentryCount should stay at 0.
      expect(await attacker.reentryCount()).to.equal(0n);
    });

    it("leaves victims' deposits fully intact and withdrawable", async function () {
      await attacker.connect(deployer).attack({ value: ONE_ETH });
      expect(await vault.totalBalance()).to.equal(ONE_ETH * 3n); // 3 victims, untouched
      await expect(vault.connect(victim1).withdraw()).to.not.be.reverted;
    });
  });
});
