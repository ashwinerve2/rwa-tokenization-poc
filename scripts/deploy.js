const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);

  const MockOracle = await ethers.getContractFactory("MockOracle");
  const oracle = await MockOracle.deploy(100, deployer.address);
  await oracle.waitForDeployment();
  console.log("MockOracle deployed to:", await oracle.getAddress());

  const RWAToken = await ethers.getContractFactory("RWAToken");
  const token = await RWAToken.deploy(
    "Tokenized Property Share",
    "TPS",
    await oracle.getAddress(),
    deployer.address
  );
  await token.waitForDeployment();
  console.log("RWAToken deployed to:", await token.getAddress());

  console.log("\nSave these addresses — you'll want them for screenshots");
  console.log("and Etherscan links in your thesis Results chapter.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
