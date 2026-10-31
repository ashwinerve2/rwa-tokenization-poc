// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../IPriceOracle.sol";

/// @title FaultyOracle
/// @notice TEST-ONLY oracle with no input checks. It lets the test suite
///         feed the token the kinds of bad data a faulty or compromised
///         oracle could report: zero or negative prices and timestamps.
contract FaultyOracle is IPriceOracle {
    int256 private price;
    uint256 private updatedAt;

    function set(int256 newPrice, uint256 newUpdatedAt) external {
        price = newPrice;
        updatedAt = newUpdatedAt;
    }

    function latestPrice() external view override returns (int256, uint256) {
        return (price, updatedAt);
    }
}
