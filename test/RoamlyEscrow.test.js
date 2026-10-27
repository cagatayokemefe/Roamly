const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time, loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');

const DAY = 24 * 60 * 60;
const S = { None:0, Funded:1, Accepted:2, Delivered:3, Disputed:4, Released:5, Refunded:6, Split:7 };
const usdt = n => ethers.parseUnits(String(n), 18);
const REF = ethers.encodeBytes32String('r-demo');

async function deploy(){
  const [deployer, buyer, traveler, feeWallet, stranger] = await ethers.getSigners();
  const token = await ethers.deployContract('TestUSDT');
  const escrow = await ethers.deployContract('RoamlyEscrow', [token, feeWallet.address, 200]);
  await token.connect(buyer).faucet();
  await token.connect(buyer).approve(escrow, ethers.MaxUint256);
  return { token, escrow, deployer, buyer, traveler, feeWallet, stranger };
}

// A funded 100 USDT deal due in 14 days
async function funded(){
  const f = await deploy();
  const deliverBy = (await time.latest()) + 14 * DAY;
  await f.escrow.connect(f.buyer).createDeal(f.traveler, usdt(100), deliverBy, REF);
  return { ...f, id: 1n, deliverBy };
}
async function accepted(){
  const f = await funded();
  await f.escrow.connect(f.traveler).accept(f.id);
  return f;
}
async function delivered(){
  const f = await accepted();
  await f.escrow.connect(f.traveler).markDelivered(f.id);
  return f;
}
async function disputed(){
  const f = await delivered();
  await f.escrow.connect(f.buyer).openDispute(f.id);
  return f;
}
const status = async f => (await f.escrow.getDeal(f.id)).status;

describe('RoamlyEscrow', () => {
  describe('deploy', () => {
    it('has no owner and an immutable 2% fee', async () => {
      const { escrow, feeWallet } = await loadFixture(deploy);
      expect(await escrow.feeBps()).to.equal(200);
      expect(await escrow.feeRecipient()).to.equal(feeWallet.address);
      expect(escrow.interface.hasFunction('owner')).to.equal(false);
    });
    it('refuses a fee above 5%', async () => {
      const token = await ethers.deployContract('TestUSDT');
      const [a] = await ethers.getSigners();
      const Escrow = await ethers.getContractFactory('RoamlyEscrow');
      await expect(Escrow.deploy(token, a.address, 501)).to.be.revertedWithCustomError(Escrow, 'InvalidParams');
    });
  });

  describe('createDeal', () => {
    it('locks the buyer\'s tokens in the contract', async () => {
      const f = await loadFixture(funded);
      expect(await f.token.balanceOf(f.escrow)).to.equal(usdt(100));
      const d = await f.escrow.getDeal(f.id);
      expect(d.buyer).to.equal(f.buyer.address);
      expect(d.traveler).to.equal(f.traveler.address);
      expect(d.status).to.equal(S.Funded);
    });
    it('emits DealCreated with the app reference', async () => {
      const f = await loadFixture(deploy);
      const by = (await time.latest()) + DAY;
      await expect(f.escrow.connect(f.buyer).createDeal(f.traveler, usdt(5), by, REF))
        .to.emit(f.escrow, 'DealCreated').withArgs(1, f.buyer.address, f.traveler.address, usdt(5), by, REF);
    });
    it('rejects bad input', async () => {
      const f = await loadFixture(deploy);
      const by = (await time.latest()) + DAY;
      const c = f.escrow.connect(f.buyer);
      await expect(c.createDeal(f.buyer, usdt(1), by, REF)).to.be.revertedWithCustomError(f.escrow, 'InvalidParams');
      await expect(c.createDeal(ethers.ZeroAddress, usdt(1), by, REF)).to.be.revertedWithCustomError(f.escrow, 'InvalidParams');
      await expect(c.createDeal(f.traveler, 0, by, REF)).to.be.revertedWithCustomError(f.escrow, 'InvalidParams');
      await expect(c.createDeal(f.traveler, usdt(1), (await time.latest()) - 1, REF)).to.be.revertedWithCustomError(f.escrow, 'InvalidParams');
    });
  });

  describe('before acceptance', () => {
    it('buyer can cancel for a full refund', async () => {
      const f = await loadFixture(funded);
      await expect(f.escrow.connect(f.buyer).cancel(f.id)).to.changeTokenBalance(f.token, f.buyer, usdt(100));
      expect(await status(f)).to.equal(S.Refunded);
    });
    it('traveler can decline for a full refund', async () => {
      const f = await loadFixture(funded);
      await expect(f.escrow.connect(f.traveler).decline(f.id)).to.changeTokenBalance(f.token, f.buyer, usdt(100));
    });
    it('only the traveler can accept, and only once', async () => {
      const f = await loadFixture(funded);
      await expect(f.escrow.connect(f.buyer).accept(f.id)).to.be.revertedWithCustomError(f.escrow, 'NotTraveler');
      await f.escrow.connect(f.traveler).accept(f.id);
      await expect(f.escrow.connect(f.traveler).accept(f.id)).to.be.revertedWithCustomError(f.escrow, 'WrongStatus');
      await expect(f.escrow.connect(f.buyer).cancel(f.id)).to.be.revertedWithCustomError(f.escrow, 'WrongStatus');
    });
    it('cannot accept after the deadline; buyer can then reclaim', async () => {
      const f = await loadFixture(funded);
      await time.increaseTo(f.deliverBy + 1);
      await expect(f.escrow.connect(f.traveler).accept(f.id)).to.be.revertedWithCustomError(f.escrow, 'TooLate');
      await expect(f.escrow.connect(f.stranger).claimRefund(f.id)).to.changeTokenBalance(f.token, f.buyer, usdt(100));
    });
  });

  describe('happy path', () => {
    it('buyer confirms: traveler gets 98, fee wallet gets 2', async () => {
      const f = await loadFixture(delivered);
      await expect(f.escrow.connect(f.buyer).confirmDelivery(f.id))
        .to.changeTokenBalances(f.token, [f.traveler, f.feeWallet, f.escrow], [usdt(98), usdt(2), usdt(-100)]);
      expect(await status(f)).to.equal(S.Released);
    });
    it('buyer can confirm even before the traveler marks delivery', async () => {
      const f = await loadFixture(accepted);
      await expect(f.escrow.connect(f.buyer).confirmDelivery(f.id)).to.changeTokenBalance(f.token, f.traveler, usdt(98));
    });
    it('nobody else can confirm', async () => {
      const f = await loadFixture(delivered);
      await expect(f.escrow.connect(f.traveler).confirmDelivery(f.id)).to.be.revertedWithCustomError(f.escrow, 'NotBuyer');
      await expect(f.escrow.connect(f.stranger).confirmDelivery(f.id)).to.be.revertedWithCustomError(f.escrow, 'NotBuyer');
    });
    it('cannot be paid twice', async () => {
      const f = await loadFixture(delivered);
      await f.escrow.connect(f.buyer).confirmDelivery(f.id);
      await expect(f.escrow.connect(f.buyer).confirmDelivery(f.id)).to.be.revertedWithCustomError(f.escrow, 'WrongStatus');
    });
  });

  describe('timeouts', () => {
    it('traveler is paid 7 days after delivery if the buyer stays silent', async () => {
      const f = await loadFixture(delivered);
      await expect(f.escrow.claimPayment(f.id)).to.be.revertedWithCustomError(f.escrow, 'TooEarly');
      await time.increase(7 * DAY);
      await expect(f.escrow.connect(f.stranger).claimPayment(f.id)).to.changeTokenBalance(f.token, f.traveler, usdt(98));
    });
    it('buyer is refunded if the deadline passes without delivery', async () => {
      const f = await loadFixture(accepted);
      await expect(f.escrow.claimRefund(f.id)).to.be.revertedWithCustomError(f.escrow, 'TooEarly');
      await time.increaseTo(f.deliverBy + 1);
      await expect(f.escrow.claimRefund(f.id)).to.changeTokenBalance(f.token, f.buyer, usdt(100));
    });
    it('no refund claim once the item is marked delivered', async () => {
      const f = await loadFixture(delivered);
      await time.increaseTo(f.deliverBy + 1);
      await expect(f.escrow.claimRefund(f.id)).to.be.revertedWithCustomError(f.escrow, 'WrongStatus');
    });
  });

  describe('disputes', () => {
    it('only the buyer can open one, and not after the 7-day window', async () => {
      const f = await loadFixture(delivered);
      await expect(f.escrow.connect(f.traveler).openDispute(f.id)).to.be.revertedWithCustomError(f.escrow, 'NotBuyer');
      await time.increase(7 * DAY);
      await expect(f.escrow.connect(f.buyer).openDispute(f.id)).to.be.revertedWithCustomError(f.escrow, 'TooLate');
    });
    it('freezes the funds: no confirm, payment claim or refund claim', async () => {
      const f = await loadFixture(disputed);
      await time.increase(8 * DAY);
      await expect(f.escrow.connect(f.buyer).confirmDelivery(f.id)).to.be.revertedWithCustomError(f.escrow, 'WrongStatus');
      await expect(f.escrow.claimPayment(f.id)).to.be.revertedWithCustomError(f.escrow, 'WrongStatus');
      await expect(f.escrow.claimRefund(f.id)).to.be.revertedWithCustomError(f.escrow, 'WrongStatus');
    });
    it('pays out when both sides propose the same split (fee only on traveler share)', async () => {
      const f = await loadFixture(disputed);
      await f.escrow.connect(f.buyer).proposeSplit(f.id, usdt(40));
      await expect(f.escrow.connect(f.traveler).proposeSplit(f.id, usdt(40)))
        .to.changeTokenBalances(f.token, [f.buyer, f.traveler, f.feeWallet], [usdt(40), usdt('58.8'), usdt('1.2')]);
      expect(await status(f)).to.equal(S.Split);
    });
    it('different offers do nothing until they match', async () => {
      const f = await loadFixture(disputed);
      await f.escrow.connect(f.buyer).proposeSplit(f.id, usdt(100));
      await f.escrow.connect(f.traveler).proposeSplit(f.id, usdt(0));
      expect(await status(f)).to.equal(S.Disputed);
      await expect(f.escrow.connect(f.traveler).proposeSplit(f.id, usdt(100))).to.changeTokenBalance(f.token, f.buyer, usdt(100));
      expect(await status(f)).to.equal(S.Refunded);
    });
    it('agreeing on 0 to the buyer counts as released', async () => {
      const f = await loadFixture(disputed);
      await f.escrow.connect(f.buyer).proposeSplit(f.id, 0);
      await f.escrow.connect(f.traveler).proposeSplit(f.id, 0);
      expect(await status(f)).to.equal(S.Released);
    });
    it('outsiders cannot propose, and offers cannot exceed the deal', async () => {
      const f = await loadFixture(disputed);
      await expect(f.escrow.connect(f.stranger).proposeSplit(f.id, 0)).to.be.revertedWithCustomError(f.escrow, 'NotParty');
      await expect(f.escrow.connect(f.buyer).proposeSplit(f.id, usdt(101))).to.be.revertedWithCustomError(f.escrow, 'InvalidParams');
    });
    it('splits 50/50 after 30 days without agreement', async () => {
      const f = await loadFixture(disputed);
      await expect(f.escrow.settleStalemate(f.id)).to.be.revertedWithCustomError(f.escrow, 'TooEarly');
      await time.increase(30 * DAY);
      await expect(f.escrow.connect(f.stranger).settleStalemate(f.id))
        .to.changeTokenBalances(f.token, [f.buyer, f.traveler, f.feeWallet, f.escrow], [usdt(50), usdt(49), usdt(1), usdt(-100)]);
      expect(await status(f)).to.equal(S.Split);
    });
    it('can be opened before delivery too', async () => {
      const f = await loadFixture(accepted);
      await f.escrow.connect(f.buyer).openDispute(f.id);
      expect(await status(f)).to.equal(S.Disputed);
    });
  });

  it('keeps separate deals separate', async () => {
    const f = await loadFixture(deploy);
    const by = (await time.latest()) + DAY;
    await f.escrow.connect(f.buyer).createDeal(f.traveler, usdt(10), by, REF);
    await f.escrow.connect(f.buyer).createDeal(f.stranger, usdt(20), by, REF);
    await f.escrow.connect(f.buyer).cancel(2);
    expect(await f.token.balanceOf(f.escrow)).to.equal(usdt(10));
    expect((await f.escrow.getDeal(1)).status).to.equal(S.Funded);
  });
});
