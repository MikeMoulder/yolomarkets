// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {PredictionMarket} from "./PredictionMarket.sol";

/// @title Factory + admin for binary prediction markets.
/// @notice Admin (treasury) calls `createMarket` to seed a new LMSR market and
///         `resolveMarket` to settle one after its deadline.
contract MarketFactory {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    address public admin;

    address[] public markets;
    mapping(address => bool) public isMarket;
    mapping(address => uint256) public marketIndex; // 1-based; 0 = not present

    event MarketCreated(
        address indexed market,
        string question,
        string category,
        uint256 deadline,
        uint256 initialLiquidity
    );
    event MarketResolved(address indexed market, PredictionMarket.Outcome outcome);
    event AdminChanged(address indexed previous, address indexed current);

    error NotAdmin();
    error UnknownMarket();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(IERC20 _usdc, address _admin) {
        usdc = _usdc;
        admin = _admin;
        emit AdminChanged(address(0), _admin);
    }

    /// @notice Deploy a new market. The factory is the market's admin (so
    ///         resolution authority lives here). Pulls `initialLiquidity` USDC
    ///         from the calling admin → factory → market in one tx.
    function createMarket(
        string calldata question,
        string calldata category,
        string calldata resolutionCriteria,
        uint256 deadline,
        uint256 initialLiquidity
    ) external onlyAdmin returns (address market) {
        // Pull seed USDC from admin into the factory itself.
        usdc.safeTransferFrom(msg.sender, address(this), initialLiquidity);

        bytes32 salt = keccak256(abi.encodePacked(question, deadline));
        bytes memory bytecode = abi.encodePacked(
            type(PredictionMarket).creationCode,
            abi.encode(
                usdc,
                address(this), // factory is the market's admin
                deadline,
                initialLiquidity,
                question,
                category,
                resolutionCriteria
            )
        );
        address predicted = Create2.computeAddress(salt, keccak256(bytecode));

        // Pre-approve the about-to-exist market for the seed amount, then deploy.
        usdc.forceApprove(predicted, initialLiquidity);

        market = Create2.deploy(0, salt, bytecode);
        require(market == predicted, "CREATE2 mismatch");

        markets.push(market);
        isMarket[market] = true;
        marketIndex[market] = markets.length; // 1-based

        emit MarketCreated(market, question, category, deadline, initialLiquidity);
    }

    /// @notice Resolve a market after its deadline. Only callable by admin.
    function resolveMarket(address market, PredictionMarket.Outcome outcome) external onlyAdmin {
        if (!isMarket[market]) revert UnknownMarket();
        PredictionMarket(market).resolve(outcome);
        emit MarketResolved(market, outcome);
    }

    function setAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "zero admin");
        emit AdminChanged(admin, newAdmin);
        admin = newAdmin;
    }

    // ── Views ────────────────────────────────────────────────────────────────

    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    function allMarkets() external view returns (address[] memory) {
        return markets;
    }

    /// @notice Predict a market's CREATE2 address before deployment.
    function predictMarket(
        string calldata question,
        string calldata category,
        string calldata resolutionCriteria,
        uint256 deadline,
        uint256 initialLiquidity
    ) external view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(question, deadline));
        bytes memory bytecode = abi.encodePacked(
            type(PredictionMarket).creationCode,
            abi.encode(
                usdc,
                address(this),
                deadline,
                initialLiquidity,
                question,
                category,
                resolutionCriteria
            )
        );
        return Create2.computeAddress(salt, keccak256(bytecode));
    }
}
