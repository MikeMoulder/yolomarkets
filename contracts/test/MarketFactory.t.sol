// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MarketFactory} from "../src/MarketFactory.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

contract MarketFactoryTest is Test {
    MockUSDC internal usdc;
    MarketFactory internal factory;

    address internal admin = address(0xA);
    address internal stranger = address(0xB0B);

    uint256 internal constant SEED = 100e6;

    function setUp() public {
        usdc = new MockUSDC();
        factory = new MarketFactory(usdc, admin);

        // Admin holds plenty of USDC and pre-approves the factory.
        usdc.mint(admin, 10_000e6);
        vm.prank(admin);
        usdc.approve(address(factory), type(uint256).max);
    }

    // ── Create ──────────────────────────────────────────────────────────────

    function _create(
        string memory q,
        uint256 horizon
    ) internal returns (address) {
        uint256 deadline = block.timestamp + horizon;
        vm.prank(admin);
        return
            factory.createMarket(
                q,
                "Crypto",
                "Resolves YES iff ...",
                deadline,
                SEED
            );
    }

    function test_createMarketDeploysAndRegisters() public {
        address m = _create("Q1?", 7 days);
        assertTrue(m != address(0));
        assertTrue(factory.isMarket(m));
        assertEq(factory.marketCount(), 1);
        assertEq(factory.markets(0), m);
        assertEq(factory.marketIndex(m), 1);
    }

    function test_createMarketSeedsCorrectly() public {
        address m = _create("Q2?", 5 days);
        PredictionMarket mkt = PredictionMarket(m);

        assertEq(mkt.initialLiquidity(), SEED);
        assertEq(mkt.totalLiquidity(), SEED);
        assertEq(usdc.balanceOf(m), SEED);
        assertEq(mkt.admin(), address(factory)); // factory is market admin
        assertEq(mkt.question(), "Q2?");
        // Price at qY=qN=0 is 0.5
        assertApproxEqAbs(mkt.priceYes(), 0.5e18, 1e6);
    }

    function test_predictMarketMatchesActual() public {
        uint256 deadline = block.timestamp + 3 days;
        address predicted = factory.predictMarket(
            "Q3?",
            "Tech",
            "criteria",
            deadline,
            SEED
        );
        vm.prank(admin);
        address actual = factory.createMarket(
            "Q3?",
            "Tech",
            "criteria",
            deadline,
            SEED
        );
        assertEq(actual, predicted);
    }

    function test_createMarketByStrangerReverts() public {
        vm.prank(stranger);
        vm.expectRevert(MarketFactory.NotAdmin.selector);
        factory.createMarket("Q?", "C", "R", block.timestamp + 1 days, SEED);
    }

    function test_duplicateQuestionAndDeadlineReverts() public {
        // Same (question, deadline) → same CREATE2 salt → collision
        uint256 deadline = block.timestamp + 2 days;
        vm.prank(admin);
        factory.createMarket("Same Q?", "C", "R", deadline, SEED);
        vm.prank(admin);
        vm.expectRevert(); // Create2 reverts on collision
        factory.createMarket("Same Q?", "C", "R", deadline, SEED);
    }

    function test_sameQuestionDifferentDeadlineOk() public {
        vm.startPrank(admin);
        factory.createMarket("Q?", "C", "R", block.timestamp + 1 days, SEED);
        factory.createMarket("Q?", "C", "R", block.timestamp + 2 days, SEED);
        vm.stopPrank();
        assertEq(factory.marketCount(), 2);
    }

    // ── Resolve ─────────────────────────────────────────────────────────────

    function test_factoryResolvesMarket() public {
        address m = _create("Q?", 1 days);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(admin);
        factory.resolveMarket(m, PredictionMarket.Outcome.Yes);

        PredictionMarket mkt = PredictionMarket(m);
        assertTrue(mkt.resolved());
        assertEq(uint8(mkt.outcome()), uint8(PredictionMarket.Outcome.Yes));
    }

    function test_resolveByStrangerReverts() public {
        address m = _create("Q?", 1 days);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(stranger);
        vm.expectRevert(MarketFactory.NotAdmin.selector);
        factory.resolveMarket(m, PredictionMarket.Outcome.Yes);
    }

    function test_factoryCancelsMarket() public {
        address m = _create("Q?", 1 days);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(admin);
        factory.resolveMarket(m, PredictionMarket.Outcome.Cancelled);

        PredictionMarket mkt = PredictionMarket(m);
        assertTrue(mkt.resolved());
        assertEq(
            uint8(mkt.outcome()),
            uint8(PredictionMarket.Outcome.Cancelled)
        );
        assertEq(mkt.treasuryWithdrawable(), SEED);
    }

    function test_resolveUnknownMarketReverts() public {
        vm.warp(block.timestamp + 1 days);
        vm.prank(admin);
        vm.expectRevert(MarketFactory.UnknownMarket.selector);
        factory.resolveMarket(address(0xdead), PredictionMarket.Outcome.Yes);
    }

    function test_directMarketResolveByStrangerReverts() public {
        // Market admin is the factory now — even the factory's admin can't
        // call market.resolve() directly.
        address m = _create("Q?", 1 days);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(admin);
        vm.expectRevert(PredictionMarket.NotAdmin.selector);
        PredictionMarket(m).resolve(PredictionMarket.Outcome.Yes);
    }

    // ── Admin transfer ──────────────────────────────────────────────────────

    function test_setAdmin() public {
        vm.prank(admin);
        factory.setAdmin(stranger);
        assertEq(factory.admin(), stranger);

        // New admin can now create markets (with their own USDC + approval)
        usdc.mint(stranger, SEED);
        vm.prank(stranger);
        usdc.approve(address(factory), type(uint256).max);
        vm.prank(stranger);
        factory.createMarket("New?", "C", "R", block.timestamp + 1 days, SEED);
        assertEq(factory.marketCount(), 1);
    }

    function test_setAdminRejectsZero() public {
        vm.prank(admin);
        vm.expectRevert(bytes("zero admin"));
        factory.setAdmin(address(0));
    }

    function test_setAdminByStrangerReverts() public {
        vm.prank(stranger);
        vm.expectRevert(MarketFactory.NotAdmin.selector);
        factory.setAdmin(stranger);
    }

    // ── End-to-end ──────────────────────────────────────────────────────────

    function test_e2e_createBuyResolveClaim() public {
        address m = _create("BTC > 100k?", 1 days);
        PredictionMarket mkt = PredictionMarket(m);

        // Alice buys 10 USDC of YES
        address alice = address(0xA11CE);
        usdc.mint(alice, 100e6);
        vm.prank(alice);
        usdc.approve(m, type(uint256).max);
        vm.prank(alice);
        mkt.buy(PredictionMarket.Outcome.Yes, 10e6, 10e6);

        // Time passes; admin resolves via factory
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(admin);
        factory.resolveMarket(m, PredictionMarket.Outcome.Yes);

        // Alice claims 10 USDC
        uint256 balBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 claimed = mkt.claim();
        assertEq(claimed, 10e6);
        assertEq(usdc.balanceOf(alice) - balBefore, 10e6);
    }
}
