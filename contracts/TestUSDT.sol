// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Worthless stand-in for USDT on testnets and local chains. Anyone can mint.
contract TestUSDT is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1_000 ether; // 18 decimals, like USDT on BNB Smart Chain

    constructor() ERC20("Test USDT", "tUSDT") {}

    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
    }
}
