// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IPriceOracle.sol";

/// @title RWAToken
/// @notice Permissioned ERC20 token representing fractional ownership of a
///         real-world asset (RWA), e.g. a share of tokenized real estate.
///
/// @dev This contract is the practical implementation companion to the
///      thesis "Security and Trust Challenges in Blockchain-Based Real-World
///      Asset (RWA) Tokenization Systems". Each control below is mapped to
///      the risk category it mitigates, as discussed in Chapter 2 of the thesis:
///
///        - Custody / private key risk   (2.5) -> role-based AccessControl
///        - Smart contract vulnerability (2.4) -> nonReentrant + checks-
///                                                  effects-interactions
///        - Oracle / data manipulation   (2.4) -> staleness + range checks
///        - Compliance & audit trail   (2.6) -> KYC whitelist + events
///
///      The whitelist/compliance pattern implemented here is a simplified
///      version of the identity-gated transfer model popularized by the
///      ERC-3643 (T-REX) token standard, discussed in section 2.2 of the
///      thesis: both restrict transfers to addresses that have passed an
///      off-chain identity/KYC check and been recorded on-chain. This
///      contract does not implement the full ERC-3643 specification (no
///      on-chain identity registry or trusted-claim-issuer registry) —
///      that scope reduction is intentional for a proof-of-concept and is
///      stated explicitly in the thesis.
contract RWAToken is ERC20, AccessControl, Pausable, ReentrancyGuard {
    // ---------------------------------------------------------------
    // Roles (custody risk mitigation — see thesis 2.5)
    // ---------------------------------------------------------------
    // In production, ISSUER_ROLE and DEFAULT_ADMIN_ROLE should be held by a
    // multi-signature wallet (e.g. Gnosis Safe), not a single externally
    // owned account. This removes the single-private-key-compromise
    // scenario described in section 2.5 of the thesis.
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");

    // ---------------------------------------------------------------
    // Compliance state (trust / regulatory risk — see thesis 2.6)
    // ---------------------------------------------------------------
    mapping(address => bool) public isWhitelisted;

    // ---------------------------------------------------------------
    // Oracle dependency (see thesis 2.4)
    // ---------------------------------------------------------------
    IPriceOracle public oracle;
    uint256 public maxPriceAgeSeconds = 1 hours;
    int256 public minValidPrice = 1; // sanity floor against zero/negative injection

    // ---------------------------------------------------------------
    // Audit trail events (see thesis 2.6)
    // ---------------------------------------------------------------
    event Whitelisted(address indexed account, bool status, address indexed by);
    event AssetRedeemed(address indexed holder, uint256 amount, int256 priceAtRedemption, uint256 timestamp);
    event OracleUpdated(address indexed newOracle, address indexed by);
    event TokensIssued(address indexed to, uint256 amount, address indexed by);
    event TokensForceBurned(address indexed from, uint256 amount, address indexed by);

    modifier onlyWhitelisted(address account) {
        require(isWhitelisted[account], "RWAToken: account not KYC-whitelisted");
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        address oracleAddress,
        address admin
    ) ERC20(name_, symbol_) {
        require(oracleAddress.code.length > 0, "RWAToken: oracle must be a contract");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ISSUER_ROLE, admin);
        _grantRole(COMPLIANCE_ROLE, admin);
        oracle = IPriceOracle(oracleAddress);
    }

    // ---------------------------------------------------------------
    // Compliance management (KYC/AML whitelist — thesis 2.6)
    // ---------------------------------------------------------------
    function setWhitelist(address account, bool status) external onlyRole(COMPLIANCE_ROLE) {
        isWhitelisted[account] = status;
        emit Whitelisted(account, status, msg.sender);
    }

    // ---------------------------------------------------------------
    // Custody-controlled issuance (thesis 2.5)
    // ---------------------------------------------------------------
    function issue(address to, uint256 amount) external onlyRole(ISSUER_ROLE) onlyWhitelisted(to) whenNotPaused {
        _mint(to, amount);
        emit TokensIssued(to, amount, msg.sender);
    }

    function burnFrom(address from, uint256 amount) external onlyRole(ISSUER_ROLE) whenNotPaused {
        _burn(from, amount);
        emit TokensForceBurned(from, amount, msg.sender);
    }

    // ---------------------------------------------------------------
    // Emergency stop / incident response
    // ---------------------------------------------------------------
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------
    // Oracle governance (thesis 2.4)
    // ---------------------------------------------------------------
    function setOracle(address newOracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newOracle.code.length > 0, "RWAToken: oracle must be a contract");
        oracle = IPriceOracle(newOracle);
        emit OracleUpdated(newOracle, msg.sender);
    }

    // ---------------------------------------------------------------
    // Transfer restriction: both parties must be KYC-whitelisted
    // (OpenZeppelin v5 hook — fires on mint, transfer, and burn)
    // ---------------------------------------------------------------
    function _update(address from, address to, uint256 value) internal override whenNotPaused {
        if (from != address(0)) {
            require(isWhitelisted[from], "RWAToken: sender not whitelisted");
        }
        if (to != address(0)) {
            require(isWhitelisted[to], "RWAToken: recipient not whitelisted");
        }
        super._update(from, to, value);
    }

    /// @notice Redeem tokens for the underlying asset value.
    /// @dev Demonstrates two mitigations at once:
    ///      1. Reentrancy protection: state (balance) is burned BEFORE any
    ///         further interaction, and the function is additionally
    ///         guarded by `nonReentrant`. There is no external call after
    ///         the state change, so there is no reentrancy attack surface
    ///         — contrast with contracts/VulnerableRWAToken.sol, which
    ///         violates checks-effects-interactions on purpose.
    ///      2. Oracle validation: redemption value depends on price data,
    ///         so a stale or out-of-range price is rejected outright
    ///         rather than silently trusted (thesis 2.4).
    function redeem(uint256 amount) external nonReentrant onlyWhitelisted(msg.sender) whenNotPaused {
        require(balanceOf(msg.sender) >= amount, "RWAToken: insufficient balance");

        (int256 price, uint256 updatedAt) = oracle.latestPrice();
        require(price >= minValidPrice, "RWAToken: oracle price out of valid range");
        require(block.timestamp - updatedAt <= maxPriceAgeSeconds, "RWAToken: oracle price stale");

        // Effects before any (future) interactions.
        _burn(msg.sender, amount);

        emit AssetRedeemed(msg.sender, amount, price, block.timestamp);

        // A real payout / settlement call would go here, AFTER state has
        // already changed — the correct order per checks-effects-interactions.
    }
}
