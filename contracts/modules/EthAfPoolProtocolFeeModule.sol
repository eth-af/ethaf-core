// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

import './../interfaces/pool/IEthAfPoolEvents.sol';

import './../libraries/LowGasSafeMath.sol';
import './../libraries/SafeCast.sol';
import './../libraries/Tick.sol';
import './../libraries/TickBitmap.sol';
import './../libraries/Position.sol';
import './../libraries/Oracle.sol';

import './../libraries/TransferHelper.sol';

import './../interfaces/external/Blast/IBlast.sol';
import './../interfaces/external/Blast/IBlastPoints.sol';
import './../interfaces/modules/IEthAfPoolProtocolFeeModule.sol';


/// @title The ETH AF Pool Protocol Fee Module
/// @notice The ETH AF pool protocol fee module contains the logic enabling and collecting protocol level fees
/// @dev Do NOT call this contract directly. The EthAfPools delegate call into this module
contract EthAfPoolProtocolFeeModule is IEthAfPoolProtocolFeeModule, IEthAfPoolEvents {
    using LowGasSafeMath for uint256;
    using LowGasSafeMath for int256;
    using SafeCast for uint256;
    using SafeCast for int256;
    using Tick for mapping(int24 => Tick.Info);
    using TickBitmap for mapping(int16 => uint256);
    using Position for mapping(bytes32 => Position.Info);
    using Position for Position.Info;
    using Oracle for Oracle.Observation[65535];

    struct Slot0 {
        // the current price
        uint160 sqrtPriceX96;
        // the current tick
        int24 tick;
        // the most-recently updated index of the observations array
        uint16 observationIndex;
        // the current maximum number of observations that are being stored
        uint16 observationCardinality;
        // the next maximum number of observations to store, triggered in observations.write
        uint16 observationCardinalityNext;
        // the current protocol fee as a percentage of the swap fee taken on withdrawal
        // represented as an integer denominator (1/x)%
        uint8 feeProtocol;
        // whether the pool is locked
        bool unlocked;
    }

    // accumulated protocol fees in token0/token1 units
    struct ProtocolFees {
        uint128 token0;
        uint128 token1;
    }

    // accumalated base tokens in token0/token1 units
    struct BaseTokensAccumulated {
        uint256 amount0;
        uint256 amount1;
    }

    // storage slots
    bytes32 internal constant SLOT_0_SLOT                  = bytes32(uint256(0));
    bytes32 internal constant FEE_GROWTH_GLOBAL_0_SLOT     = bytes32(uint256(1));
    bytes32 internal constant FEE_GROWTH_GLOBAL_1_SLOT     = bytes32(uint256(2));
    bytes32 internal constant PROTOCOL_FEES_SLOT           = bytes32(uint256(3));
    bytes32 internal constant LIQUIDITY_SLOT               = bytes32(uint256(4));
    bytes32 internal constant TICKS_SLOT                   = bytes32(uint256(5));
    bytes32 internal constant TICK_BITMAP_SLOT             = bytes32(uint256(6));
    bytes32 internal constant POSITIONS_SLOT               = bytes32(uint256(7));
    bytes32 internal constant OBSERVATIONS_SLOT            = bytes32(uint256(8));
    bytes32 internal constant BASE_TOKENS_ACCUMULATED_SLOT = keccak256("ethaf.pool.storage.basetokenacc");

    // constructor

    constructor(
        address blast,
        address blastPoints,
        address gasCollector,
        address pointsOperator
    ) {
        // calls to setup blast
        if(blast != address(0)) {
            IBlast(blast).configureClaimableGas();
            if(gasCollector != address(0)) {
                IBlast(blast).configureGovernor(gasCollector);
            }

        }
        if(blastPoints != address(0) && pointsOperator != address(0)) {
            IBlastPoints(blastPoints).configurePointsOperator(pointsOperator);
        }
    }

    // mutator functions
    // these may or may not have the same signature as the related function on the pool

    /// @inheritdoc IEthAfPoolProtocolFeeModule
    function setFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) external override {
        require(
            (feeProtocol0 == 0 || (feeProtocol0 >= 4 && feeProtocol0 <= 10)) &&
                (feeProtocol1 == 0 || (feeProtocol1 >= 4 && feeProtocol1 <= 10))
        );
        Slot0 storage _slot0 = getSlot0();
        uint8 feeProtocolOld = _slot0.feeProtocol;
        _slot0.feeProtocol = feeProtocol0 + (feeProtocol1 << 4);
        emit SetFeeProtocol(feeProtocolOld % 16, feeProtocolOld >> 4, feeProtocol0, feeProtocol1);
    }

    /// @inheritdoc IEthAfPoolProtocolFeeModule
    function collectProtocol(
        address recipient,
        uint128 amount0Requested,
        uint128 amount1Requested,
        address token0,
        address token1
    ) external override returns (uint128 amount0, uint128 amount1) {
        ProtocolFees storage _protocolFees = getProtocolFees();
        amount0 = amount0Requested > _protocolFees.token0 ? _protocolFees.token0 : amount0Requested;
        amount1 = amount1Requested > _protocolFees.token1 ? _protocolFees.token1 : amount1Requested;

        if (amount0 > 0) {
            if (amount0 == _protocolFees.token0) amount0--; // ensure that the slot is not cleared, for gas savings
            _protocolFees.token0 -= amount0;
            TransferHelper.safeTransfer(token0, recipient, amount0);
        }
        if (amount1 > 0) {
            if (amount1 == _protocolFees.token1) amount1--; // ensure that the slot is not cleared, for gas savings
            _protocolFees.token1 -= amount1;
            TransferHelper.safeTransfer(token1, recipient, amount1);
        }

        emit CollectProtocol(msg.sender, recipient, amount0, amount1);
    }

    // helper functions

    // dev: these are required because the module cannot access the global storage variables by name

    /// @dev Gets the storage pointer for slot0
    function getSlot0() internal pure returns (Slot0 storage _slot0) {
        bytes32 position = SLOT_0_SLOT;
        assembly {
            _slot0.slot := position
        }
    }

    /// @dev Gets the storage pointer for protocolFees
    function getProtocolFees() internal pure returns (ProtocolFees storage _fees) {
        bytes32 position = PROTOCOL_FEES_SLOT;
        assembly {
            _fees.slot := position
        }
    }
}
