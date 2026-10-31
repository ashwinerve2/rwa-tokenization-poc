// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title VulnerableRWAToken
/// @notice INTENTIONALLY INSECURE — included only as an empirical
///         demonstration of the smart contract vulnerability class
///         discussed in thesis section 2.4 (Protocol Vulnerabilities).
///
///         DO NOT deploy this contract to a live network with real funds.
///         It exists solely so the test suite can (a) attack it
///         successfully, proving the vulnerability is real and not just
///         theoretical, and (b) show that the same attack strategy has no
///         equivalent surface against the hardened RWAToken.sol.
contract VulnerableRWAToken {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    /// @dev Classic reentrancy bug: the external call to msg.sender happens
    ///      BEFORE the balance is decremented, violating the
    ///      checks-effects-interactions pattern. A malicious contract can
    ///      re-enter withdraw() from its receive() fallback before the
    ///      first call finishes, draining more than it deposited.
    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "insufficient balance");
        (bool ok, ) = msg.sender.call{value: amount}(""); // <-- interaction first
        require(ok, "transfer failed");
        // `unchecked` is used on purpose: under Solidity 0.8 the normal checked
        // subtraction would revert when the nested (re-entered) calls unwind
        // and hide the classic pre-0.8 behaviour that this demo reproduces.
        unchecked { balances[msg.sender] -= amount; }      // <-- effect too late
    }

    receive() external payable {}
}
