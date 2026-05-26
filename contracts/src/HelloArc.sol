// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Day 1 smoke test — verifies Foundry → Arc deploy + read round-trip.
contract HelloArc {
    string public greeting;
    uint256 public bumps;
    address public immutable deployer;

    event Bumped(address indexed by, uint256 newCount);

    constructor(string memory _greeting) {
        greeting = _greeting;
        deployer = msg.sender;
    }

    function bump() external returns (uint256) {
        bumps += 1;
        emit Bumped(msg.sender, bumps);
        return bumps;
    }

    function setGreeting(string calldata _greeting) external {
        require(msg.sender == deployer, "not deployer");
        greeting = _greeting;
    }
}
