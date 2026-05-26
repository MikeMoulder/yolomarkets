// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SD59x18, sd} from "@prb/math/SD59x18.sol";

/// @title Binary LMSR prediction market settled in USDC.
/// @notice One winning share pays exactly 1 USDC (6-dec) at resolution.
///         The AMM's worst-case loss is `b * ln(2)`, bounded to the
///         `initialLiquidity` seed at construction.
contract PredictionMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Outcome {
        Unresolved,
        Yes,
        No
    }

    // ── Immutables ────────────────────────────────────────────────────────────
    IERC20 public immutable usdc;
    address public immutable admin;
    uint256 public immutable deadline;
    uint256 public immutable initialLiquidity; // 6-dec USDC seed
    SD59x18 public immutable b; // liquidity parameter (18-dec)

    string public question;
    string public category;
    string public resolutionCriteria;

    // ── State ─────────────────────────────────────────────────────────────────
    SD59x18 public qYes; // cumulative YES shares (18-dec)
    SD59x18 public qNo; // cumulative NO shares (18-dec)
    Outcome public outcome;
    bool public resolved;

    mapping(address => uint256) public sharesYes; // 6-dec
    mapping(address => uint256) public sharesNo; // 6-dec
    uint256 public totalSharesYes; // 6-dec
    uint256 public totalSharesNo; // 6-dec

    // ── Events ────────────────────────────────────────────────────────────────
    event Bought(
        address indexed who,
        Outcome indexed outcome,
        uint256 shares,
        uint256 cost,
        int256 newPriceYesRaw // SD59x18-unwrapped, in [0, 1e18]
    );
    event Sold(
        address indexed who,
        Outcome indexed outcome,
        uint256 shares,
        uint256 received,
        int256 newPriceYesRaw
    );
    event Resolved(Outcome outcome);
    event Claimed(address indexed who, uint256 amount);

    // ── Errors ────────────────────────────────────────────────────────────────
    error AlreadyResolved();
    error NotResolved();
    error PastDeadline();
    error BeforeDeadline();
    error BadOutcome();
    error ZeroShares();
    error InsufficientShares();
    error Slippage();
    error NotAdmin();
    error NothingToClaim();

    constructor(
        IERC20 _usdc,
        address _admin,
        uint256 _deadline,
        uint256 _initialLiquidity, // 6-dec
        string memory _question,
        string memory _category,
        string memory _resolutionCriteria
    ) {
        require(_deadline > block.timestamp, "deadline in past");
        require(_initialLiquidity > 0, "no liquidity");

        usdc = _usdc;
        admin = _admin;
        deadline = _deadline;
        initialLiquidity = _initialLiquidity;
        question = _question;
        category = _category;
        resolutionCriteria = _resolutionCriteria;

        // b = initialLiquidity / ln(2)   (18-dec internal scale)
        // ln(2) constant in SD59x18 = 693_147_180_559_945_309
        SD59x18 liq = sd(int256(_initialLiquidity * 1e12));
        SD59x18 ln2 = sd(693_147_180_559_945_309);
        b = liq.div(ln2);

        _usdc.safeTransferFrom(msg.sender, address(this), _initialLiquidity);
    }

    // ── Trading ───────────────────────────────────────────────────────────────

    /// @notice Buy `_shares` (6-dec) of `_outcome`, paying at most `_maxCost` USDC.
    /// @return cost USDC actually charged (6-dec, rounded UP)
    function buy(Outcome _outcome, uint256 _shares, uint256 _maxCost)
        external
        nonReentrant
        returns (uint256 cost)
    {
        if (resolved) revert AlreadyResolved();
        if (block.timestamp >= deadline) revert PastDeadline();
        if (_outcome != Outcome.Yes && _outcome != Outcome.No) revert BadOutcome();
        if (_shares == 0) revert ZeroShares();

        (SD59x18 newQYes, SD59x18 newQNo) = _addShares(qYes, qNo, _outcome, _shares);
        cost = _diffCostUp(qYes, qNo, newQYes, newQNo);
        if (cost > _maxCost) revert Slippage();

        qYes = newQYes;
        qNo = newQNo;
        if (_outcome == Outcome.Yes) {
            sharesYes[msg.sender] += _shares;
            totalSharesYes += _shares;
        } else {
            sharesNo[msg.sender] += _shares;
            totalSharesNo += _shares;
        }

        usdc.safeTransferFrom(msg.sender, address(this), cost);
        emit Bought(msg.sender, _outcome, _shares, cost, _priceYesRaw(newQYes, newQNo));
    }

    /// @notice Sell `_shares` of `_outcome`, receiving at least `_minReceived` USDC.
    /// @return received USDC paid back (6-dec, rounded DOWN)
    function sell(Outcome _outcome, uint256 _shares, uint256 _minReceived)
        external
        nonReentrant
        returns (uint256 received)
    {
        if (resolved) revert AlreadyResolved();
        if (block.timestamp >= deadline) revert PastDeadline();
        if (_outcome != Outcome.Yes && _outcome != Outcome.No) revert BadOutcome();
        if (_shares == 0) revert ZeroShares();

        if (_outcome == Outcome.Yes) {
            if (sharesYes[msg.sender] < _shares) revert InsufficientShares();
        } else {
            if (sharesNo[msg.sender] < _shares) revert InsufficientShares();
        }

        (SD59x18 newQYes, SD59x18 newQNo) = _subShares(qYes, qNo, _outcome, _shares);
        received = _diffCostDown(newQYes, newQNo, qYes, qNo);
        if (received < _minReceived) revert Slippage();

        qYes = newQYes;
        qNo = newQNo;
        if (_outcome == Outcome.Yes) {
            sharesYes[msg.sender] -= _shares;
            totalSharesYes -= _shares;
        } else {
            sharesNo[msg.sender] -= _shares;
            totalSharesNo -= _shares;
        }

        usdc.safeTransfer(msg.sender, received);
        emit Sold(msg.sender, _outcome, _shares, received, _priceYesRaw(newQYes, newQNo));
    }

    // ── Resolution ────────────────────────────────────────────────────────────

    function resolve(Outcome _outcome) external {
        if (msg.sender != admin) revert NotAdmin();
        if (resolved) revert AlreadyResolved();
        if (block.timestamp < deadline) revert BeforeDeadline();
        if (_outcome != Outcome.Yes && _outcome != Outcome.No) revert BadOutcome();

        resolved = true;
        outcome = _outcome;
        emit Resolved(_outcome);
    }

    /// @notice After resolution, redeem winning shares 1:1 for USDC.
    function claim() external nonReentrant returns (uint256 amount) {
        if (!resolved) revert NotResolved();

        if (outcome == Outcome.Yes) {
            amount = sharesYes[msg.sender];
            sharesYes[msg.sender] = 0;
        } else {
            amount = sharesNo[msg.sender];
            sharesNo[msg.sender] = 0;
        }
        if (amount == 0) revert NothingToClaim();

        usdc.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /// @return SD59x18-scaled probability of YES, range [0, 1e18]
    function priceYes() external view returns (int256) {
        return _priceYesRaw(qYes, qNo);
    }

    /// @notice Preview buy cost (6-dec USDC, rounded UP).
    function previewBuy(Outcome _outcome, uint256 _shares) external view returns (uint256 cost) {
        if (_outcome != Outcome.Yes && _outcome != Outcome.No) return 0;
        if (_shares == 0) return 0;
        (SD59x18 newQYes, SD59x18 newQNo) = _addShares(qYes, qNo, _outcome, _shares);
        cost = _diffCostUp(qYes, qNo, newQYes, newQNo);
    }

    /// @notice Preview sell proceeds (6-dec USDC, rounded DOWN).
    function previewSell(Outcome _outcome, uint256 _shares)
        external
        view
        returns (uint256 received)
    {
        if (_outcome != Outcome.Yes && _outcome != Outcome.No) return 0;
        if (_shares == 0) return 0;
        (SD59x18 newQYes, SD59x18 newQNo) = _subShares(qYes, qNo, _outcome, _shares);
        received = _diffCostDown(newQYes, newQNo, qYes, qNo);
    }

    function totalLiquidity() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    // ── Internal LMSR ─────────────────────────────────────────────────────────

    function _addShares(SD59x18 _qYes, SD59x18 _qNo, Outcome _outcome, uint256 _shares)
        internal
        pure
        returns (SD59x18 nYes, SD59x18 nNo)
    {
        SD59x18 dShares = sd(int256(_shares * 1e12));
        if (_outcome == Outcome.Yes) {
            nYes = _qYes.add(dShares);
            nNo = _qNo;
        } else {
            nYes = _qYes;
            nNo = _qNo.add(dShares);
        }
    }

    function _subShares(SD59x18 _qYes, SD59x18 _qNo, Outcome _outcome, uint256 _shares)
        internal
        pure
        returns (SD59x18 nYes, SD59x18 nNo)
    {
        SD59x18 dShares = sd(int256(_shares * 1e12));
        if (_outcome == Outcome.Yes) {
            nYes = _qYes.sub(dShares);
            nNo = _qNo;
        } else {
            nYes = _qYes;
            nNo = _qNo.sub(dShares);
        }
    }

    /// @dev cost(newQ) - cost(oldQ), 6-dec USDC rounded UP. Reverts on non-positive.
    function _diffCostUp(SD59x18 _qYesOld, SD59x18 _qNoOld, SD59x18 _qYesNew, SD59x18 _qNoNew)
        internal
        view
        returns (uint256)
    {
        int256 oldC = SD59x18.unwrap(_C(_qYesOld, _qNoOld));
        int256 newC = SD59x18.unwrap(_C(_qYesNew, _qNoNew));
        int256 diff = newC - oldC;
        require(diff > 0, "non-positive cost");
        return (uint256(diff) + 1e12 - 1) / 1e12;
    }

    /// @dev cost(oldQ) - cost(newQ), 6-dec USDC rounded DOWN. Reverts on non-positive.
    function _diffCostDown(SD59x18 _qYesNew, SD59x18 _qNoNew, SD59x18 _qYesOld, SD59x18 _qNoOld)
        internal
        view
        returns (uint256)
    {
        int256 oldC = SD59x18.unwrap(_C(_qYesOld, _qNoOld));
        int256 newC = SD59x18.unwrap(_C(_qYesNew, _qNoNew));
        int256 diff = oldC - newC;
        require(diff > 0, "non-positive proceeds");
        return uint256(diff) / 1e12;
    }

    /// @dev LMSR cost function: C = b · ln(exp(qY/b) + exp(qN/b))
    function _C(SD59x18 _qYes, SD59x18 _qNo) internal view returns (SD59x18) {
        SD59x18 eY = _qYes.div(b).exp();
        SD59x18 eN = _qNo.div(b).exp();
        return eY.add(eN).ln().mul(b);
    }

    /// @dev p(YES) = exp(qY/b) / (exp(qY/b) + exp(qN/b)). Returns SD59x18-unwrapped.
    function _priceYesRaw(SD59x18 _qYes, SD59x18 _qNo) internal view returns (int256) {
        SD59x18 eY = _qYes.div(b).exp();
        SD59x18 eN = _qNo.div(b).exp();
        return SD59x18.unwrap(eY.div(eY.add(eN)));
    }
}
