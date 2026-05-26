// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {AgentAccount} from "./AgentAccount.sol";

/// @title CREATE2 factory for per-user `AgentAccount` instances.
/// @notice One account per owner EOA. The address is deterministic — clients
///         can render it before deployment, accept deposits to it, or wait
///         for the user to fund it. Deploy is permissionless: anyone can
///         pay the gas to materialise a known address, but ownership is
///         baked into the constructor argument. USDC is baked at factory
///         deploy time so every spawned account is wired to the right token.
contract AgentAccountFactory {
    /// @dev USDC token address forwarded to every deployed account.
    IERC20 public immutable usdc;

    /// @dev owner EOA → deployed AgentAccount. Zero means not yet deployed.
    mapping(address => address) public accountOf;
    address[] public allAccounts;

    event AccountCreated(address indexed owner, address indexed account);

    error AlreadyDeployed();
    error ZeroAddress();

    constructor(IERC20 _usdc) {
        if (address(_usdc) == address(0)) revert ZeroAddress();
        usdc = _usdc;
    }

    /// @notice Deploy an `AgentAccount` for `owner` at its predictable CREATE2
    ///         address. Reverts if one already exists.
    function deploy(address owner) external returns (address account) {
        if (owner == address(0)) revert ZeroAddress();
        if (accountOf[owner] != address(0)) revert AlreadyDeployed();

        bytes32 salt = _salt(owner);
        bytes memory bytecode = _bytecode(owner);

        account = Create2.deploy(0, salt, bytecode);
        accountOf[owner] = account;
        allAccounts.push(account);

        emit AccountCreated(owner, account);
    }

    /// @notice Compute the CREATE2 address the owner's account will live at.
    function predict(address owner) external view returns (address) {
        return Create2.computeAddress(_salt(owner), keccak256(_bytecode(owner)));
    }

    function accountCount() external view returns (uint256) {
        return allAccounts.length;
    }

    // ── Internals ───────────────────────────────────────────────────────────

    function _salt(address owner) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(owner));
    }

    function _bytecode(address owner) internal view returns (bytes memory) {
        return abi.encodePacked(
            type(AgentAccount).creationCode,
            abi.encode(owner, usdc)
        );
    }
}
