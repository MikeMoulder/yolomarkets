// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {AgentAccountFactory} from "../src/AgentAccountFactory.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}
    function decimals() public pure override returns (uint8) {
        return 6;
    }
    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// Stand-in for PredictionMarket so we can craft realistic buy() calldata
/// and verify the session-permission cost extraction works.
contract MockMarket {
    uint256 public lastSide;
    uint256 public lastShares;
    uint256 public lastMaxCost;
    address public lastCaller;

    function buy(uint8 side, uint256 shares, uint256 maxCost) external returns (uint256) {
        lastSide = side;
        lastShares = shares;
        lastMaxCost = maxCost;
        lastCaller = msg.sender;
        return maxCost;
    }

    /// Same selector signature as buy(uint8,uint256,uint256) so we can also
    /// verify selector matching is exact.
    function notBuy(uint256 x) external pure returns (uint256) {
        return x;
    }
}

contract AgentAccountTest is Test {
    MockUSDC internal usdc;
    AgentAccountFactory internal factory;
    MockMarket internal market;
    MockMarket internal otherMarket;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal sessionKey = address(0x5E55);

    function setUp() public {
        usdc = new MockUSDC();
        factory = new AgentAccountFactory(usdc);
        market = new MockMarket();
        otherMarket = new MockMarket();
    }

    function _deploy() internal returns (AgentAccount) {
        return AgentAccount(payable(factory.deploy(alice)));
    }

    /// Grant a permission with sensible defaults — full access to MockMarket's
    /// buy() selector, $50 lifetime cap, $5 per call, 1-hour expiry.
    function _grantBuyPermission(AgentAccount a) internal {
        vm.prank(alice);
        a.grantSession(
            sessionKey,
            uint64(block.timestamp + 1 hours),
            uint128(50e6),                  // $50 total
            uint128(5e6),                   // $5 per call
            address(market),                 // only this market
            bytes4(keccak256("buy(uint8,uint256,uint256)"))
        );
    }

    function _buyCalldata(uint256 maxCost) internal pure returns (bytes memory) {
        return abi.encodeWithSignature(
            "buy(uint8,uint256,uint256)",
            uint8(1),
            uint256(1000),
            maxCost
        );
    }

    // ── Factory parity (unchanged from Phase 2) ─────────────────────────────

    function test_predictMatchesDeploy() public {
        address predicted = factory.predict(alice);
        address deployed = factory.deploy(alice);
        assertEq(deployed, predicted, "CREATE2 mismatch");
        assertEq(factory.accountOf(alice), deployed);
    }

    function test_oneAccountPerOwner() public {
        factory.deploy(alice);
        vm.expectRevert(AgentAccountFactory.AlreadyDeployed.selector);
        factory.deploy(alice);
    }

    // ── Ownership (unchanged) ───────────────────────────────────────────────

    function test_constructorSetsOwner() public {
        AgentAccount a = _deploy();
        assertEq(a.owner(), alice);
    }

    function test_setOwnerByOwnerOnly() public {
        AgentAccount a = _deploy();
        vm.prank(alice);
        a.setOwner(bob);
        assertEq(a.owner(), bob);
    }

    function test_setOwnerByStrangerReverts() public {
        AgentAccount a = _deploy();
        vm.prank(bob);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        a.setOwner(bob);
    }

    // ── Owner execute (unchanged) ───────────────────────────────────────────

    function test_executeByOwner() public {
        AgentAccount a = _deploy();
        vm.prank(alice);
        a.execute(address(market), 0, _buyCalldata(1e6));
        assertEq(market.lastMaxCost(), 1e6);
        assertEq(market.lastCaller(), address(a));
    }

    function test_executeByStrangerReverts() public {
        AgentAccount a = _deploy();
        vm.prank(bob);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        a.execute(address(market), 0, _buyCalldata(1e6));
    }

    // ── Session: grant + revoke + isSessionLive view ────────────────────────

    function test_grantSessionStoresPermission() public {
        AgentAccount a = _deploy();
        _grantBuyPermission(a);
        assertTrue(a.isSessionLive(sessionKey));
        (
            uint64 validUntil,
            uint128 totalCap,
            uint128 totalSpent,
            uint128 perCallCap,
            address allowedTarget,
            bytes4 allowedSelector
        ) = a.sessions(sessionKey);
        assertEq(validUntil, uint64(block.timestamp + 1 hours));
        assertEq(totalCap, 50e6);
        assertEq(totalSpent, 0);
        assertEq(perCallCap, 5e6);
        assertEq(allowedTarget, address(market));
        assertEq(allowedSelector, bytes4(keccak256("buy(uint8,uint256,uint256)")));
    }

    function test_grantSessionResetsTotalSpent() public {
        AgentAccount a = _deploy();
        _grantBuyPermission(a);

        // burn some cap
        vm.prank(sessionKey);
        a.execute(address(market), 0, _buyCalldata(3e6));
        (,, uint128 spent1,,,) = a.sessions(sessionKey);
        assertEq(spent1, 3e6);

        // re-grant → spent resets
        _grantBuyPermission(a);
        (,, uint128 spent2,,,) = a.sessions(sessionKey);
        assertEq(spent2, 0);
    }

    function test_grantSessionByStrangerReverts() public {
        AgentAccount a = _deploy();
        vm.prank(bob);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        a.grantSession(sessionKey, 1, 1, 1, address(0), bytes4(0));
    }

    function test_grantZeroKeyReverts() public {
        AgentAccount a = _deploy();
        vm.prank(alice);
        vm.expectRevert(AgentAccount.ZeroAddress.selector);
        a.grantSession(address(0), 1, 1, 1, address(0), bytes4(0));
    }

    function test_revokeSessionClearsPermission() public {
        AgentAccount a = _deploy();
        _grantBuyPermission(a);
        vm.prank(alice);
        a.revokeSession(sessionKey);
        assertFalse(a.isSessionLive(sessionKey));

        vm.prank(sessionKey);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        a.execute(address(market), 0, _buyCalldata(1e6));
    }

    function test_revokeByStrangerReverts() public {
        AgentAccount a = _deploy();
        _grantBuyPermission(a);
        vm.prank(bob);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        a.revokeSession(sessionKey);
    }

    // ── Session: execute path ───────────────────────────────────────────────

    function test_sessionCanExecuteAllowedCall() public {
        AgentAccount a = _deploy();
        _grantBuyPermission(a);

        vm.prank(sessionKey);
        a.execute(address(market), 0, _buyCalldata(2_500_000));
        assertEq(market.lastMaxCost(), 2_500_000);
        assertEq(market.lastCaller(), address(a));

        (,, uint128 spent,,,) = a.sessions(sessionKey);
        assertEq(spent, 2_500_000);
    }

    function test_sessionPerCallCapExceededReverts() public {
        AgentAccount a = _deploy();
        _grantBuyPermission(a); // $5 per-call cap

        vm.prank(sessionKey);
        vm.expectRevert(AgentAccount.PerCallCapExceeded.selector);
        a.execute(address(market), 0, _buyCalldata(6e6));
    }

    function test_sessionTotalCapExceededAcrossCalls() public {
        AgentAccount a = _deploy();
        _grantBuyPermission(a); // $50 total, $5 per call

        // 10 successful calls at $5 each → totalSpent = $50, still within cap
        for (uint256 i; i < 10; ++i) {
            vm.prank(sessionKey);
            a.execute(address(market), 0, _buyCalldata(5e6));
        }
        (,, uint128 spent,,,) = a.sessions(sessionKey);
        assertEq(spent, 50e6);

        // 11th call of any positive cost should breach total cap
        vm.prank(sessionKey);
        vm.expectRevert(AgentAccount.TotalCapExceeded.selector);
        a.execute(address(market), 0, _buyCalldata(1));
    }

    function test_sessionExpiredReverts() public {
        AgentAccount a = _deploy();
        _grantBuyPermission(a);
        vm.warp(block.timestamp + 2 hours);

        vm.prank(sessionKey);
        vm.expectRevert(AgentAccount.SessionExpired.selector);
        a.execute(address(market), 0, _buyCalldata(1e6));
    }

    function test_sessionTargetNotAllowedReverts() public {
        AgentAccount a = _deploy();
        _grantBuyPermission(a); // allowedTarget = market

        vm.prank(sessionKey);
        vm.expectRevert(AgentAccount.TargetNotAllowed.selector);
        a.execute(address(otherMarket), 0, _buyCalldata(1e6));
    }

    function test_sessionAnyTargetAllowedWhenZero() public {
        AgentAccount a = _deploy();
        vm.prank(alice);
        a.grantSession(
            sessionKey,
            uint64(block.timestamp + 1 hours),
            50e6,
            5e6,
            address(0),   // any target
            bytes4(keccak256("buy(uint8,uint256,uint256)"))
        );

        vm.prank(sessionKey);
        a.execute(address(otherMarket), 0, _buyCalldata(1e6));
        assertEq(otherMarket.lastCaller(), address(a));
    }

    function test_sessionSelectorNotAllowedReverts() public {
        AgentAccount a = _deploy();
        _grantBuyPermission(a); // allowedSelector = buy(...)

        bytes memory data = abi.encodeWithSignature("notBuy(uint256)", uint256(1));
        vm.prank(sessionKey);
        vm.expectRevert(AgentAccount.SelectorNotAllowed.selector);
        a.execute(address(market), 0, data);
    }

    function test_sessionAnySelectorAllowedWhenZero() public {
        AgentAccount a = _deploy();
        vm.prank(alice);
        a.grantSession(
            sessionKey,
            uint64(block.timestamp + 1 hours),
            50e6,
            5e6,
            address(market),
            bytes4(0) // any selector
        );

        bytes memory data = abi.encodeWithSignature("notBuy(uint256)", uint256(42));
        vm.prank(sessionKey);
        bytes memory ret = a.execute(address(market), 0, data);
        assertEq(abi.decode(ret, (uint256)), 42);

        // notBuy doesn't match BUY_SELECTOR, so no cost is metered
        (,, uint128 spent,,,) = a.sessions(sessionKey);
        assertEq(spent, 0);
    }

    function test_sessionCannotWithdraw() public {
        AgentAccount a = _deploy();
        _grantBuyPermission(a);
        usdc.mint(address(a), 100e6);

        vm.prank(sessionKey);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        a.withdraw(usdc, 1, sessionKey);
    }

    function test_sessionCannotGrantOthers() public {
        AgentAccount a = _deploy();
        _grantBuyPermission(a);

        vm.prank(sessionKey);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        a.grantSession(address(0xBEEF), 1, 1, 1, address(0), bytes4(0));
    }

    function test_sessionCannotChangeOwner() public {
        AgentAccount a = _deploy();
        _grantBuyPermission(a);
        vm.prank(sessionKey);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        a.setOwner(sessionKey);
    }

    // ── Withdraw (unchanged) ────────────────────────────────────────────────

    function test_withdrawUsdcByOwner() public {
        AgentAccount a = _deploy();
        usdc.mint(address(a), 100e6);
        vm.prank(alice);
        a.withdraw(usdc, 40e6, alice);
        assertEq(usdc.balanceOf(alice), 40e6);
    }

    function test_withdrawByStrangerReverts() public {
        AgentAccount a = _deploy();
        usdc.mint(address(a), 100e6);
        vm.prank(bob);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        a.withdraw(usdc, 1, bob);
    }

    // ── Batch ───────────────────────────────────────────────────────────────

    function test_executeBatchAuthsEachCall() public {
        AgentAccount a = _deploy();
        _grantBuyPermission(a);

        address[] memory ts = new address[](2);
        uint256[] memory vs = new uint256[](2);
        bytes[] memory ds = new bytes[](2);
        ts[0] = address(market); ts[1] = address(market);
        vs[0] = 0; vs[1] = 0;
        ds[0] = _buyCalldata(2e6);
        ds[1] = _buyCalldata(3e6);

        vm.prank(sessionKey);
        a.executeBatch(ts, vs, ds);

        (,, uint128 spent,,,) = a.sessions(sessionKey);
        assertEq(spent, 5e6);
    }

    function test_executeBatchRevertsIfAnyCallUnauthorized() public {
        AgentAccount a = _deploy();
        _grantBuyPermission(a);

        address[] memory ts = new address[](2);
        uint256[] memory vs = new uint256[](2);
        bytes[] memory ds = new bytes[](2);
        ts[0] = address(market); ts[1] = address(otherMarket);
        vs[0] = 0; vs[1] = 0;
        ds[0] = _buyCalldata(1e6);
        ds[1] = _buyCalldata(1e6);

        vm.prank(sessionKey);
        vm.expectRevert(AgentAccount.TargetNotAllowed.selector);
        a.executeBatch(ts, vs, ds);
    }

    function test_executeBatchLengthMismatchReverts() public {
        AgentAccount a = _deploy();
        address[] memory ts = new address[](2);
        uint256[] memory vs = new uint256[](1);
        bytes[] memory ds = new bytes[](2);
        vm.prank(alice);
        vm.expectRevert(AgentAccount.LengthMismatch.selector);
        a.executeBatch(ts, vs, ds);
    }

    // ── Auto-approve before buy ─────────────────────────────────────────────

    function test_executeSetsAllowanceBeforeBuy() public {
        AgentAccount a = _deploy();
        _grantBuyPermission(a);
        usdc.mint(address(a), 100e6);
        assertEq(usdc.allowance(address(a), address(market)), 0);

        vm.prank(sessionKey);
        a.execute(address(market), 0, _buyCalldata(3_500_000));

        assertEq(usdc.allowance(address(a), address(market)), 3_500_000);
    }

    function test_executeReApprovesOnSecondCall() public {
        AgentAccount a = _deploy();
        _grantBuyPermission(a);
        usdc.mint(address(a), 100e6);

        vm.prank(sessionKey);
        a.execute(address(market), 0, _buyCalldata(2e6));
        assertEq(usdc.allowance(address(a), address(market)), 2e6);

        // forceApprove handles non-zero-allowance reset cleanly
        vm.prank(sessionKey);
        a.execute(address(market), 0, _buyCalldata(4e6));
        assertEq(usdc.allowance(address(a), address(market)), 4e6);
    }

    function test_executeDoesNotApproveForNonBuy() public {
        AgentAccount a = _deploy();
        vm.prank(alice);
        a.grantSession(
            sessionKey,
            uint64(block.timestamp + 1 hours),
            50e6,
            5e6,
            address(market),
            bytes4(0) // any selector
        );

        bytes memory data = abi.encodeWithSignature("notBuy(uint256)", uint256(42));
        vm.prank(sessionKey);
        a.execute(address(market), 0, data);

        assertEq(usdc.allowance(address(a), address(market)), 0);
    }

    // ── Receive ─────────────────────────────────────────────────────────────

    function test_receivesEther() public {
        AgentAccount a = _deploy();
        (bool ok,) = address(a).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(a).balance, 1 ether);
    }
}
