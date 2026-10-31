# RWA Tokenization Security Proof of Concept

Proof of concept for the Bachelor's thesis *Security and Trust Challenges in
Blockchain-Based Real-World Asset (RWA) Tokenization Systems* (Centria UAS).

It is a small permissioned token for a hypothetical real-estate share
("Tokenized Property Share", TPS) with the controls discussed in the thesis:
role separation, a KYC whitelist enforced on every transfer, oracle data
checks, an emergency pause, and an event-based audit trail. An intentionally
vulnerable contract and an attacker are included for a before-and-after
comparison. This is a research prototype. **Do not use it with real assets.**

## Contracts

| File | Purpose |
|---|---|
| `contracts/RWAToken.sol` | The token and all rules (system under evaluation) |
| `contracts/IPriceOracle.sol` | Interface the token uses to ask for a price |
| `contracts/MockOracle.sol` | Simulated price feed used in the prototype |
| `contracts/testing/FaultyOracle.sol` | Test only: returns any bad data on purpose |
| `contracts/VulnerableRWAToken.sol` | Test only: deliberately unsafe withdrawal |
| `contracts/ReentrancyAttacker.sol` | Test only: attacks the unsafe contract |

## Run it

Requires Node.js 18 or newer.

```bash
npm install
npx hardhat compile
npx hardhat test                    # 38 automated tests
npx hardhat coverage                # line and branch coverage of the contracts
npx hardhat run scripts/evidence.js # readable tables for the thesis results
```

Save the outputs for the thesis (macOS/Linux):

```bash
mkdir -p results
npx hardhat test | tee results/test-output.txt
npx hardhat coverage | tee results/coverage-output.txt
npx hardhat run scripts/evidence.js | tee results/evidence-output.txt
```

## Requirements and tests

Every test name starts with the ID of the requirement it checks.

| Requirement | Checked by |
|---|---|
| FR-1 Only the issuer can mint or burn | "FR-1 ..." tests |
| FR-2 Whitelist changes need the compliance role | "FR-2 ..." tests |
| FR-3 Oracle data must be valid and recent | "FR-3 ..." tests |
| FR-4 Key actions emit events naming the actor | "FR-4 ..." tests |
| FR-5 The administrator can pause everything | "FR-5 ..." tests |
| NFR-1 Reentrancy resistance | "NFR-1 BEFORE / AFTER" tests |
| NFR-2 Separate roles | "NFR-2 ..." tests |
| NFR-3 No unchecked arithmetic | "NFR-3 ..." source tests |
| NFR-4 No low-level calls | "NFR-4 ..." source tests |
| DR-1 Only whitelisted addresses can hold, send, receive and redeem | "DR-1 ..." tests |
| DR-2 A removed address is barred | "DR-2 ..." tests |

## Scope and limits

- The oracle is a mock owned by the deployer. It says nothing about real oracle networks.
- KYC/AML checks, payment on redemption and legal ownership are outside the prototype.
- The tests were written by the author of the contracts. They show that the listed rules work, not that no other flaws exist.
- Not covered: OWASP SC02 (business logic), SC04 (flash loans), SC05 (input validation, only partly), SC07 (arithmetic in price calculations), SC10 (upgradeability).
- Tests run on the local Hardhat network.

## Optional: deploy to the Sepolia test network

Copy `.env.example` to `.env`, fill in a Sepolia RPC URL and the private key of
a **throwaway test wallet**, then run `npm run deploy:sepolia`. Never commit `.env`.

## License

MIT
