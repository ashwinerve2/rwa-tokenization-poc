/**
 * Evidence script for Chapter 4.
 * Runs the main scenarios once and prints readable tables:
 *   A. oracle input cases   B. reentrancy before/after
 *   C. audit trail (events) D. who may call what (roles)
 *
 * Run:  npx hardhat run scripts/evidence.js
 * Save: npx hardhat run scripts/evidence.js | tee results/evidence-output.txt
 */
const { ethers, network } = require("hardhat");

const why = (e) =>
  e.reason || (e.revert && e.revert.name) || e.shortMessage || String(e.message).split("\n")[0];

async function attempt(fn) {
  try {
    await fn();
    return "succeeds";
  } catch (e) {
    return "rejected: " + why(e);
  }
}

async function deployFresh(signers) {
  const [admin, alice, bob] = signers;
  const oracle = await (await ethers.getContractFactory("MockOracle")).deploy(100, admin.address);
  await oracle.waitForDeployment();
  const token = await (await ethers.getContractFactory("RWAToken")).deploy(
    "Tokenized Property Share", "TPS", await oracle.getAddress(), admin.address
  );
  await token.waitForDeployment();
  await token.setWhitelist(alice.address, true);
  await token.setWhitelist(bob.address, true);
  await token.issue(alice.address, 1000);
  return { oracle, token };
}

async function useFaulty(token, price, timestamp) {
  const f = await (await ethers.getContractFactory("FaultyOracle")).deploy();
  await f.waitForDeployment();
  await f.set(price, timestamp);
  await token.setOracle(await f.getAddress());
}

async function latestTs() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

function row(cells) {
  console.log("| " + cells.join(" | ") + " |");
}

async function main() {
  const signers = await ethers.getSigners();
  const [admin, alice, bob, outsider, issuerOnly, complianceOnly] = signers;

  // ------------------------------------------------------------ A. oracle
  console.log("\n=== A. Oracle input cases (redeem 10 tokens) ===\n");
  row(["Oracle returns", "Expected", "What the contract did"]);
  row(["---", "---", "---"]);

  {
    const { token } = await deployFresh(signers);
    const tx = await token.connect(alice).redeem(10);
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return token.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "AssetRedeemed");
    row(["Price 100, updated just now", "Redemption succeeds",
      "succeeds; AssetRedeemed emitted with price " + ev.args.priceAtRedemption.toString()]);
  }
  {
    const { token } = await deployFresh(signers);
    await ethers.provider.send("evm_increaseTime", [3700]);
    await ethers.provider.send("evm_mine");
    row(["Price 100, updated 3700 s ago", "Rejected",
      await attempt(() => token.connect(alice).redeem.staticCall(10))]);
  }
  {
    const { token } = await deployFresh(signers);
    await useFaulty(token, 0, await latestTs());
    row(["Price 0", "Rejected", await attempt(() => token.connect(alice).redeem.staticCall(10))]);
  }
  {
    const { token } = await deployFresh(signers);
    await useFaulty(token, -5, await latestTs());
    row(["Price -5", "Rejected", await attempt(() => token.connect(alice).redeem.staticCall(10))]);
  }
  {
    const { token } = await deployFresh(signers);
    await useFaulty(token, 100, (await latestTs()) + 86400);
    row(["Price 100, update time one day in the future", "Rejected",
      await attempt(() => token.connect(alice).redeem.staticCall(10))]);
  }
  {
    const { token } = await deployFresh(signers);
    row(["Oracle address that is not a contract (setOracle)", "Rejected",
      await attempt(() => token.setOracle.staticCall(outsider.address))]);
    const F = await ethers.getContractFactory("RWAToken");
    row(["Oracle address that is not a contract (deployment)", "Rejected",
      await attempt(() => F.deploy("X", "X", outsider.address, admin.address))]);
  }

  // ------------------------------------------------------- B. reentrancy
  console.log("\n=== B. Reentrancy before and after ===\n");
  {
    const victim = bob;
    const vulnerable = await (await ethers.getContractFactory("VulnerableRWAToken")).deploy();
    await vulnerable.waitForDeployment();
    await vulnerable.connect(victim).deposit({ value: ethers.parseEther("5") });
    const attacker = await (await ethers.getContractFactory("ReentrancyAttacker")).deploy(await vulnerable.getAddress());
    await attacker.waitForDeployment();
    const before = await ethers.provider.getBalance(await vulnerable.getAddress());
    await attacker.attack({ value: ethers.parseEther("1") });
    const after = await ethers.provider.getBalance(await vulnerable.getAddress());
    const held = await ethers.provider.getBalance(await attacker.getAddress());
    row(["", "VulnerableRWAToken"]);
    row(["---", "---"]);
    row(["Attacker deposits", "1.0 ETH"]);
    row(["Pool before attack", ethers.formatEther(before) + " ETH (includes 5 ETH of another user)"]);
    row(["Pool after attack", ethers.formatEther(after) + " ETH"]);
    row(["Attacker contract holds", ethers.formatEther(held) + " ETH"]);
  }
  {
    const { token } = await deployFresh(signers);
    const b = await token.balanceOf(alice.address);
    await token.connect(alice).redeem(500);
    const a = await token.balanceOf(alice.address);
    console.log("\nRWAToken.redeem: balance " + b + " -> " + a +
      "; no external call after the burn, so there is nothing to re-enter.");
  }

  // ----------------------------------------------------------- C. events
  console.log("\n=== C. Audit trail: events from one scenario ===\n");
  {
    const { oracle, token } = await deployFresh(signers);
    await token.connect(alice).transfer(bob.address, 100);
    await token.connect(alice).redeem(50);
    await token.pause();
    await token.unpause();
    const o2 = await (await ethers.getContractFactory("MockOracle")).deploy(120, admin.address);
    await o2.waitForDeployment();
    await token.setOracle(await o2.getAddress());
    await token.setWhitelist(bob.address, false);
    await token.setWhitelist(bob.address, true);

    const label = {
      [admin.address]: "admin", [alice.address]: "alice", [bob.address]: "bob",
      [ethers.ZeroAddress]: "zero-address",
      [await oracle.getAddress()]: "MockOracle#1", [await o2.getAddress()]: "MockOracle#2",
    };
    const fmt = (v) => (typeof v === "string" && label[v] ? label[v] : v.toString());

    const logs = await ethers.provider.getLogs({ address: await token.getAddress(), fromBlock: 0 });
    row(["Block", "Time (UTC)", "Event", "Fields"]);
    row(["---", "---", "---", "---"]);
    for (const log of logs) {
      let p;
      try { p = token.interface.parseLog(log); } catch { continue; }
      const blk = await ethers.provider.getBlock(log.blockNumber);
      const fields = p.fragment.inputs.map((inp, i) => inp.name + "=" + fmt(p.args[i])).join(", ");
      row([log.blockNumber, new Date(blk.timestamp * 1000).toISOString(), p.name, fields]);
    }
  }

  // ------------------------------------------------------ D. role matrix
  console.log("\n=== D. Who may call what (role separation) ===\n");
  {
    const { oracle, token } = await deployFresh(signers);
    await token.grantRole(await token.ISSUER_ROLE(), issuerOnly.address);
    await token.grantRole(await token.COMPLIANCE_ROLE(), complianceOnly.address);
    const who = [["admin (all roles)", admin], ["issuer only", issuerOnly],
      ["compliance only", complianceOnly], ["investor", alice]];
    const calls = [
      ["issue", (t) => t.issue.staticCall(alice.address, 1)],
      ["burnFrom", (t) => t.burnFrom.staticCall(alice.address, 1)],
      ["setWhitelist", (t) => t.setWhitelist.staticCall(outsider.address, true)],
      ["pause", (t) => t.pause.staticCall()],
      ["setOracle", async (t) => t.setOracle.staticCall(await oracle.getAddress())],
    ];
    row(["Function", ...who.map((w) => w[0])]);
    row(["---", ...who.map(() => "---")]);
    for (const [name, call] of calls) {
      const cells = [];
      for (const [, signer] of who) {
        const res = await attempt(() => call(token.connect(signer)));
        cells.push(res === "succeeds" ? "allowed" : "refused");
      }
      row([name, ...cells]);
    }
  }
  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
