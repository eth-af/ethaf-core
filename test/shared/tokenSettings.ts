import { toBytes32 } from './../../scripts/utils/strings'

export const FactoryTokenSettings = {
  NO_SETTING: toBytes32(0),
  IS_BASE_TOKEN_USD_MASK: toBytes32(1),
  IS_BASE_TOKEN_ETH_MASK: toBytes32(2),
}

export const PoolTokenSettings = {
  NO_BASE_TOKEN: toBytes32(0),
  IS_TOKEN0_BASE_TOKEN_MASK: toBytes32(1),
  IS_TOKEN1_BASE_TOKEN_MASK: toBytes32(2),
}
