// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";

contract DeployPredictionMarket is Script {
    function run() external returns (PredictionMarket market) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address usdcAddr = vm.envAddress("USDC_ADDRESS");
        address deployer = vm.addr(pk);

        // Tunable via env if you want to override at deploy time.
        uint256 seed = vm.envOr("MARKET_SEED_USDC", uint256(5e6)); // 5 USDC
        uint256 horizon = vm.envOr("MARKET_HORIZON_SECONDS", uint256(7 days));
        string memory question = vm.envOr(
            "MARKET_QUESTION",
            string("Will BTC close above $100,000 on the next NYSE trading day?")
        );
        string memory category = vm.envOr("MARKET_CATEGORY", string("Crypto"));
        string memory criteria = vm.envOr(
            "MARKET_RESOLUTION",
            string("Resolves YES iff BTC/USD close per Coinbase Spot index >= $100,000.")
        );

        IERC20 usdc = IERC20(usdcAddr);

        vm.startBroadcast(pk);

        // Approve the about-to-be-deployed market to pull `seed` USDC.
        // Address is deterministic via deployer's nonce.
        address pre = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        usdc.approve(pre, seed);

        market = new PredictionMarket(
            usdc,
            deployer, // admin = deployer (treasury wallet also resolves)
            block.timestamp + horizon,
            seed,
            question,
            category,
            criteria
        );
        vm.stopBroadcast();

        console2.log("PredictionMarket deployed to:", address(market));
        console2.log("Predicted address (pre-approve):", pre);
        console2.log("Deployer / admin:", deployer);
        console2.log("USDC seed (6-dec):", seed);
        console2.log("Deadline:", block.timestamp + horizon);
    }
}
