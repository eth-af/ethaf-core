import { BigNumber } from 'ethers'
import { ethers } from 'hardhat'
import { MockTimeEthAfPool } from '../../typechain/MockTimeEthAfPool'
import { TestERC20 } from '../../typechain/TestERC20'
import { EthAfFactory } from '../../typechain/EthAfFactory'
import { EthAfPoolDeployerModule } from '../../typechain/EthAfPoolDeployerModule'
import { TestEthAfCallee } from '../../typechain/TestEthAfCallee'
import { TestEthAfRouter } from '../../typechain/TestEthAfRouter'
import { MockTimeEthAfPoolDeployer } from '../../typechain/MockTimeEthAfPoolDeployer'
import { EthAfSwapFeeDistributor } from '../../typechain/EthAfSwapFeeDistributor'

import { Fixture } from 'ethereum-waffle'

interface FactoryFixture {
  factory: EthAfFactory
  poolDeployerModule: EthAfPoolDeployerModule
  swapFeeDistributor: EthAfSwapFeeDistributor
}

async function factoryFixture(): Promise<FactoryFixture> {
  const poolDeployerModuleFactory = await ethers.getContractFactory('EthAfPoolDeployerModule')
  const poolDeployerModule = (await poolDeployerModuleFactory.deploy()) as EthAfPoolDeployerModule
  const factoryFactory = await ethers.getContractFactory('EthAfFactory')
  const factory = (await factoryFactory.deploy(poolDeployerModule.address)) as EthAfFactory
  const swapFeeDistributorFactory = await ethers.getContractFactory('EthAfSwapFeeDistributor')
  const swapFeeDistributor = (await swapFeeDistributorFactory.deploy(factory.address)) as EthAfSwapFeeDistributor
  await factory.setSwapFeeDistributor(swapFeeDistributor.address)
  return { factory, poolDeployerModule, swapFeeDistributor }
}

interface TokensFixture {
  token0: TestERC20
  token1: TestERC20
  token2: TestERC20
  token3: TestERC20
}

async function tokensFixture(): Promise<TokensFixture> {
  const tokenFactory = await ethers.getContractFactory('TestERC20')
  const tokenA = (await tokenFactory.deploy(BigNumber.from(2).pow(255))) as TestERC20
  const tokenB = (await tokenFactory.deploy(BigNumber.from(2).pow(255))) as TestERC20
  const tokenC = (await tokenFactory.deploy(BigNumber.from(2).pow(255))) as TestERC20
  const tokenD = (await tokenFactory.deploy(BigNumber.from(2).pow(255))) as TestERC20

  const [token0, token1, token2, token3] = [tokenA, tokenB, tokenC, tokenD].sort((tokenA, tokenB) =>
    tokenA.address.toLowerCase() < tokenB.address.toLowerCase() ? -1 : 1
  )

  return { token0, token1, token2, token3 }
}

type TokensAndFactoryFixture = FactoryFixture & TokensFixture

interface PoolFixture extends TokensAndFactoryFixture {
  swapTargetCallee: TestEthAfCallee
  swapTargetRouter: TestEthAfRouter
  createPool(
    fee: number,
    tickSpacing: number,
    firstToken?: TestERC20,
    secondToken?: TestERC20
  ): Promise<MockTimeEthAfPool>
}

// Monday, October 5, 2020 9:00:00 AM GMT-05:00
export const TEST_POOL_START_TIME = 1601906400

export const poolFixture: Fixture<PoolFixture> = async function (): Promise<PoolFixture> {
  const { factory, poolDeployerModule, swapFeeDistributor } = await factoryFixture()
  const { token0, token1, token2, token3 } = await tokensFixture()

  const MockTimeEthAfPoolDeployerFactory = await ethers.getContractFactory('MockTimeEthAfPoolDeployer')
  const MockTimeEthAfPoolFactory = await ethers.getContractFactory('MockTimeEthAfPool')

  const calleeContractFactory = await ethers.getContractFactory('TestEthAfCallee')
  const routerContractFactory = await ethers.getContractFactory('TestEthAfRouter')

  const swapTargetCallee = (await calleeContractFactory.deploy()) as TestEthAfCallee
  const swapTargetRouter = (await routerContractFactory.deploy()) as TestEthAfRouter

  return {
    token0,
    token1,
    token2,
    token3,
    factory,
    poolDeployerModule,
    swapFeeDistributor,
    swapTargetCallee,
    swapTargetRouter,
    createPool: async (fee, tickSpacing, firstToken = token0, secondToken = token1) => {
      const mockTimePoolDeployer = (await MockTimeEthAfPoolDeployerFactory.deploy()) as MockTimeEthAfPoolDeployer
      const tx = await mockTimePoolDeployer.deploy(
        factory.address,
        firstToken.address,
        secondToken.address,
        fee,
        tickSpacing
      )

      const receipt = await tx.wait()
      const poolAddress = receipt.events?.[0].args?.pool as string
      return MockTimeEthAfPoolFactory.attach(poolAddress) as MockTimeEthAfPool
    },
  }
}
