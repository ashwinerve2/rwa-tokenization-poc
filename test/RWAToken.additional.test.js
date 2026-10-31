const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

/**
 * Additional tests, added after the first coverage run.
 * They close these gaps:
 *   - MockOracle was only half tested (update and input checks)
 *   - NFR-1 was shown only by behaviour: now the guard and the order of steps
 *     in redeem() are also checked in the source
 *   - FR-5: every operation works again after unpausing; Unpaused event
 *   - FR-3: exact boundary values (price 1, age 3600 s and 3601 s)
 *   - NFR-2: the administrator can grant roles (documented limitation)
 *
 * Run together with the main suite:  npx hardhat test
 */

describe("RWA tokenization PoC: additional checks", function () {
  let admin, alice, bob, outsider, issuerOnly;
  let oracle, token;

  beforeEach(async function () {
    [admin, alice, bob, outsider, issuerOnly] = await ethers.getSigners();

    oracle = await (await ethers.getContractFactory("MockOracle")).deploy(100, admin.address);
    await oracle.waitForDeployment();

    token = await (await ethers.getContractFactory("RWAToken")).deploy(
      "Tokenized Property Share", "TPS", await oracle.getAddress(), admin.address
    );
    await token.waitForDeployment();

    await token.setWhitelist(alice.address, true);
    await token.setWhitelist(bob.address, true);
  });

  async function useFaultyOracle(price, updatedAt) {
    const f = await (await ethers.getContractFactory("FaultyOracle")).deploy();
    await f.waitForDeployment();
    await f.set(price, updatedAt);
    await token.setOracle(await f.getAddress());
  }

  // Sends redeem(10) in a block whose time is exactly T, with an oracle price that is ageSeconds old.
  async function redeemWithPriceAge(ageSeconds) {
    await token.issue(alice.address, 100);
    const latest = (await ethers.provider.getBlock("latest")).timestamp;
    const T = latest + 1000;
    await useFaultyOracle(100, T - ageSeconds);
    await ethers.provider.send("evm_setNextBlockTimestamp", [T]);
    return token.connect(alice).redeem(10);
  }

  // ------------------------------------------------ MockOracle
  describe("MockOracle (price source used in the prototype)", function () {
    it("FR-3 MockOracle: the owner can update the price and an event is emitted", async function () {
      await expect(oracle.updatePrice(250)).to.emit(oracle, "PriceUpdated").withArgs(250, anyValue);
      const [price, updatedAt] = await oracle.latestPrice();
      expect(price).to.equal(250);
      expect(updatedAt).to.equal((await ethers.provider.getBlock("latest")).timestamp);
    });

    it("FR-3 MockOracle: a non-owner cannot update the price", async function () {
      await expect(oracle.connect(alice).updatePrice(5))
        .to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });

    it("FR-3 MockOracle: refuses a zero or negative price when updating", async function () {
      await expect(oracle.updatePrice(0)).to.be.revertedWith("MockOracle: price must be positive");
      await expect(oracle.updatePrice(-1)).to.be.revertedWith("MockOracle: price must be positive");
    });

    it("FR-3 MockOracle: refuses a zero price at deployment", async function () {
      const F = await ethers.getContractFactory("MockOracle");
      await expect(F.deploy(0, admin.address)).to.be.revertedWith("MockOracle: price must be positive");
    });
  });

  // ------------------------------------------------ FR-3 boundaries
  describe("Oracle boundary values", function () {
    it("FR-3 boundary: a price of exactly 1 is accepted", async function () {
      await token.issue(alice.address, 100);
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      await useFaultyOracle(1, now);
      await expect(token.connect(alice).redeem(10))
        .to.emit(token, "AssetRedeemed").withArgs(alice.address, 10, 1, anyValue);
    });

    it("FR-3 boundary: a price exactly 3600 seconds old is accepted", async function () {
      await expect(await redeemWithPriceAge(3600)).to.emit(token, "AssetRedeemed");
    });

    it("FR-3 boundary: a price 3601 seconds old is rejected", async function () {
      await expect(redeemWithPriceAge(3601)).to.be.revertedWith("RWAToken: oracle price stale");
      await ethers.provider.send("evm_mine");
    });
  });

  // ------------------------------------------------ Pause
  describe("Emergency stop: full recovery", function () {
    it("FR-5 after unpausing, issue, burn, transfer and redeem all work again", async function () {
      await token.issue(alice.address, 200);
      await token.pause();
      await token.unpause();
      await token.issue(alice.address, 100);
      await token.burnFrom(alice.address, 10);
      await token.connect(alice).transfer(bob.address, 20);
      await token.connect(alice).redeem(30);
      expect(await token.balanceOf(alice.address)).to.equal(240); // 300 - 10 - 20 - 30
      expect(await token.balanceOf(bob.address)).to.equal(20);
    });

    it("FR-4 unpause emits the OpenZeppelin Unpaused event naming the actor", async function () {
      await token.pause();
      await expect(token.unpause()).to.emit(token, "Unpaused").withArgs(admin.address);
    });
  });

  // ------------------------------------------------ Roles
  describe("Administrator power", function () {
    it("NFR-2 limitation: the administrator can take back and re-grant any role", async function () {
      const ISSUER = await token.ISSUER_ROLE();
      await token.revokeRole(ISSUER, admin.address);
      await expect(token.issue(alice.address, 1)).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await token.grantRole(ISSUER, admin.address);
      await token.issue(alice.address, 1);
      expect(await token.balanceOf(alice.address)).to.equal(1);
    });

    it("NFR-2 an issuer-only account cannot grant roles", async function () {
      await token.grantRole(await token.ISSUER_ROLE(), issuerOnly.address);
      await expect(token.connect(issuerOnly).grantRole(await token.COMPLIANCE_ROLE(), issuerOnly.address))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });
  });

  // ------------------------------------------------ NFR-1 in the source
  describe("Reentrancy protection in the source (NFR-1)", function () {
    const dir = path.join(__dirname, "..", "contracts");
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const read = (f) => strip(fs.readFileSync(path.join(dir, f), "utf8"));

    it("NFR-1 source: redeem() is guarded by nonReentrant", function () {
      expect(read("RWAToken.sol")).to.match(/function\s+redeem\s*\([^)]*\)[^{]*\bnonReentrant\b/);
    });

    it("NFR-1 source: redeem() checks the price first, then burns, then emits, with no oracle call after the burn", function () {
      const src = read("RWAToken.sol");
      const start = src.indexOf("function redeem");
      expect(start).to.be.greaterThan(-1);
      const body = src.slice(start);
      const iPrice = body.indexOf("oracle.latestPrice()");
      const iBurn = body.indexOf("_burn(");
      const iEmit = body.indexOf("emit AssetRedeemed");
      expect(iPrice).to.be.greaterThan(-1);
      expect(iPrice).to.be.lessThan(iBurn);
      expect(iBurn).to.be.lessThan(iEmit);
      expect(body.slice(iBurn)).to.not.match(/\boracle\s*\./);
    });

    it("NFR-1 source positive control: in the vulnerable demo the external call comes before the balance update", function () {
      const src = read("VulnerableRWAToken.sol");
      const iCall = src.indexOf(".call{");
      const iEffect = src.indexOf("balances[msg.sender] -= amount");
      expect(iCall).to.be.greaterThan(-1);
      expect(iEffect).to.be.greaterThan(-1);
      expect(iCall).to.be.lessThan(iEffect);
    });
  });
});
