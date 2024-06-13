// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.7.6;
pragma abicoder v2;

import './interfaces/IEthAfFactory.sol';

import './interfaces/modules/IEthAfPoolDeployerModule.sol';
import './NoDelegateCall.sol';

import './libraries/FactoryTokenSettings.sol';
import './libraries/PoolTokenSettings.sol';

import './interfaces/external/Blast/IBlast.sol';
import './interfaces/external/Blast/IBlastPoints.sol';


/// @title Canonical ETH AF factory
/// @notice Deploys ETH AF pools and manages ownership and control over pool protocol fees
contract EthAfFactory is IEthAfFactory, NoDelegateCall {
    /// @inheritdoc IEthAfFactory
    address public override owner;
    /// @inheritdoc IEthAfFactory
    address public override immutable poolDeployerModule;

    /// @inheritdoc IEthAfFactory
    mapping(uint24 => int24) public override feeAmountTickSpacing;
    /// @inheritdoc IEthAfFactory
    mapping(address => mapping(address => mapping(uint24 => address))) public override getPool;
    address[] internal _allPools;

    struct Parameters {
        address factory;
        address token0;
        address token1;
        uint24 fee;
        int24 tickSpacing;
        bytes32 poolTokenSettings;
    }

    Parameters public override parameters;

    struct ModuleParameters {
        address actionsModule;
        address collectModule;
        address protocolModule;
    }

    ModuleParameters public override moduleParameters;

    struct BlastParameters {
        address blast;
        address blastPoints;
        address gasCollector;
        address pointsOperator;
    }

    BlastParameters public override blastParameters;

    /// @inheritdoc IEthAfFactory
    address public override swapFeeDistributor;

    mapping(address => bytes32) public tokenSettings;
    mapping(address => mapping(address => bytes32)) public tokenPairSettings;

    constructor(
        address _poolDeployerModule,
        address _actionsModule,
        address _collectModule,
        address _protocolModule,
        address blast,
        address blastPoints,
        address gasCollector,
        address pointsOperator
    ) {
        owner = msg.sender;
        emit OwnerChanged(address(0), msg.sender);

        feeAmountTickSpacing[100] = 1;
        emit FeeAmountEnabled(100, 1);
        feeAmountTickSpacing[500] = 10;
        emit FeeAmountEnabled(500, 10);
        feeAmountTickSpacing[3000] = 60;
        emit FeeAmountEnabled(3000, 60);
        feeAmountTickSpacing[10000] = 200;
        emit FeeAmountEnabled(10000, 200);

        require(_poolDeployerModule != address(0));
        require(_actionsModule != address(0));
        require(_collectModule != address(0));
        require(_protocolModule != address(0));

        poolDeployerModule = _poolDeployerModule;
        moduleParameters.actionsModule = _actionsModule;
        moduleParameters.collectModule = _collectModule;
        moduleParameters.protocolModule = _protocolModule;

        parameters.factory = address(this);

        blastParameters.blast = blast;
        blastParameters.blastPoints = blastPoints;
        blastParameters.gasCollector = gasCollector;
        blastParameters.pointsOperator = pointsOperator;

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

    /// @inheritdoc IEthAfFactory
    function createPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external override noDelegateCall returns (address pool) {
        require(tokenA != tokenB);
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0));
        int24 tickSpacing = feeAmountTickSpacing[fee];
        require(tickSpacing != 0);
        require(getPool[token0][token1][fee] == address(0));
        pool = _deploy(token0, token1, fee, tickSpacing);
        getPool[token0][token1][fee] = pool;
        // populate mapping in the reverse direction, deliberate choice to avoid the cost of comparing addresses
        getPool[token1][token0][fee] = pool;
        _allPools.push(pool);
        emit PoolCreated(token0, token1, fee, tickSpacing, pool);
    }

    // deploys the pool
    function _deploy(address token0, address token1, uint24 fee, int24 tickSpacing) internal returns (address pool) {
        // store parameters for pool callback
        parameters.token0 = token0;
        parameters.token1 = token1;
        parameters.fee = fee;
        parameters.tickSpacing = tickSpacing;
        parameters.poolTokenSettings = _calculatePoolTokenSettings(token0, token1);
        // encode calldata
        bytes memory data = abi.encodeWithSelector(IEthAfPoolDeployerModule.deploy.selector, token0, token1, fee);
        // delegatecall into the pool deployer module
        (bool success, bytes memory returndata) = poolDeployerModule.delegatecall(data);
        require(success && returndata.length == 32);
        // decode response
        assembly { pool := mload(add(returndata, 32)) }
        require(pool != address(0));
    }

    // calculates the token settings to use in a pool with these tokens
    function _calculatePoolTokenSettings(address token0, address token1) internal view returns (bytes32 poolTokenSettings) {
        // check pair override
        poolTokenSettings = tokenPairSettings[token0][token1];
        if(poolTokenSettings != bytes32(uint256(0))) return poolTokenSettings;
        // check token settings
        bytes32 tokenSettings0 = tokenSettings[token0];
        bytes32 tokenSettings1 = tokenSettings[token1];
        poolTokenSettings = bytes32(uint256(0));
        // if only one token is USD pegged, use that as the base token
        bool isBaseTokenUSD0 = FactoryTokenSettings.isBaseTokenUSD(tokenSettings0);
        bool isBaseTokenUSD1 = FactoryTokenSettings.isBaseTokenUSD(tokenSettings1);
        if(isBaseTokenUSD0 && !isBaseTokenUSD1) {
            poolTokenSettings = PoolTokenSettings.IS_TOKEN0_BASE_TOKEN_MASK;
        }
        else if(!isBaseTokenUSD0 && isBaseTokenUSD1) {
            poolTokenSettings = PoolTokenSettings.IS_TOKEN1_BASE_TOKEN_MASK;
        }
        // if 0 or 2 are USD pegged
        else {
            // if only one token is ETH pegged, use that at the base token
            bool isBaseTokenETH0 = FactoryTokenSettings.isBaseTokenETH(tokenSettings0);
            bool isBaseTokenETH1 = FactoryTokenSettings.isBaseTokenETH(tokenSettings1);
            if(isBaseTokenETH0 && !isBaseTokenETH1) {
                poolTokenSettings = PoolTokenSettings.IS_TOKEN0_BASE_TOKEN_MASK;
            }
            else if(!isBaseTokenETH0 && isBaseTokenETH1) {
                poolTokenSettings = PoolTokenSettings.IS_TOKEN1_BASE_TOKEN_MASK;
            }
        }
        // check native yield
        bool supportsNativeYield = FactoryTokenSettings.supportsNativeYield(tokenSettings0);
        if(supportsNativeYield) poolTokenSettings = (poolTokenSettings | PoolTokenSettings.TOKEN0_SUPPORTS_NATIVE_YIELD_MASK);
        supportsNativeYield = FactoryTokenSettings.supportsNativeYield(tokenSettings1);
        if(supportsNativeYield) poolTokenSettings = (poolTokenSettings | PoolTokenSettings.TOKEN1_SUPPORTS_NATIVE_YIELD_MASK);
    }

    /// @inheritdoc IEthAfFactory
    function setOwner(address _owner) external override {
        require(msg.sender == owner);
        emit OwnerChanged(owner, _owner);
        owner = _owner;
    }

    /// @inheritdoc IEthAfFactory
    function enableFeeAmount(uint24 fee, int24 tickSpacing) public override {
        require(msg.sender == owner);
        require(fee < 1000000);
        // tick spacing is capped at 16384 to prevent the situation where tickSpacing is so large that
        // TickBitmap#nextInitializedTickWithinOneWord overflows int24 container from a valid tick
        // 16384 ticks represents a >5x price change with ticks of 1 bips
        require(tickSpacing > 0 && tickSpacing < 16384);
        require(feeAmountTickSpacing[fee] == 0);

        feeAmountTickSpacing[fee] = tickSpacing;
        emit FeeAmountEnabled(fee, tickSpacing);
    }

    /// @inheritdoc IEthAfFactory
    function allPoolsLength() external view override returns (uint256 len) {
        len = _allPools.length;
    }

    /// @inheritdoc IEthAfFactory
    function allPools(uint256 index) external view override returns (address pool) {
        require(index < _allPools.length, "index too high");
        pool = _allPools[index];
    }

    function getTokenSettings(address token) external view returns (
        bool isBaseTokenUSD,
        bool isBaseTokenETH
    ) {
        bytes32 settings = tokenSettings[token];
        isBaseTokenUSD = FactoryTokenSettings.isBaseTokenUSD(settings);
        isBaseTokenETH = FactoryTokenSettings.isBaseTokenETH(settings);
    }

    function setTokenSettings(SetTokenSettingsParam[] calldata params) external override {
        require(msg.sender == owner);
        for(uint256 i = 0; i < params.length; ++i) {
            address token = params[i].token;
            bytes32 settings = params[i].settings;
            tokenSettings[token] = settings;
            emit TokenSettingsSet(token, settings);
        }
    }

    function setTokenPairSettings(SetTokenPairSettingsParam[] calldata params) external override {
        require(msg.sender == owner);
        for(uint256 i = 0; i < params.length; ++i) {
            address token0 = params[i].token0;
            address token1 = params[i].token1;
            bytes32 settings = params[i].settings;
            tokenPairSettings[token0][token1] = settings; // only populate forward direction
            emit TokenPairSettingsSet(token0, token1, settings);
        }
    }

    function setSwapFeeDistributor(address distributor) external override {
        require(msg.sender == owner);
        swapFeeDistributor = distributor;
        emit SwapFeeDistributorSet(distributor);
    }
}
