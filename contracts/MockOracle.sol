// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./IPriceOracle.sol";

/// @title MockOracle
/// @notice Minimal stand-in for a decentralized price feed (e.g. Chainlink),
///         used to demonstrate the oracle dependency risk discussed in
///         thesis section 2.4 (Protocol Vulnerabilities), and one concrete mitigation for it:
///         timestamping every update so a consuming contract can detect
///         staleness, plus a positive-price sanity check.
///
/// @dev In a production deployment this single-owner update pattern should
///      be replaced by a decentralized oracle network with multiple
///      independent data sources (see thesis 6.2, "Trusted Auditing and
///      Data Verification") — a single owner-controlled price is itself a
///      centralization / manipulation risk, which this PoC intentionally
///      keeps simple for demonstration purposes.
contract MockOracle is IPriceOracle, Ownable {
    int256 private price;
    uint256 private updatedAt;

    event PriceUpdated(int256 price, uint256 updatedAt);

    constructor(int256 initialPrice, address initialOwner) Ownable(initialOwner) {
        require(initialPrice > 0, "MockOracle: price must be positive");
        price = initialPrice;
        updatedAt = block.timestamp;
    }

    function updatePrice(int256 newPrice) external onlyOwner {
        require(newPrice > 0, "MockOracle: price must be positive");
        price = newPrice;
        updatedAt = block.timestamp;
        emit PriceUpdated(newPrice, updatedAt);
    }

    function latestPrice() external view override returns (int256, uint256) {
        return (price, updatedAt);
    }
}
