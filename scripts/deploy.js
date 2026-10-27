// Deploys RoamlyEscrow (and a Test USDT token unless TOKEN_ADDRESS is set),
// then records the addresses in deployments.js for the website.
const fs = require('fs');
const path = require('path');
const { ethers, network } = require('hardhat');

const FEE_BPS = 200; // 2%
const LOCAL_CHAIN = 31337n;
// Public networks go in deployments.js (committed); the local chain in deployments.local.js (gitignored)
const outFile = chainId => path.join(__dirname, '..', chainId === LOCAL_CHAIN ? 'deployments.local.js' : 'deployments.js');

function readDeployments(file){
  if(!fs.existsSync(file)) return {};
  const src = fs.readFileSync(file, 'utf8');
  return JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));
}

async function main(){
  const [deployer] = await ethers.getSigners();
  if(!deployer) throw new Error('No deployer account. Put PRIVATE_KEY in .env (see .env.example).');
  const { chainId } = await ethers.provider.getNetwork();
  const feeRecipient = process.env.FEE_RECIPIENT || deployer.address;
  console.log(`Network ${network.name} (chain ${chainId}), deployer ${deployer.address}`);

  let tokenAddress = process.env.TOKEN_ADDRESS;
  let testToken = false;
  if(!tokenAddress){
    const token = await ethers.deployContract('TestUSDT');
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();
    testToken = true;
    console.log(`TestUSDT     ${tokenAddress}`);
  }

  const escrow = await ethers.deployContract('RoamlyEscrow', [tokenAddress, feeRecipient, FEE_BPS]);
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  console.log(`RoamlyEscrow ${escrowAddress}  (fee ${FEE_BPS / 100}% → ${feeRecipient})`);

  const file = outFile(chainId);
  const all = readDeployments(file);
  all[String(chainId)] = { network: network.name, escrow: escrowAddress, token: tokenAddress, testToken, feeRecipient, feeBps: FEE_BPS, deployedAt: new Date().toISOString() };
  const global = chainId === LOCAL_CHAIN ? 'ROAMLY_LOCAL_DEPLOYMENTS' : 'ROAMLY_DEPLOYMENTS';
  fs.writeFileSync(file, `// Written by scripts/deploy.js — contract addresses per chain id\nwindow.${global} = ${JSON.stringify(all, null, 2)};\n`);
  console.log(`Saved to ${path.basename(file)}`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
