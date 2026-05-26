// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Per-user smart account on Arc — holds USDC and executes trades on
///        behalf of its owner, optionally via scoped session keys so an
///        off-chain runner can trade while the user is offline.
/// @notice Authorization model:
///         · `owner` (the user's EOA) can execute anything.
///         · A `session key` can execute calls bounded by a `SessionPermission`
///           granted by the owner: expiry, allowed target, allowed selector,
///           per-call cap, total lifetime cap. For PredictionMarket.buy() the
///           cap is metered against the `maxCost` argument (worst-case spend).
contract AgentAccount {
    using SafeERC20 for IERC20;

    /// @dev keccak256("buy(uint8,uint256,uint256)") → first 4 bytes.
    ///      Sessions that target PredictionMarket use this; the validator
    ///      decodes the third arg as the per-call USDC spend cap.
    bytes4 internal constant BUY_SELECTOR =
        bytes4(keccak256("buy(uint8,uint256,uint256)"));

    /// @notice USDC token the account auto-approves before forwarding `buy()`
    ///         calls — saves the runner from needing a separate `approve`
    ///         permission (which would either widen its attack surface or
    ///         require 50+ pre-approvals at setup).
    IERC20 public immutable usdc;

    address public owner;

    struct SessionPermission {
        uint64 validUntil;        // unix seconds; 0 = no session
        uint128 totalCap;         // max lifetime USDC spend, 6-dec
        uint128 totalSpent;       // running total, 6-dec
        uint128 perCallCap;       // max per single call, 6-dec
        address allowedTarget;    // address(0) = any target
        bytes4 allowedSelector;   // bytes4(0) = any selector
    }
    mapping(address => SessionPermission) public sessions;

    event Executed(address indexed target, uint256 value, bytes data);
    event SessionGranted(
        address indexed key,
        uint64 validUntil,
        uint128 totalCap,
        uint128 perCallCap,
        address allowedTarget,
        bytes4 allowedSelector
    );
    event SessionRevoked(address indexed key);
    event OwnerChanged(address indexed previous, address indexed current);

    error NotAuthorized();
    error ZeroAddress();
    error LengthMismatch();
    error SessionExpired();
    error TargetNotAllowed();
    error SelectorNotAllowed();
    error PerCallCapExceeded();
    error TotalCapExceeded();

    constructor(address _owner, IERC20 _usdc) {
        if (_owner == address(0)) revert ZeroAddress();
        if (address(_usdc) == address(0)) revert ZeroAddress();
        owner = _owner;
        usdc = _usdc;
        emit OwnerChanged(address(0), _owner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotAuthorized();
        _;
    }

    // ── Execute ──────────────────────────────────────────────────────────────

    /// @notice Execute an arbitrary call from this account. If the call is a
    ///         PredictionMarket `buy(uint8,uint256,uint256)` we auto-approve
    ///         USDC for the exact `maxCost` before forwarding, so the runner
    ///         never needs `approve` in its session scope.
    function execute(address target, uint256 value, bytes calldata data)
        external
        returns (bytes memory result)
    {
        _authorize(target, data);
        _approveForBuy(target, data);
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        emit Executed(target, value, data);
        return ret;
    }

    /// @notice Execute a batch atomically. Each call is authorised
    ///         independently so a partial-permission session can still
    ///         submit a batch that all pass.
    function executeBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata datas
    ) external returns (bytes[] memory results) {
        uint256 n = targets.length;
        if (n != values.length || n != datas.length) revert LengthMismatch();
        results = new bytes[](n);
        for (uint256 i; i < n; ++i) {
            _authorize(targets[i], datas[i]);
            _approveForBuy(targets[i], datas[i]);
            (bool ok, bytes memory ret) = targets[i].call{value: values[i]}(datas[i]);
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            results[i] = ret;
            emit Executed(targets[i], values[i], datas[i]);
        }
    }

    // ── Session management ──────────────────────────────────────────────────

    /// @notice Grant or replace a scoped session key. Resets `totalSpent` to 0.
    /// @param key             address whose calls to `execute` will be authorised
    /// @param validUntil      unix seconds after which the session is expired
    /// @param totalCap        maximum lifetime USDC spend (6-dec)
    /// @param perCallCap      maximum per single call (6-dec)
    /// @param allowedTarget   address(0) = any address, else only this address
    /// @param allowedSelector bytes4(0) = any selector, else only this selector
    function grantSession(
        address key,
        uint64 validUntil,
        uint128 totalCap,
        uint128 perCallCap,
        address allowedTarget,
        bytes4 allowedSelector
    ) external onlyOwner {
        if (key == address(0)) revert ZeroAddress();
        sessions[key] = SessionPermission({
            validUntil: validUntil,
            totalCap: totalCap,
            totalSpent: 0,
            perCallCap: perCallCap,
            allowedTarget: allowedTarget,
            allowedSelector: allowedSelector
        });
        emit SessionGranted(
            key,
            validUntil,
            totalCap,
            perCallCap,
            allowedTarget,
            allowedSelector
        );
    }

    function revokeSession(address key) external onlyOwner {
        delete sessions[key];
        emit SessionRevoked(key);
    }

    /// @notice Convenience view used by the UI to render a "live session" pill.
    function isSessionLive(address key) external view returns (bool) {
        SessionPermission memory s = sessions[key];
        return s.validUntil > 0 && block.timestamp <= s.validUntil;
    }

    // ── Owner-only finance ──────────────────────────────────────────────────

    function withdraw(IERC20 token, uint256 amount, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
    }

    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    receive() external payable {}

    // ── Internals ───────────────────────────────────────────────────────────

    function _authorize(address target, bytes calldata data) internal {
        if (msg.sender == owner) return;

        SessionPermission memory s = sessions[msg.sender];
        if (s.validUntil == 0) revert NotAuthorized();
        if (block.timestamp > s.validUntil) revert SessionExpired();

        if (s.allowedTarget != address(0) && s.allowedTarget != target) {
            revert TargetNotAllowed();
        }

        bytes4 sel = _selector(data);
        if (s.allowedSelector != bytes4(0) && s.allowedSelector != sel) {
            revert SelectorNotAllowed();
        }

        uint128 cost = _extractCost(sel, data);
        if (cost > s.perCallCap) revert PerCallCapExceeded();

        uint256 newSpent = uint256(s.totalSpent) + uint256(cost);
        if (newSpent > s.totalCap) revert TotalCapExceeded();
        sessions[msg.sender].totalSpent = uint128(newSpent);
    }

    function _selector(bytes calldata data) internal pure returns (bytes4) {
        if (data.length < 4) return bytes4(0);
        return bytes4(data[:4]);
    }

    /// @dev For `buy(uint8,uint256,uint256)` we decode the 3rd arg (maxCost)
    ///      as the worst-case USDC spend and meter against the session caps.
    ///      Other calls have cost 0 (no spend tracking) — guard with an
    ///      explicit selector restriction on the session for safety.
    function _extractCost(bytes4 sel, bytes calldata data) internal pure returns (uint128) {
        if (sel != BUY_SELECTOR) return 0;
        if (data.length < 4 + 32 * 3) return 0;
        (, , uint256 maxCost) = abi.decode(data[4:], (uint8, uint256, uint256));
        return maxCost > type(uint128).max ? type(uint128).max : uint128(maxCost);
    }

    /// @dev If the forwarded call is `buy(...)`, top up USDC allowance for
    ///      the target to exactly `maxCost`. forceApprove handles USDC's
    ///      non-zero-allowance reset requirement.
    function _approveForBuy(address target, bytes calldata data) internal {
        if (_selector(data) != BUY_SELECTOR) return;
        if (data.length < 4 + 32 * 3) return;
        (, , uint256 maxCost) = abi.decode(data[4:], (uint8, uint256, uint256));
        usdc.forceApprove(target, maxCost);
    }
}
