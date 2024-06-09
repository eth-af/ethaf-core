// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;

import './../interfaces/external/Blast/IERC20Rebasing.sol';
import './TestERC20.sol';

/// @title MockERC20Rebasing
/// @notice A mock version of an ERC20Rebasing token (USDB and WETH)
contract MockERC20Rebasing is IERC20Rebasing, TestERC20 {

    uint256 public claimableAmount;
    mapping(address => YieldMode) public userModes;

    constructor(uint256 amountToMint) TestERC20(amountToMint) {}

    // changes the yield mode of the caller and update the balance
    // to reflect the configuration
    function configure(YieldMode mode) external override returns (uint256) {
        userModes[msg.sender] = mode;
        return 0; // ?
    }

    function claim(
        address recipient,
        uint256 amount
    ) external override returns (uint256) {
        require(msg.sender == recipient);
        require(amount <= claimableAmount);
        require(userModes[recipient] == YieldMode.CLAIMABLE);
        mint(recipient, amount);
    }

    // read the claimable amount for an account
    function getClaimableAmount(
        address account
    ) external view override returns (uint256) {
        if(userModes[account] != YieldMode.CLAIMABLE) return 0;
        return claimableAmount;
    }

    function setClaimableAmount(uint256 amount) external {
        claimableAmount = amount;
    }
}
