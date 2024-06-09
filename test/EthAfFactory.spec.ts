import { Wallet } from 'ethers'
import { ethers, waffle } from 'hardhat'
import { EthAfFactory } from '../typechain/EthAfFactory'
import { EthAfPoolDeployerModule } from '../typechain/EthAfPoolDeployerModule'
import { expect } from './shared/expect'
import snapshotGasCost from './shared/snapshotGasCost'

import { FeeAmount, getCreate2Address, TICK_SPACINGS } from './shared/utilities'
import { toBytes32 } from './../scripts/utils/strings'

const { constants } = ethers

const TEST_ADDRESSES: [string, string] = [
  '0x1000000000000000000000000000000000000000',
  '0x2000000000000000000000000000000000000000',
]

const createFixtureLoader = waffle.createFixtureLoader

describe('EthAfFactory', () => {
  let wallet: Wallet, other: Wallet

  let factory: EthAfFactory
  let poolDeployerModule: EthAfPoolDeployerModule
  let poolBytecode: string
  const fixture = async () => {
    const poolDeployerModuleFactory = await ethers.getContractFactory('EthAfPoolDeployerModule')
    const poolDeployerModule = (await poolDeployerModuleFactory.deploy()) as EthAfPoolDeployerModule
    const factoryFactory = await ethers.getContractFactory('EthAfFactory')
    const factory = (await factoryFactory.deploy(poolDeployerModule.address)) as EthAfFactory
    return { factory, poolDeployerModule }
  }

  let loadFixture: ReturnType<typeof createFixtureLoader>
  before('create fixture loader', async () => {
    ;[wallet, other] = await (ethers as any).getSigners()

    loadFixture = createFixtureLoader([wallet, other])
  })

  before('load pool bytecode', async () => {
    poolBytecode = (await ethers.getContractFactory('EthAfPool')).bytecode
  })

  beforeEach('deploy factory', async () => {
    let fixtureResponse = await loadFixture(fixture)
    factory = fixtureResponse.factory
    poolDeployerModule = fixtureResponse.poolDeployerModule
  })

  it('owner is deployer', async () => {
    expect(await factory.owner()).to.eq(wallet.address)
  })

  it('factory bytecode size', async () => {
    expect(((await waffle.provider.getCode(factory.address)).length - 2) / 2).to.matchSnapshot()
  })

  it('pool bytecode size', async () => {
    await factory.createPool(TEST_ADDRESSES[0], TEST_ADDRESSES[1], FeeAmount.MEDIUM)
    const poolAddress = getCreate2Address(factory.address, TEST_ADDRESSES, FeeAmount.MEDIUM, poolBytecode)
    expect(((await waffle.provider.getCode(poolAddress)).length - 2) / 2).to.matchSnapshot()
  })

  it('initial enabled fee amounts', async () => {
    expect(await factory.feeAmountTickSpacing(FeeAmount.LOW)).to.eq(TICK_SPACINGS[FeeAmount.LOW])
    expect(await factory.feeAmountTickSpacing(FeeAmount.MEDIUM)).to.eq(TICK_SPACINGS[FeeAmount.MEDIUM])
    expect(await factory.feeAmountTickSpacing(FeeAmount.HIGH)).to.eq(TICK_SPACINGS[FeeAmount.HIGH])
  })

  it('pool deployer module is set correctly', async () => {
    const moduleAddress = await factory.poolDeployerModule()
    expect(poolDeployerModule.address).to.eq(moduleAddress)
  })

  it('factory pools list begins with length 0', async () => {
    expect(await factory.allPoolsLength()).to.eq(0)
    await expect(factory.allPools(0)).to.be.reverted
    await expect(factory.allPools(1)).to.be.reverted
  })

  async function createAndCheckPool(
    tokens: [string, string],
    feeAmount: FeeAmount,
    tickSpacing: number = TICK_SPACINGS[feeAmount],
    expectedPoolTokenSettings:any = undefined
  ) {
    const create2Address = getCreate2Address(factory.address, tokens, feeAmount, poolBytecode)
    const create = factory.createPool(tokens[0], tokens[1], feeAmount)

    await expect(create)
      .to.emit(factory, 'PoolCreated')
      .withArgs(TEST_ADDRESSES[0], TEST_ADDRESSES[1], feeAmount, tickSpacing, create2Address)

    await expect(factory.createPool(tokens[0], tokens[1], feeAmount)).to.be.reverted
    await expect(factory.createPool(tokens[1], tokens[0], feeAmount)).to.be.reverted
    expect(await factory.getPool(tokens[0], tokens[1], feeAmount), 'getPool in order').to.eq(create2Address)
    expect(await factory.getPool(tokens[1], tokens[0], feeAmount), 'getPool in reverse').to.eq(create2Address)

    expect(await factory.allPoolsLength()).to.eq(1)
    expect(await factory.allPools(0)).to.eq(create2Address)
    await expect(factory.allPools(1)).to.be.reverted

    const poolContractFactory = await ethers.getContractFactory('EthAfPool')
    const pool = poolContractFactory.attach(create2Address)
    expect(await pool.factory(), 'pool factory address').to.eq(factory.address)
    expect(await pool.token0(), 'pool token0').to.eq(TEST_ADDRESSES[0])
    expect(await pool.token1(), 'pool token1').to.eq(TEST_ADDRESSES[1])
    expect(await pool.fee(), 'pool fee').to.eq(feeAmount)
    expect(await pool.tickSpacing(), 'pool tick spacing').to.eq(tickSpacing)

    if(!!expectedPoolTokenSettings) {
      expect(await pool.poolTokenSettings(), 'pool token settings').to.eq(expectedPoolTokenSettings)
    }
  }

  describe('#createPool', () => {
    it('succeeds for low fee pool', async () => {
      await createAndCheckPool(TEST_ADDRESSES, FeeAmount.LOW)
    })

    it('succeeds for medium fee pool', async () => {
      await createAndCheckPool(TEST_ADDRESSES, FeeAmount.MEDIUM)
    })
    it('succeeds for high fee pool', async () => {
      await createAndCheckPool(TEST_ADDRESSES, FeeAmount.HIGH)
    })

    it('succeeds if tokens are passed in reverse', async () => {
      await createAndCheckPool([TEST_ADDRESSES[1], TEST_ADDRESSES[0]], FeeAmount.MEDIUM)
    })

    it('fails if token a == token b', async () => {
      await expect(factory.createPool(TEST_ADDRESSES[0], TEST_ADDRESSES[0], FeeAmount.LOW)).to.be.reverted
    })

    it('fails if token a is 0 or token b is 0', async () => {
      await expect(factory.createPool(TEST_ADDRESSES[0], constants.AddressZero, FeeAmount.LOW)).to.be.reverted
      await expect(factory.createPool(constants.AddressZero, TEST_ADDRESSES[0], FeeAmount.LOW)).to.be.reverted
      await expect(factory.createPool(constants.AddressZero, constants.AddressZero, FeeAmount.LOW)).to.be.revertedWith(
        ''
      )
    })

    it('fails if fee amount is not enabled', async () => {
      await expect(factory.createPool(TEST_ADDRESSES[0], TEST_ADDRESSES[1], 250)).to.be.reverted
    })

    it('gas', async () => {
      await snapshotGasCost(factory.createPool(TEST_ADDRESSES[0], TEST_ADDRESSES[1], FeeAmount.MEDIUM))
    })

    it('succeeds when factory has no token settings', async () => {
      expect(await factory.tokenSettings(TEST_ADDRESSES[0])).to.eq(toBytes32(0))
      expect(await factory.tokenSettings(TEST_ADDRESSES[1])).to.eq(toBytes32(0))
      await createAndCheckPool(TEST_ADDRESSES, FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], toBytes32(0))
    })
  })

  describe('#setOwner', () => {
    it('fails if caller is not owner', async () => {
      await expect(factory.connect(other).setOwner(wallet.address)).to.be.reverted
    })

    it('updates owner', async () => {
      await factory.setOwner(other.address)
      expect(await factory.owner()).to.eq(other.address)
    })

    it('emits event', async () => {
      await expect(factory.setOwner(other.address))
        .to.emit(factory, 'OwnerChanged')
        .withArgs(wallet.address, other.address)
    })

    it('cannot be called by original owner', async () => {
      await factory.setOwner(other.address)
      await expect(factory.setOwner(wallet.address)).to.be.reverted
    })
  })

  describe('#enableFeeAmount', () => {
    it('fails if caller is not owner', async () => {
      await expect(factory.connect(other).enableFeeAmount(100, 2)).to.be.reverted
    })
    it('fails if fee is too great', async () => {
      await expect(factory.enableFeeAmount(1000000, 10)).to.be.reverted
    })
    it('fails if tick spacing is too small', async () => {
      await expect(factory.enableFeeAmount(500, 0)).to.be.reverted
    })
    it('fails if tick spacing is too large', async () => {
      await expect(factory.enableFeeAmount(500, 16834)).to.be.reverted
    })
    it('fails if already initialized', async () => {
      await factory.enableFeeAmount(100, 5)
      await expect(factory.enableFeeAmount(100, 10)).to.be.reverted
    })
    it('sets the fee amount in the mapping', async () => {
      await factory.enableFeeAmount(100, 5)
      expect(await factory.feeAmountTickSpacing(100)).to.eq(5)
    })
    it('emits an event', async () => {
      await expect(factory.enableFeeAmount(100, 5)).to.emit(factory, 'FeeAmountEnabled').withArgs(100, 5)
    })
    it('enables pool creation', async () => {
      await factory.enableFeeAmount(250, 15)
      await createAndCheckPool([TEST_ADDRESSES[0], TEST_ADDRESSES[1]], 250, 15)
    })
  })

  describe('#setTokenSettings', () => {
    it('fails if caller is not owner', async () => {
      await expect(factory.connect(other).setTokenSettings([])).to.be.reverted
    })
    it('sets the token settings mapping', async () => {
      await factory.setTokenSettings([{
        token: TEST_ADDRESSES[0],
        settings: toBytes32(1)
      }])
      expect(await factory.tokenSettings(TEST_ADDRESSES[0])).to.eq(toBytes32(1))
      expect(await factory.tokenSettings(TEST_ADDRESSES[1])).to.eq(toBytes32(0))
    })
    it('emits an event', async () => {
      await expect(factory.setTokenSettings([{
        token: TEST_ADDRESSES[0],
        settings: toBytes32(1)
      }])).to.emit(factory, 'TokenSettingsSet').withArgs(TEST_ADDRESSES[0], toBytes32(1))
    })
    it('can create pool with token0 base token pt 1', async () => {
      await factory.setTokenSettings([{
        token: TEST_ADDRESSES[0],
        settings: toBytes32(1)
      }])
      await createAndCheckPool(TEST_ADDRESSES, FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], toBytes32(1))
    })
    it('can create pool with token1 base token pt 1', async () => {
      await factory.setTokenSettings([{
        token: TEST_ADDRESSES[1],
        settings: toBytes32(1)
      }])
      await createAndCheckPool(TEST_ADDRESSES, FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], toBytes32(2))
    })
    it('can create pool with neither base token pt 1', async () => {
      await createAndCheckPool(TEST_ADDRESSES, FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], toBytes32(0))
    })
    it('can create pool with neither base token pt 2', async () => {
      await factory.setTokenSettings([
        {
          token: TEST_ADDRESSES[0],
          settings: toBytes32(1)
        },
        {
          token: TEST_ADDRESSES[1],
          settings: toBytes32(1)
        },
      ])
      expect(await factory.tokenSettings(TEST_ADDRESSES[0])).to.eq(toBytes32(1))
      expect(await factory.tokenSettings(TEST_ADDRESSES[1])).to.eq(toBytes32(1))
      await createAndCheckPool(TEST_ADDRESSES, FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], toBytes32(0))
    })
    it('can create pool with token0 base token pt 2', async () => {
      await factory.setTokenSettings([{
        token: TEST_ADDRESSES[0],
        settings: toBytes32(2)
      }])
      expect(await factory.tokenSettings(TEST_ADDRESSES[0])).to.eq(toBytes32(2))
      await createAndCheckPool(TEST_ADDRESSES, FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], toBytes32(1))
    })
    it('can create pool with token1 base token pt 2', async () => {
      await factory.setTokenSettings([{
        token: TEST_ADDRESSES[1],
        settings: toBytes32(2)
      }])
      expect(await factory.tokenSettings(TEST_ADDRESSES[1])).to.eq(toBytes32(2))
      await createAndCheckPool(TEST_ADDRESSES, FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], toBytes32(2))
    })
    it('can create pool with neither base token pt 3', async () => {
      await factory.setTokenSettings([
        {
          token: TEST_ADDRESSES[0],
          settings: toBytes32(2)
        },
        {
          token: TEST_ADDRESSES[1],
          settings: toBytes32(2)
        },
      ])
      expect(await factory.tokenSettings(TEST_ADDRESSES[0])).to.eq(toBytes32(2))
      expect(await factory.tokenSettings(TEST_ADDRESSES[1])).to.eq(toBytes32(2))
      await createAndCheckPool(TEST_ADDRESSES, FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], toBytes32(0))
    })
    it('can create pool with token0 base token pt 3', async () => {
      await factory.setTokenSettings([
        {
          token: TEST_ADDRESSES[0],
          settings: toBytes32(1) // usd
        },
        {
          token: TEST_ADDRESSES[1],
          settings: toBytes32(2) // eth
        },
      ])
      expect(await factory.tokenSettings(TEST_ADDRESSES[0])).to.eq(toBytes32(1))
      expect(await factory.tokenSettings(TEST_ADDRESSES[1])).to.eq(toBytes32(2))
      await createAndCheckPool(TEST_ADDRESSES, FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], toBytes32(1))
    })
    it('can create pool with token1 base token pt 3', async () => {
      await factory.setTokenSettings([
        {
          token: TEST_ADDRESSES[0],
          settings: toBytes32(2) // eth
        },
        {
          token: TEST_ADDRESSES[1],
          settings: toBytes32(1) // usd
        },
      ])
      expect(await factory.tokenSettings(TEST_ADDRESSES[0])).to.eq(toBytes32(2))
      expect(await factory.tokenSettings(TEST_ADDRESSES[1])).to.eq(toBytes32(1))
      await createAndCheckPool(TEST_ADDRESSES, FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], toBytes32(2))
    })
  })

  describe('#setTokenPairSettings', () => {
    it('fails if caller is not owner', async () => {
      await expect(factory.connect(other).setTokenPairSettings([])).to.be.reverted
    })
    it('sets the token pair settings mapping', async () => {
      await factory.setTokenPairSettings([{
        token0: TEST_ADDRESSES[0],
        token1: TEST_ADDRESSES[1],
        settings: toBytes32(1)
      }])
      expect(await factory.tokenPairSettings(TEST_ADDRESSES[0], TEST_ADDRESSES[1])).to.eq(toBytes32(1))
    })
    it('emits an event', async () => {
      await expect(factory.setTokenPairSettings([{
        token0: TEST_ADDRESSES[0],
        token1: TEST_ADDRESSES[1],
        settings: toBytes32(1)
      }])).to.emit(factory, 'TokenPairSettingsSet').withArgs(TEST_ADDRESSES[0], TEST_ADDRESSES[1], toBytes32(1))
    })
    it('can create pool with token0 base token pt 1', async () => {
      await factory.setTokenPairSettings([{
        token0: TEST_ADDRESSES[0],
        token1: TEST_ADDRESSES[1],
        settings: toBytes32(1)
      }])
      await createAndCheckPool(TEST_ADDRESSES, FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], toBytes32(1))
    })
    it('can create pool with token1 base token pt 1', async () => {
      await factory.setTokenPairSettings([{
        token0: TEST_ADDRESSES[0],
        token1: TEST_ADDRESSES[1],
        settings: toBytes32(2)
      }])
      await createAndCheckPool(TEST_ADDRESSES, FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], toBytes32(2))
    })
    it('reverts if both tokens are base', async () => {
      await factory.setTokenPairSettings([{
        token0: TEST_ADDRESSES[0],
        token1: TEST_ADDRESSES[1],
        settings: toBytes32(3)
      }])
      await expect(
        factory.createPool(TEST_ADDRESSES[0], TEST_ADDRESSES[1], FeeAmount.LOW)
      ).to.be.reverted
    })
  })
})
