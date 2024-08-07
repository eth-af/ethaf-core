// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;
pragma abicoder v2;

/// @title The interface for the ETH AF Factory
/// @notice The ETH AF Factory facilitates creation of ETH AF pools and control over the protocol fees
interface IEthAfFactory {
    /// @notice Emitted when the owner of the factory is changed
    /// @param oldOwner The owner before the owner was changed
    /// @param newOwner The owner after the owner was changed
    event OwnerChanged(address indexed oldOwner, address indexed newOwner);

    /// @notice Emitted when a pool is created
    /// @param token0 The first token of the pool by address sort order
    /// @param token1 The second token of the pool by address sort order
    /// @param fee The fee collected upon every swap in the pool, denominated in hundredths of a bip
    /// @param tickSpacing The minimum number of ticks between initialized ticks
    /// @param pool The address of the created pool
    event PoolCreated(
        address indexed token0,
        address indexed token1,
        uint24 indexed fee,
        int24 tickSpacing,
        address pool
    );

    /// @notice Emitted when a new fee amount is enabled for pool creation via the factory
    /// @param fee The enabled fee, denominated in hundredths of a bip
    /// @param tickSpacing The minimum number of ticks between initialized ticks for pools created with the given fee
    event FeeAmountEnabled(uint24 indexed fee, int24 indexed tickSpacing);

    /// @notice Emitted when the settings are set for a token
    /// @param token The token address
    /// @param settings The token settings bytes encoded
    event TokenSettingsSet(address indexed token, bytes32 settings);

    /// @notice Emitted when the settings are set for a pair of tokens
    /// @param token0 The token0 address
    /// @param token1 The token1 address
    /// @param settings The pair settings bytes encoded
    event TokenPairSettingsSet(address indexed token0, address indexed token1, bytes32 settings);

    /// @notice Emitted when the swap fee distributor is set
    /// @param distributor The swap fee distribtor
    event SwapFeeDistributorSet(address indexed distributor);

    /// @notice Returns the current owner of the factory
    /// @dev Can be changed by the current owner via setOwner
    /// @return The address of the factory owner
    function owner() external view returns (address);

    /// @notice Returns the swap fee distributor
    /// @return The address of the swap fee distributor
    function swapFeeDistributor() external view returns (address);

    /// @notice Returns the pool deployer module
    /// @return The address of the pool deployer module
    function poolDeployerModule() external view returns (address);

    /// @notice Returns the tick spacing for a given fee amount, if enabled, or 0 if not enabled
    /// @dev A fee amount can never be removed, so this value should be hard coded or cached in the calling context
    /// @param fee The enabled fee, denominated in hundredths of a bip. Returns 0 in case of unenabled fee
    /// @return The tick spacing
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);

    /// @notice Returns the pool address for a given pair of tokens and a fee, or address 0 if it does not exist
    /// @dev tokenA and tokenB may be passed in either token0/token1 or token1/token0 order
    /// @param tokenA The contract address of either token0 or token1
    /// @param tokenB The contract address of the other token
    /// @param fee The fee collected upon every swap in the pool, denominated in hundredths of a bip
    /// @return pool The pool address
    function getPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external view returns (address pool);

    /// @notice Creates a pool for the given two tokens and fee
    /// @param tokenA One of the two tokens in the desired pool
    /// @param tokenB The other of the two tokens in the desired pool
    /// @param fee The desired fee for the pool
    /// @dev tokenA and tokenB may be passed in either order: token0/token1 or token1/token0. tickSpacing is retrieved
    /// from the fee. The call will revert if the pool already exists, the fee is invalid, or the token arguments
    /// are invalid.
    /// @return pool The address of the newly created pool
    function createPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external returns (address pool);

    /// @notice Get the parameters to be used in constructing the pool, set transiently during pool creation.
    /// @dev Called by the pool constructor to fetch the parameters of the pool
    /// Returns factory The factory address
    /// Returns token0 The first token of the pool by address sort order
    /// Returns token1 The second token of the pool by address sort order
    /// Returns fee The fee collected upon every swap in the pool, denominated in hundredths of a bip
    /// Returns tickSpacing The minimum number of ticks between initialized ticks
    function parameters()
        external
        view
        returns (
            address factory,
            address token0,
            address token1,
            uint24 fee,
            int24 tickSpacing,
            bytes32 poolTokenSettings
        );

    /// @notice Get the module parameters
    function moduleParameters()
        external
        view
        returns (
            address actionsModule,
            address collectModule,
            address protocolModule
        );

    /// @notice Get the Blast parameters
    function blastParameters()
        external
        view
        returns (
            address blast,
            address blastPoints,
            address gasCollector,
            address pointsOperator
        );

    /// @notice Updates the owner of the factory
    /// @dev Must be called by the current owner
    /// @param _owner The new owner of the factory
    function setOwner(address _owner) external;

    /// @notice Enables a fee amount with the given tickSpacing
    /// @dev Fee amounts may never be removed once enabled
    /// @param fee The fee amount to enable, denominated in hundredths of a bip (i.e. 1e-6)
    /// @param tickSpacing The spacing between ticks to be enforced for all pools created with the given fee amount
    function enableFeeAmount(uint24 fee, int24 tickSpacing) external;

    /// @notice Returns the number of pools that have been created in this factory
    /// @return len The length of the pools list
    function allPoolsLength() external view returns (uint256 len);

    /// @notice Returns a pool from the pool list
    /// @param index Index of the pool in the list
    /// @return pool The pool at the index in the list
    function allPools(uint256 index) external view returns (address pool);

    /// @notice Returns the settings for a token
    /// @param token The token address
    /// @return settings The settings for the token bytes encoded
    function tokenSettings(address token) external view returns (bytes32 settings);

    /// @notice Returns the settings for a pair of tokens
    /// @param token0 The token0 address
    /// @param token1 The token1 address
    /// @return settings The settings for the pair bytes encoded
    function tokenPairSettings(address token0, address token1) external view returns (bytes32 settings);

    /// @notice Decodes and returns the settings for a token
    /// @param token The token address
    /// @return isBaseTokenUSD True if the token is a candidate to be a base token and is USD pegged
    /// @return isBaseTokenETH True if the token is a candidate to be a base token and is ETH pegged
    /// @return supportsNativeYield True if the token supports ERC20Rebasing
    function getTokenSettings(address token) external view returns (
        bool isBaseTokenUSD,
        bool isBaseTokenETH,
        bool supportsNativeYield
    );

    /// @notice Calculates the token settings to use in a pool with these tokens
    /// @param token0 The token0 address
    /// @param token1 The token1 address
    /// @return poolTokenSettings The pool token settings bytes encoded
    function calculatePoolTokenSettings(address token0, address token1) external view returns (bytes32 poolTokenSettings);

    struct SetTokenSettingsParam {
        address token;
        bytes32 settings;
    }

    /// @notice Sets the settings for a list of tokens
    /// @param params The list of settings
    function setTokenSettings(SetTokenSettingsParam[] calldata params) external;

    struct SetTokenPairSettingsParam {
        address token0; // order required
        address token1;
        bytes32 settings;
    }

    /// @notice Sets the settings for a list of pairs of tokens
    /// @param params The list of settings
    function setTokenPairSettings(SetTokenPairSettingsParam[] calldata params) external;

    /// @notice Sets the swap fee distributor
    /// @param distributor The swap fee distributor
    function setSwapFeeDistributor(address distributor) external;

}
