// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {HelloArc} from "../src/HelloArc.sol";

contract HelloArcTest is Test {
    HelloArc internal hello;
    address internal owner = address(0xA11CE);
    address internal other = address(0xB0B);

    function setUp() public {
        vm.prank(owner);
        hello = new HelloArc("gm arc");
    }

    function test_initialState() public view {
        assertEq(hello.greeting(), "gm arc");
        assertEq(hello.bumps(), 0);
        assertEq(hello.deployer(), owner);
    }

    function test_bumpIncrements() public {
        assertEq(hello.bump(), 1);
        assertEq(hello.bump(), 2);
        assertEq(hello.bumps(), 2);
    }

    function test_setGreetingByDeployer() public {
        vm.prank(owner);
        hello.setGreeting("hello arc testnet");
        assertEq(hello.greeting(), "hello arc testnet");
    }

    function test_setGreetingRejectsStranger() public {
        vm.prank(other);
        vm.expectRevert(bytes("not deployer"));
        hello.setGreeting("nope");
    }
}
