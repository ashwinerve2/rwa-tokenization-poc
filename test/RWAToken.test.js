const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

/**
 * Test suite for the RWA tokenization proof of concept.
 * Every test name starts with the requirement ID it checks (FR-, NFR-, DR-)
 * so the results can be traced back to Tables 1.1 - 1.3 in the thesis.
 *
 * Run:  npx hardhat test
 */

const REASON = {
  notKyc: "RWAToken: account not KYC-whitelisted",
  senderNo: "RWAToken: sender not whitelisted",
  recipientNo: "RWAToken: recipient not whitelisted",
  stale: "RWAToken: oracle price stale",
  badPrice: "RWAToken: oracle price out of valid range",
  noBalance: "RWAToken: insufficient balance",
  notContract: "RWAToken: oracle must be a contract",
};

describe("RWA tokenization PoC", function () {
  let admin, alice, bob, outsider, issuerOnly, complianceOnly;
  let oracle, token;

  const unauth = (who, role) => [who.address, role];

  beforeEach(async function () {
    [admin, alice, bob, outsider, issuerOnly, complianceOnly] = await ethers.getSigners();

    oracle = await (await ethers.getContractFactory("MockOracle")).deploy(100, admin.address);
    await oracle.waitForDeployment();

    token = await (await ethers.getContractFactory("RWAToken")).deploy(
      "Tokenized Property Share", "TPS", await oracle.getAddress(), admin.address
    );
    await token.waitForDeployment();

    await token.setWhitelist(alice.address, true);
    await token.setWhitelist(bob.address, true);
  });

  async function useFaultyOracle(price, timestamp) {
    const f = await (await ethers.getContractFactory("FaultyOracle")).deploy();
    await f.waitForDeployment();
    await f.set(price, timestamp);
    await token.setOracle(await f.getAddress());
    return f;
  }

  async function splitRoles() {
    await token.grantRole(await token.ISSUER_ROLE(), issuerOnly.address);
    await token.grantRole(await token.COMPLIANCE_ROLE(), complianceOnly.address);
  }

  // ---------------------------------------------------------------- SC01
  describe("Access control (OWASP SC01)", function () {
    it("FR-1 rejects issuance by an account without ISSUER_ROLE", async function () {
      await expect(token.connect(alice).issue(alice.address, 100))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(...unauth(alice, await token.ISSUER_ROLE()));
    });

    it("FR-1 lets the issuer mint to a whitelisted address", async function () {
      await token.issue(alice.address, 1000);
      expect(await token.balanceOf(alice.address)).to.equal(1000);
    });

    it("FR-1 rejects forced burn by an account without ISSUER_ROLE", async function () {
      await token.issue(alice.address, 100);
      await expect(token.connect(alice).burnFrom(alice.address, 10))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });

    it("NFR-2 rejects whitelist changes without COMPLIANCE_ROLE", async function () {
      await expect(token.connect(alice).setWhitelist(outsider.address, true))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(...unauth(alice, await token.COMPLIANCE_ROLE()));
    });

    it("FR-5 only the admin can pause", async function () {
      await expect(token.connect(alice).pause())
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(...unauth(alice, await token.DEFAULT_ADMIN_ROLE()));
    });

    it("NFR-2 role separation: issuer-only account cannot whitelist, pause or change the oracle", async function () {
      await splitRoles();
      const t = token.connect(issuerOnly);
      await expect(t.setWhitelist(outsider.address, true)).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await expect(t.pause()).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await expect(t.setOracle(await oracle.getAddress())).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });

    it("NFR-2 role separation: compliance-only account cannot issue, burn or pause", async function () {
      await splitRoles();
      const t = token.connect(complianceOnly);
      await expect(t.issue(alice.address, 1)).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await expect(t.burnFrom(alice.address, 1)).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await expect(t.pause()).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });

    it("NFR-2 role separation: each single role can do its own job", async function () {
      await splitRoles();
      await token.connect(issuerOnly).issue(alice.address, 5);
      await token.connect(complianceOnly).setWhitelist(outsider.address, true);
      expect(await token.balanceOf(alice.address)).to.equal(5);
      expect(await token.isWhitelisted(outsider.address)).to.equal(true);
    });

    it("FR-3 only the admin can change the oracle", async function () {
      const o2 = await (await ethers.getContractFactory("MockOracle")).deploy(200, admin.address);
      await expect(token.connect(alice).setOracle(await o2.getAddress()))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });
  });

  // ------------------------------------------------- Domain: KYC / AML
  describe("KYC whitelist and AML controls (domain requirements)", function () {
    it("DR-1 rejects issuance to a non-whitelisted address", async function () {
      await expect(token.issue(outsider.address, 100)).to.be.revertedWith(REASON.notKyc);
    });

    it("FR-2 rejects a transfer to a non-whitelisted address", async function () {
      await token.issue(alice.address, 1000);
      await expect(token.connect(alice).transfer(outsider.address, 100)).to.be.revertedWith(REASON.recipientNo);
    });

    it("FR-2 allows a transfer between two whitelisted addresses", async function () {
      await token.issue(alice.address, 1000);
      await token.connect(alice).transfer(bob.address, 200);
      expect(await token.balanceOf(bob.address)).to.equal(200);
    });

    it("DR-2 a removed address cannot send", async function () {
      await token.issue(alice.address, 100);
      await token.setWhitelist(alice.address, false);
      await expect(token.connect(alice).transfer(bob.address, 10)).to.be.revertedWith(REASON.senderNo);
    });

    it("DR-2 a removed address cannot receive or redeem, and its balance stays recorded", async function () {
      await token.issue(alice.address, 100);
      await token.issue(bob.address, 100);
      await token.setWhitelist(alice.address, false);
      await expect(token.connect(bob).transfer(alice.address, 1)).to.be.revertedWith(REASON.recipientNo);
      await expect(token.connect(alice).redeem(1)).to.be.revertedWith(REASON.notKyc);
      expect(await token.balanceOf(alice.address)).to.equal(100);
    });

    it("DR-2 limitation: a frozen balance cannot be force-burned until the address is re-whitelisted", async function () {
      await token.issue(alice.address, 100);
      await token.setWhitelist(alice.address, false);
      await expect(token.burnFrom(alice.address, 100)).to.be.revertedWith(REASON.senderNo);
      await token.setWhitelist(alice.address, true);
      await token.burnFrom(alice.address, 100);
      expect(await token.balanceOf(alice.address)).to.equal(0);
    });

    it("DR-1 a non-whitelisted address cannot redeem", async function () {
      await expect(token.connect(outsider).redeem(1)).to.be.revertedWith(REASON.notKyc);
    });
  });

  // ---------------------------------------------------------------- SC03
  describe("Oracle data quality (OWASP SC03)", function () {
    it("FR-3 rejects redemption when the price is older than one hour", async function () {
      await token.issue(alice.address, 1000);
      await ethers.provider.send("evm_increaseTime", [3700]);
      await ethers.provider.send("evm_mine");
      await expect(token.connect(alice).redeem(100)).to.be.revertedWith(REASON.stale);
    });

    it("FR-3 allows redemption when the price is fresh", async function () {
      await token.issue(alice.address, 1000);
      await expect(token.connect(alice).redeem(100)).to.emit(token, "AssetRedeemed");
    });

    it("FR-3 rejects a zero price", async function () {
      await token.issue(alice.address, 100);
      await useFaultyOracle(0, (await ethers.provider.getBlock("latest")).timestamp);
      await expect(token.connect(alice).redeem(10)).to.be.revertedWith(REASON.badPrice);
    });

    it("FR-3 rejects a negative price", async function () {
      await token.issue(alice.address, 100);
      await useFaultyOracle(-5, (await ethers.provider.getBlock("latest")).timestamp);
      await expect(token.connect(alice).redeem(10)).to.be.revertedWith(REASON.badPrice);
    });

    it("FR-3 fails closed when the oracle timestamp is in the future", async function () {
      await token.issue(alice.address, 100);
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      await useFaultyOracle(100, now + 86400);
      await expect(token.connect(alice).redeem(10)).to.be.revertedWithPanic(0x11);
    });

    it("FR-3 rejects an oracle address that is not a contract (SC06)", async function () {
      await expect(token.setOracle(outsider.address)).to.be.revertedWith(REASON.notContract);
      const F = await ethers.getContractFactory("RWAToken");
      await expect(F.deploy("X", "X", outsider.address, admin.address)).to.be.revertedWith(REASON.notContract);
    });
  });

  // -------------------------------------------------- Redemption logic
  describe("Redemption", function () {
    it("FR-3 redeem burns exactly the requested amount", async function () {
      await token.issue(alice.address, 1000);
      await token.connect(alice).redeem(300);
      expect(await token.balanceOf(alice.address)).to.equal(700);
      expect(await token.totalSupply()).to.equal(700);
    });

    it("FR-3 redeem rejects above the balance", async function () {
      await token.issue(alice.address, 100);
      await expect(token.connect(alice).redeem(101)).to.be.revertedWith(REASON.noBalance);
    });
  });

  // ------------------------------------------------------- Audit trail
  describe("Auditability (events)", function () {
    it("FR-4 emits TokensIssued with recipient, amount and actor", async function () {
      await expect(token.issue(alice.address, 250))
        .to.emit(token, "TokensIssued").withArgs(alice.address, 250, admin.address);
    });

    it("FR-4 emits TokensForceBurned with holder, amount and actor", async function () {
      await token.issue(alice.address, 100);
      await expect(token.burnFrom(alice.address, 40))
        .to.emit(token, "TokensForceBurned").withArgs(alice.address, 40, admin.address);
      expect(await token.balanceOf(alice.address)).to.equal(60);
    });

    it("FR-4 emits Whitelisted with account, status and actor", async function () {
      await expect(token.setWhitelist(outsider.address, true))
        .to.emit(token, "Whitelisted").withArgs(outsider.address, true, admin.address);
    });

    it("FR-4 emits AssetRedeemed with the price used", async function () {
      await token.issue(alice.address, 1000);
      await expect(token.connect(alice).redeem(50))
        .to.emit(token, "AssetRedeemed").withArgs(alice.address, 50, 100, anyValue);
    });

    it("FR-4 emits OracleUpdated with the new oracle and the actor", async function () {
      const o2 = await (await ethers.getContractFactory("MockOracle")).deploy(200, admin.address);
      await expect(token.setOracle(await o2.getAddress()))
        .to.emit(token, "OracleUpdated").withArgs(await o2.getAddress(), admin.address);
    });

    it("FR-4 pause emits the OpenZeppelin Paused event naming the actor", async function () {
      await expect(token.pause()).to.emit(token, "Paused").withArgs(admin.address);
    });
  });

  // ------------------------------------------------------ Emergency stop
  describe("Emergency stop", function () {
    it("FR-5 pause blocks issuance", async function () {
      await token.pause();
      await expect(token.issue(alice.address, 100)).to.be.revertedWithCustomError(token, "EnforcedPause");
    });

    it("FR-5 pause blocks transfer, burn and redeem; unpause restores service", async function () {
      await token.issue(alice.address, 100);
      await token.pause();
      await expect(token.connect(alice).transfer(bob.address, 1)).to.be.revertedWithCustomError(token, "EnforcedPause");
      await expect(token.burnFrom(alice.address, 1)).to.be.revertedWithCustomError(token, "EnforcedPause");
      await expect(token.connect(alice).redeem(1)).to.be.revertedWithCustomError(token, "EnforcedPause");
      await token.unpause();
      await token.connect(alice).transfer(bob.address, 1);
      expect(await token.balanceOf(bob.address)).to.equal(1);
    });
  });

  // ------------------------------------------------ Reentrancy, SC08
  describe("Reentrancy (OWASP SC08)", function () {
    it("NFR-1 BEFORE: the attack drains the deliberately vulnerable contract", async function () {
      const [, victim] = await ethers.getSigners();
      const vulnerable = await (await ethers.getContractFactory("VulnerableRWAToken")).deploy();
      await vulnerable.waitForDeployment();
      await vulnerable.connect(victim).deposit({ value: ethers.parseEther("5") });

      const attacker = await (await ethers.getContractFactory("ReentrancyAttacker")).deploy(await vulnerable.getAddress());
      await attacker.waitForDeployment();

      const before = await ethers.provider.getBalance(await vulnerable.getAddress());
      await attacker.attack({ value: ethers.parseEther("1") });
      const after = await ethers.provider.getBalance(await vulnerable.getAddress());
      expect(before - after).to.be.greaterThan(ethers.parseEther("1"));
      // The attacker put in 1 ETH and the whole pool (the victim's 5 ETH) is gone.
      expect(after).to.equal(0n);
      console.log("      pool before: " + ethers.formatEther(before) + " ETH, after: " + ethers.formatEther(after) +
        " ETH, attacker contract holds: " + ethers.formatEther(await ethers.provider.getBalance(await attacker.getAddress())) + " ETH");
    });

    it("NFR-1 AFTER: redeem() burns first, makes no external call after it, and completes atomically", async function () {
      await token.issue(alice.address, 1000);
      await expect(token.connect(alice).redeem(500)).to.emit(token, "AssetRedeemed");
      expect(await token.balanceOf(alice.address)).to.equal(500);
    });
  });

  // ------------------------------------- Static source checks, SC06/SC09
  describe("Source-level guarantees (SC06, SC09)", function () {
    const dir = path.join(__dirname, "..", "contracts");
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const read = (f) => strip(fs.readFileSync(path.join(dir, f), "utf8"));

    it("NFR-3 SC09: RWAToken and MockOracle never use `unchecked`", function () {
      expect(read("RWAToken.sol")).to.not.match(/\bunchecked\b/);
      expect(read("MockOracle.sol")).to.not.match(/\bunchecked\b/);
    });

    it("NFR-3 SC09 positive control: the vulnerable demo does use `unchecked` (so the check can fail)", function () {
      expect(read("VulnerableRWAToken.sol")).to.match(/\bunchecked\b/);
    });

    it("NFR-4 SC06: RWAToken makes no low-level calls (call, delegatecall, staticcall, send)", function () {
      expect(read("RWAToken.sol")).to.not.match(/\.(call|delegatecall|staticcall|send)\s*[({]/);
    });

    it("NFR-4 SC06 positive control: the vulnerable demo does use a low-level call", function () {
      expect(read("VulnerableRWAToken.sol")).to.match(/\.call\s*\{/);
    });
  });
});
