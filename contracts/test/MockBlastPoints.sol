// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;

import './../interfaces/external/Blast/IBlastPoints.sol';


/// @title MockBlastPoints
/// @notice A mock version of the blast points contract. Only used to test other contracts.
contract MockBlastPoints is IBlastPoints {

    mapping(address => address) internal _operators;

    function configurePointsOperator(address operator) external override {
        _operators[msg.sender] = operator;
    }

    function configurePointsOperatorOnBehalf(address contractAddress, address operator) external override {}

    // mainnet
    function operators(address contractAddress) external override view returns (address operator) {
        return _operators[contractAddress];
    }

    // testnet
    function operatorMap(address contractAddress) external override view returns (address operator) {
        return _operators[contractAddress];
    }
}
