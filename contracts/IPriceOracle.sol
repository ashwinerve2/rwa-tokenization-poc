// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPriceOracle
/// @notice Minimal interface the token needs from any price source.
///         The token depends on this interface, not on a concrete oracle,
///         so the mock oracle used in the proof-of-concept can later be
///         replaced by an adapter to a real decentralised oracle network.
interface IPriceOracle {
    /// @return price     latest price reported by the oracle
    /// @return updatedAt Unix timestamp (seconds) of that price
    function latestPrice() external view returns (int256 price, uint256 updatedAt);
}
