require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config();

const { PRIVATE_KEY, BSC_TESTNET_RPC } = process.env;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.24',
    // viaIR: createDeal takes many parameters, which overflows the classic compiler's stack
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
  },
  networks: {
    // Testnet only for now — free test BNB from https://www.bnbchain.org/en/testnet-faucet
    bscTestnet: {
      url: BSC_TESTNET_RPC || 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
      chainId: 97,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
};
