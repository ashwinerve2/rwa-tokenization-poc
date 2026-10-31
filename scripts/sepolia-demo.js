// Deploys the prototype to Sepolia and runs one short scenario,
// so every important action leaves a real, public transaction.
// Run: npx hardhat run scripts/sepolia-demo.js --network sepolia | tee results/sepolia-output.txt
const { ethers, network } = require("hardhat");

const EXPLORER = "https://sepolia.etherscan.io";
const rows = [];

async function step(label, txPromise) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  const block = await ethers.provider.getBlock(receipt.blockNumber);
  rows.push({
    label,
    block: receipt.blockNumber,
    time: new Date(block.timestamp * 1000).toISOString(),
    hash: tx.hash,
  });
  console.log(`done: ${label}  (block ${receipt.blockNumber})`);
  return receipt;
}

async function main() {
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 11155111n) {
    throw new Error(`Wrong network (chainId ${net.chainId}). Run with --network sepolia.`);
  }

  const [admin] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(admin.address);
  console.log("Network:        Sepolia (chainId 11155111)");
  console.log("Admin account:  ", admin.address);
  console.log("Balance:        ", ethers.formatEther(balance), "Sepolia ETH");
  if (balance === 0n) throw new Error("This account has no Sepolia ETH. Use a faucet first.");

  // A second investor address. It never signs anything, so no key is needed.
  const bob = ethers.Wallet.createRandom().address;

  console.log("\n=== Deployment ===");
  const Oracle = await ethers.getContractFactory("MockOracle");
  const oracle = await Oracle.deploy(100, admin.address);
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();
  console.log("MockOracle:", oracleAddr, `${EXPLORER}/address/${oracleAddr}`);

  const Token = await ethers.getContractFactory("RWAToken");
  const token = await Token.deploy("Tokenized Property Share", "TPS", oracleAddr, admin.address);
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  console.log("RWAToken:  ", tokenAddr, `${EXPLORER}/address/${tokenAddr}`);

  console.log("\n=== Scenario ===");
  await step("Whitelisted: admin account approved", token.setWhitelist(admin.address, true));
  await step("Whitelisted: second investor approved", token.setWhitelist(bob, true));
  await step("Issue 1000 tokens to admin account", token.issue(admin.address, 1000n));
  await step("Transfer 100 tokens to second investor", token.transfer(bob, 100n));
  await step("Redeem 50 tokens at oracle price", token.redeem(50n));
  await step("Pause", token.pause());
  await step("Unpause", token.unpause());

  console.log("\n=== Final balances ===");
  console.log("Admin account:   ", (await token.balanceOf(admin.address)).toString(), "(expected 850)");
  console.log("Second investor: ", (await token.balanceOf(bob)).toString(), "(expected 100)");
  console.log("Total supply:    ", (await token.totalSupply()).toString(), "(expected 950)");

  console.log("\n=== Public transactions (open each link and screenshot) ===");
  console.log("| Step | Block | Time (UTC) | Transaction |");
  console.log("| --- | --- | --- | --- |");
  for (const r of rows) {
    console.log(`| ${r.label} | ${r.block} | ${r.time} | ${EXPLORER}/tx/${r.hash} |`);
  }
  console.log("\nContract links:");
  console.log("RWAToken  ", `${EXPLORER}/address/${tokenAddr}`);
  console.log("MockOracle", `${EXPLORER}/address/${oracleAddr}`);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
