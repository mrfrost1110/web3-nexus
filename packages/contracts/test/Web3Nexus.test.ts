/**
 * Test suite for Web3Nexus.
 *
 * Covers the contract's four safety mechanisms rather than its happy path alone: the
 * anti-whale cap, the lockup tiers, the withdrawal cooldown, and the supply ceiling. Each
 * is asserted from the direction that matters — that the guard actually rejects the case
 * it exists to reject, and that the legitimate path still succeeds once the condition
 * clears.
 *
 * Run with `bun contracts:test` from the repository root.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { Web3Nexus } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Web3Nexus Contract - High Security & Multipliers", function () {
  let web3Nexus: Web3Nexus;
  let owner: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  // Deliberately lower than the deploy script's rate. The exact value is irrelevant to
  // these assertions, which test guards rather than reward amounts.
  const INITIAL_REWARD_RATE = ethers.parseEther("10");

  // A fresh deployment per test. Stakes, cooldowns, and supply all accumulate in contract
  // storage, so sharing an instance across tests would let one test's state change another's
  // outcome.
  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    const Web3NexusFactory = await ethers.getContractFactory("Web3Nexus");
    web3Nexus = (await Web3NexusFactory.deploy(INITIAL_REWARD_RATE)) as Web3Nexus;
    await web3Nexus.waitForDeployment();
  });

  /**
   * The cap is defined over an account's cumulative open stake, not per transaction. Both
   * cases below matter: the second is the one that would pass if the check were written
   * against `msg.value` alone.
   */
  describe("Anti-Whale Protections", function () {
    it("Should reject single address staking exceeding 50 ETH limit", async function () {
      const hugeAmount = ethers.parseEther("51.0");
      await expect(
        web3Nexus.connect(user1).stake(0, { value: hugeAmount })
      ).to.be.revertedWith("Exceeds anti-whale limit (50 ETH)");
    });

    it("Should reject multi-stake cumulative entries exceeding 50 ETH", async function () {
      // Two deposits, each individually under the cap, together over it.
      await web3Nexus.connect(user1).stake(0, { value: ethers.parseEther("30.0") });
      await expect(
        web3Nexus.connect(user1).stake(0, { value: ethers.parseEther("21.0") })
      ).to.be.revertedWith("Exceeds anti-whale limit (50 ETH)");
    });
  });

  /**
   * Verifies that the tier index maps to the intended duration and multiplier, and that
   * the lockup is enforced on withdrawal in both directions — blocked while running,
   * permitted once expired.
   */
  describe("Lockup Multipliers", function () {
    it("Should allow staking with multipliers (No Lock = 1x, 7D = 1.5x, 30D = 2.5x)", async function () {
      const amount = ethers.parseEther("1.0");

      // Stake 1: No Lock
      await web3Nexus.connect(user1).stake(0, { value: amount });
      let s1 = await web3Nexus.userStakes(user1.address, 0);
      expect(s1.lockupDuration).to.equal(0n);
      expect(s1.multiplier).to.equal(10000n); // 1.0x

      // Stake 2: 7 Days Lock
      await web3Nexus.connect(user1).stake(1, { value: amount });
      let s2 = await web3Nexus.userStakes(user1.address, 1);
      expect(s2.lockupDuration).to.equal(7n * 24n * 3600n);
      expect(s2.multiplier).to.equal(15000n); // 1.5x

      // Stake 3: 30 Days Lock
      await web3Nexus.connect(user1).stake(2, { value: amount });
      let s3 = await web3Nexus.userStakes(user1.address, 2);
      expect(s3.lockupDuration).to.equal(30n * 24n * 3600n);
      expect(s3.multiplier).to.equal(25000n); // 2.5x
    });

    it("Should block withdrawal requests of locked stakes before duration expires", async function () {
      const amount = ethers.parseEther("1.0");
      // Stake 7 days lock
      await web3Nexus.connect(user1).stake(1, { value: amount });

      // Immediate withdrawal request should fail
      await expect(
        web3Nexus.connect(user1).requestWithdrawal(0)
      ).to.be.revertedWith("Stake is still locked under lockup timeline");
    });

    it("Should allow withdrawal request once lockup expires", async function () {
      const amount = ethers.parseEther("1.0");
      await web3Nexus.connect(user1).stake(1, { value: amount });

      // `evm_increaseTime` shifts the chain clock; `evm_mine` is required afterwards
      // because the new timestamp only takes effect on the next mined block. Without the
      // mine, the contract would still read the old `block.timestamp`.
      await ethers.provider.send("evm_increaseTime", [7 * 24 * 3600 + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(web3Nexus.connect(user1).requestWithdrawal(0)).to.emit(
        web3Nexus,
        "WithdrawalRequested"
      );
    });
  });

  /**
   * The cooldown is the anti-flash-loan guard, so the assertion that matters is that the
   * payout is unavailable in the same block the request was made.
   */
  describe("Withdrawal Cooldown Lock", function () {
    it("Should block immediate withdrawal payout after requesting unstaking", async function () {
      const amount = ethers.parseEther("1.0");
      // Tier 0 (no lockup), so only the cooldown — not the lockup — can block the payout.
      await web3Nexus.connect(user1).stake(0, { value: amount });

      await web3Nexus.connect(user1).requestWithdrawal(0);

      await expect(
        web3Nexus.connect(user1).completeWithdrawal(0)
      ).to.be.revertedWith("Cooldown lock is still active");
    });

    it("Should allow withdrawal payout after cooldown period expires", async function () {
      const amount = ethers.parseEther("1.0");
      await web3Nexus.connect(user1).stake(0, { value: amount });

      // Balance is sampled after staking, so `amount` has already left the account. A
      // correct round trip therefore returns the balance to this baseline plus the
      // principal, minus gas.
      const initialEthBalance = await ethers.provider.getBalance(user1.address);

      // Gas from both transactions is tracked explicitly, since the user pays it out of
      // the same balance being asserted on.
      const txReq = await web3Nexus.connect(user1).requestWithdrawal(0);
      const recReq = await txReq.wait();
      const gasReq = recReq ? recReq.gasUsed * recReq.gasPrice : 0n;

      await ethers.provider.send("evm_increaseTime", [60]);
      await ethers.provider.send("evm_mine", []);

      const txComp = await web3Nexus.connect(user1).completeWithdrawal(0);
      const recComp = await txComp.wait();
      const gasComp = recComp ? recComp.gasUsed * recComp.gasPrice : 0n;

      const finalEthBalance = await ethers.provider.getBalance(user1.address);

      // `closeTo` rather than an exact match: base fee varies per block, so the gas figures
      // above are close but not exact. The 0.01 ETH tolerance is far below the 1 ETH
      // principal, so a failed refund would still fail this assertion.
      expect(finalEthBalance).to.be.closeTo(
        initialEthBalance + amount - gasReq - gasComp,
        ethers.parseEther("0.01")
      );
    });
  });

  /**
   * `adminMint` is the only path that can mint NEX without staking, so it is where the
   * supply ceiling has to hold.
   */
  describe("Inflation Protections & Admin limits", function () {
    it("Should enforce hard token supply ceiling on minting", async function () {
      // 101 million against a 100 million cap — over the ceiling on its own, before the
      // constructor's 1 million bootstrap supply is counted.
      const exceedAmount = ethers.parseEther("101000000");
      await expect(
        web3Nexus.connect(owner).adminMint(user1.address, exceedAmount)
      ).to.be.revertedWith("Ecosystem Max Inflation Cap reached!");
    });
  });
});
