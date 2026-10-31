# Setup notes

1. Install Node.js 18 or newer (`node --version`).
2. In this folder run `npm install`. It installs Hardhat, OpenZeppelin Contracts and the test tools.
3. `npx hardhat compile` should finish without errors.
4. `npx hardhat test` should end with `38 passing`.
5. Commit `package-lock.json` after the first install, so that anyone who clones the repository gets exactly the same package versions.

If a step fails, copy the full error message and ask for help before changing the code.
Sepolia deployment (optional) is described in `README.md`.
