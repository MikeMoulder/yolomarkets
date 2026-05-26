// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {HelloArc} from "../src/HelloArc.sol";

contract DeployHelloArc is Script {
    function run() external returns (HelloArc hello) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(pk);
        hello = new HelloArc("gm arc");
        vm.stopBroadcast();
        console2.log("HelloArc deployed to:", address(hello));
        console2.log("deployer:", vm.addr(pk));
    }
}
