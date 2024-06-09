import { toBytes32 } from './../../scripts/utils/strings'

export const FactoryTokenSettings = {
  NO_SETTING: toBytes32(0),
  IS_BASE_TOKEN_USD_MASK: toBytes32(1),
  IS_BASE_TOKEN_ETH_MASK: toBytes32(2),
  SUPPORTS_NATIVE_YIELD_MASK: toBytes32(4),
  USDB_FLAGS: toBytes32(5),
  WETH_FLAGS: toBytes32(6),
}

export const PoolTokenSettings = {
  NO_BASE_TOKEN: toBytes32(0),
  IS_TOKEN0_BASE_TOKEN_MASK: toBytes32(1),
  IS_TOKEN1_BASE_TOKEN_MASK: toBytes32(2),
  TOKEN0_SUPPORTS_NATIVE_YIELD_MASK: toBytes32(4),
  TOKEN1_SUPPORTS_NATIVE_YIELD_MASK: toBytes32(8),
  IS_USDB_TOKEN0_FLAGS: toBytes32(5),
  IS_USDB_TOKEN1_FLAGS: toBytes32(10),
  IS_WETH_TOKEN0_FLAGS: toBytes32(5),
  IS_WETH_TOKEN1_FLAGS: toBytes32(10),
  USDB_WETH_POOL_FLAGS: toBytes32(13),
}
