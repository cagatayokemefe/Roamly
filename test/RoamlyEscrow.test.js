const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time, loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');

const DAY = 24 * 60 * 60;
const S = { None:0, Funded:1, Accepted:2, Delivered:3, Disputed:4, Released:5, Refunded:6, Split:7 };
const usdt = n => ethers.parseUnits(String(n), 18);
const CAT = { Electronics:0, Clothing:1, Cosmetics:2, General:3, Alcohol:4 };
const bits = (...cats) => cats.reduce((m, c) => m | (1 << CAT[c]), 0);
const CODE = 'K7QM2XPA9RTD4FHN';          // the buyer's secret delivery code
const CODE_HASH = ethers.id(CODE);         // only this hash goes on-chain

async function deploy(){
  const [deployer, buyer, traveler, feeWallet, stranger] = await ethers.getSigners();
  const token = await ethers.deployContract('TestUSDT');
  const escrow = await ethers.deployContract('RoamlyEscrow', [token, feeWallet.address, 200, 1000]);
  for(const who of [buyer, traveler]){
    await token.connect(who).faucet();
    await token.connect(who).approve(escrow, ethers.MaxUint256);
  }
  // Trip 1: the traveler flies tomorrow, carries 3 items, electronics or clothing
  const tripDate = (await time.latest()) + DAY;
  await escrow.connect(traveler).listTrip('PRG', tripDate, 3, bits('Electronics', 'Clothing'), 'Carry-on only');
  const request = (signer, amount, opts = {}) => escrow.connect(signer).createDeal(
    opts.trip ?? 1, amount, opts.codeHash ?? CODE_HASH, opts.item ?? 'Headphones', opts.link ?? '',
    opts.category ?? CAT.Electronics, opts.cents ?? 9000);
  return { token, escrow, deployer, buyer, traveler, feeWallet, stranger, tripDate, request };
}

// A funded 100 USDT request on trip 1, due 14 days after the trip (plus a 10 USDT deposit from each side once accepted)
async function funded(){
  const f = await deploy();
  await f.request(f.buyer, usdt(100));
  return { ...f, id: 1n, deliverBy: f.tripDate + 14 * DAY };
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
    it('has no owner, an immutable 2% fee and a 10% deposit', async () => {
      const { escrow, feeWallet } = await loadFixture(deploy);
      expect(await escrow.feeBps()).to.equal(200);
      expect(await escrow.depositBps()).to.equal(1000);
      expect(await escrow.feeRecipient()).to.equal(feeWallet.address);
      expect(escrow.interface.hasFunction('owner')).to.equal(false);
    });
    it('refuses a fee above 5%', async () => {
      const token = await ethers.deployContract('TestUSDT');
      const [a] = await ethers.getSigners();
      const Escrow = await ethers.getContractFactory('RoamlyEscrow');
      await expect(Escrow.deploy(token, a.address, 501, 1000)).to.be.revertedWithCustomError(Escrow, 'InvalidParams');
    });
    it('refuses a deposit above 30%', async () => {
      const token = await ethers.deployContract('TestUSDT');
      const [a] = await ethers.getSigners();
      const Escrow = await ethers.getContractFactory('RoamlyEscrow');
      await expect(Escrow.deploy(token, a.address, 200, 3001)).to.be.revertedWithCustomError(Escrow, 'InvalidParams');
    });
  });

  describe('createDeal', () => {
    it('locks the buyer\'s payment and deposit in the contract', async () => {
      const f = await loadFixture(funded);
      expect(await f.token.balanceOf(f.escrow)).to.equal(usdt(110));
      const d = await f.escrow.getDeal(f.id);
      expect(d.buyer).to.equal(f.buyer.address);
      expect(d.traveler).to.equal(f.traveler.address);
      expect(d.status).to.equal(S.Funded);
      expect([d.buyerDeposit, d.travelerDeposit]).to.deep.equal([usdt(10), 0n]);
    });
    it('stores the request details and the deadline from the trip', async () => {
      const f = await loadFixture(deploy);
      await expect(f.request(f.buyer, usdt(5), {item:'Kindle', link:'https://example.com/k', cents:12050}))
        .to.emit(f.escrow, 'DealCreated').withArgs(1, f.buyer.address, f.traveler.address, 1, usdt(5));
      const info = await f.escrow.getDealInfo(1);
      expect([info.item, info.link, info.category, info.priceCents]).to.deep.equal(['Kindle', 'https://example.com/k', 0n, 12050n]);
      const d = await f.escrow.getDeal(1);
      expect([d.tripId, d.deliverBy]).to.deep.equal([1n, BigInt(f.tripDate + 14 * DAY)]);
      expect(await f.escrow.dealsOf(f.buyer.address)).to.deep.equal([1n]);
      expect(await f.escrow.dealsOf(f.traveler.address)).to.deep.equal([1n]);
    });
    it('rejects bad input', async () => {
      const f = await loadFixture(deploy);
      await expect(f.request(f.traveler, usdt(1))).to.be.revertedWithCustomError(f.escrow, 'InvalidParams'); // own trip
      await expect(f.request(f.buyer, 0)).to.be.revertedWithCustomError(f.escrow, 'InvalidParams');
      await expect(f.request(f.buyer, usdt(1), {cents:0})).to.be.revertedWithCustomError(f.escrow, 'InvalidParams');
      await expect(f.request(f.buyer, usdt(1), {item:''})).to.be.revertedWithCustomError(f.escrow, 'InvalidParams');
      await expect(f.request(f.buyer, usdt(1), {item:'x'.repeat(121)})).to.be.revertedWithCustomError(f.escrow, 'InvalidParams');
      await expect(f.request(f.buyer, usdt(1), {trip:9})).to.be.revertedWithCustomError(f.escrow, 'TripNotOpen');
    });
  });

  describe('trips and profiles', () => {
    it('lists a trip with its details', async () => {
      const f = await loadFixture(deploy);
      const t = await f.escrow.getTrip(1);
      expect([t.traveler, t.code, t.capacity, t.categories, t.notes, t.closed]).to.deep.equal(
        [f.traveler.address, 'PRG', 3n, BigInt(bits('Electronics', 'Clothing')), 'Carry-on only', false]);
      expect(await f.escrow.tripCount()).to.equal(1);
      expect(await f.escrow.tripsOf(f.traveler.address)).to.deep.equal([1n]);
      expect((await f.escrow.getTrips(1, 10)).length).to.equal(1);
      expect((await f.escrow.getTrips(2, 10)).length).to.equal(0);
    });
    it('rejects bad trips', async () => {
      const f = await loadFixture(deploy);
      const e = f.escrow.connect(f.traveler);
      const day = f.tripDate;
      await expect(e.listTrip('PRAGUE', day, 1, 1, '')).to.be.revertedWithCustomError(f.escrow, 'InvalidParams');
      await expect(e.listTrip('PRG', day, 0, 1, '')).to.be.revertedWithCustomError(f.escrow, 'InvalidParams');
      await expect(e.listTrip('PRG', day, 6, 1, '')).to.be.revertedWithCustomError(f.escrow, 'InvalidParams');
      await expect(e.listTrip('PRG', day, 1, 0, '')).to.be.revertedWithCustomError(f.escrow, 'InvalidParams');
      await expect(e.listTrip('PRG', day, 1, 32, '')).to.be.revertedWithCustomError(f.escrow, 'InvalidParams');
      await expect(e.listTrip('PRG', day - 3 * DAY, 1, 1, '')).to.be.revertedWithCustomError(f.escrow, 'InvalidParams');
    });
    it('enforces the trip\'s categories', async () => {
      const f = await loadFixture(deploy);
      await expect(f.request(f.buyer, usdt(1), {category:CAT.Cosmetics})).to.be.revertedWithCustomError(f.escrow, 'CategoryNotCarried');
      await expect(f.request(f.buyer, usdt(1), {category:7})).to.be.revertedWithCustomError(f.escrow, 'CategoryNotCarried');
      await f.request(f.buyer, usdt(1), {category:CAT.Clothing});
    });
    it('enforces capacity and the €430 allowance, and refunds free them again', async () => {
      const f = await loadFixture(deploy);
      await f.request(f.buyer, usdt(1), {cents:20000});
      await expect(f.request(f.buyer, usdt(1), {cents:23001})).to.be.revertedWithCustomError(f.escrow, 'OverAllowance');
      await f.request(f.buyer, usdt(1), {cents:23000});       // exactly €430 in total
      let t = await f.escrow.getTrip(1);
      expect([t.slotsUsed, t.centsUsed]).to.deep.equal([2n, 43000n]);
      await f.escrow.connect(f.buyer).cancel(1);                // frees €200 and a slot
      t = await f.escrow.getTrip(1);
      expect([t.slotsUsed, t.centsUsed]).to.deep.equal([1n, 23000n]);
      await f.request(f.buyer, usdt(1), {cents:100});
      await f.request(f.buyer, usdt(1), {cents:100});
      await expect(f.request(f.buyer, usdt(1), {cents:100})).to.be.revertedWithCustomError(f.escrow, 'TripFull');
    });
    it('a paid-out request keeps its slot', async () => {
      const f = await loadFixture(accepted);
      await f.escrow.connect(f.buyer).confirmDelivery(f.id);
      expect((await f.escrow.getTrip(1)).slotsUsed).to.equal(1);
    });
    it('only the traveler can close a trip; closed trips take no requests', async () => {
      const f = await loadFixture(deploy);
      await expect(f.escrow.connect(f.buyer).closeTrip(1)).to.be.revertedWithCustomError(f.escrow, 'NotTraveler');
      await f.escrow.connect(f.traveler).closeTrip(1);
      await expect(f.request(f.buyer, usdt(1))).to.be.revertedWithCustomError(f.escrow, 'TripNotOpen');
    });
    it('requests are refused once the delivery deadline has passed', async () => {
      const f = await loadFixture(deploy);
      await time.increaseTo(f.tripDate + 14 * DAY);
      await expect(f.request(f.buyer, usdt(1))).to.be.revertedWithCustomError(f.escrow, 'TooLate');
    });
    it('anyone can set a display name of up to 32 bytes', async () => {
      const f = await loadFixture(deploy);
      await expect(f.escrow.connect(f.buyer).setName('Ayşe K.')).to.emit(f.escrow, 'NameSet').withArgs(f.buyer.address, 'Ayşe K.');
      expect(await f.escrow.names(f.buyer.address)).to.equal('Ayşe K.');
      await expect(f.escrow.connect(f.buyer).setName('x'.repeat(33))).to.be.revertedWithCustomError(f.escrow, 'InvalidParams');
    });
  });

  describe('before acceptance', () => {
    it('buyer can cancel for a full refund, deposit included', async () => {
      const f = await loadFixture(funded);
      await expect(f.escrow.connect(f.buyer).cancel(f.id)).to.changeTokenBalance(f.token, f.buyer, usdt(110));
      expect(await status(f)).to.equal(S.Refunded);
    });
    it('traveler can decline for a full refund', async () => {
      const f = await loadFixture(funded);
      await expect(f.escrow.connect(f.traveler).decline(f.id)).to.changeTokenBalance(f.token, f.buyer, usdt(110));
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
      await expect(f.escrow.connect(f.stranger).claimRefund(f.id)).to.changeTokenBalance(f.token, f.buyer, usdt(110));
    });
    it('accepting locks the traveler deposit', async () => {
      const f = await loadFixture(funded);
      await expect(f.escrow.connect(f.traveler).accept(f.id)).to.changeTokenBalance(f.token, f.traveler, usdt(-10));
      expect((await f.escrow.getDeal(f.id)).travelerDeposit).to.equal(usdt(10));
    });
    it('traveler cannot accept without the deposit', async () => {
      const f = await loadFixture(funded);
      await f.token.connect(f.traveler).approve(f.escrow, 0);
      await expect(f.escrow.connect(f.traveler).accept(f.id)).to.be.reverted;
      expect(await status(f)).to.equal(S.Funded);
    });
  });

  describe('happy path', () => {
    it('buyer confirms: traveler gets 98 + deposit back, fee wallet 2, buyer deposit back', async () => {
      const f = await loadFixture(delivered);
      await expect(f.escrow.connect(f.buyer).confirmDelivery(f.id))
        .to.changeTokenBalances(f.token, [f.traveler, f.feeWallet, f.buyer, f.escrow], [usdt(108), usdt(2), usdt(10), usdt(-120)]);
      expect(await status(f)).to.equal(S.Released);
    });
    it('buyer can confirm even before the traveler marks delivery', async () => {
      const f = await loadFixture(accepted);
      await expect(f.escrow.connect(f.buyer).confirmDelivery(f.id)).to.changeTokenBalance(f.token, f.traveler, usdt(108));
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
      await expect(f.escrow.connect(f.stranger).claimPayment(f.id))
        .to.changeTokenBalances(f.token, [f.traveler, f.buyer], [usdt(108), usdt(10)]);
    });
    it('missed deadline: buyer gets everything back plus the traveler\'s deposit', async () => {
      const f = await loadFixture(accepted);
      await expect(f.escrow.claimRefund(f.id)).to.be.revertedWithCustomError(f.escrow, 'TooEarly');
      await time.increaseTo(f.deliverBy + 1);
      await expect(f.escrow.claimRefund(f.id))
        .to.changeTokenBalances(f.token, [f.buyer, f.traveler, f.escrow], [usdt(120), 0, usdt(-120)]);
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
    it('agreed split: paid as agreed, both deposits returned, fee only on traveler share', async () => {
      const f = await loadFixture(disputed);
      await f.escrow.connect(f.buyer).proposeSplit(f.id, usdt(40));
      await expect(f.escrow.connect(f.traveler).proposeSplit(f.id, usdt(40)))
        .to.changeTokenBalances(f.token, [f.buyer, f.traveler, f.feeWallet, f.escrow], [usdt(50), usdt('68.8'), usdt('1.2'), usdt(-120)]);
      expect(await status(f)).to.equal(S.Split);
    });
    it('different offers do nothing until they match', async () => {
      const f = await loadFixture(disputed);
      await f.escrow.connect(f.buyer).proposeSplit(f.id, usdt(100));
      await f.escrow.connect(f.traveler).proposeSplit(f.id, usdt(0));
      expect(await status(f)).to.equal(S.Disputed);
      await expect(f.escrow.connect(f.traveler).proposeSplit(f.id, usdt(100)))
        .to.changeTokenBalances(f.token, [f.buyer, f.traveler], [usdt(110), usdt(10)]);
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
    it('30 days without agreement: 50/50, and the buyer\'s deposit goes to the traveler', async () => {
      const f = await loadFixture(disputed);
      await expect(f.escrow.settleStalemate(f.id)).to.be.revertedWithCustomError(f.escrow, 'TooEarly');
      await time.increase(30 * DAY);
      await expect(f.escrow.connect(f.stranger).settleStalemate(f.id))
        .to.changeTokenBalances(f.token, [f.buyer, f.traveler, f.feeWallet, f.escrow], [usdt(50), usdt(69), usdt(1), usdt(-120)]);
      expect(await status(f)).to.equal(S.Split);
    });
    it('can be opened before delivery too', async () => {
      const f = await loadFixture(accepted);
      await f.escrow.connect(f.buyer).openDispute(f.id);
      expect(await status(f)).to.equal(S.Disputed);
    });
  });

  describe('delivery code', () => {
    it('traveler entering the right code pays out at once (no 7-day wait)', async () => {
      const f = await loadFixture(accepted);
      const tx = f.escrow.connect(f.traveler).confirmWithCode(f.id, CODE);
      await expect(tx).to.changeTokenBalances(f.token, [f.traveler, f.buyer, f.feeWallet], [usdt(108), usdt(10), usdt(2)]);
      await expect(tx).to.emit(f.escrow, 'CodeConfirmed').withArgs(f.id);
      expect(await status(f)).to.equal(S.Released);
    });
    it('also works after the item was marked delivered', async () => {
      const f = await loadFixture(delivered);
      await expect(f.escrow.connect(f.traveler).confirmWithCode(f.id, CODE)).to.changeTokenBalance(f.token, f.traveler, usdt(108));
    });
    it('rejects a wrong code', async () => {
      const f = await loadFixture(accepted);
      await expect(f.escrow.connect(f.traveler).confirmWithCode(f.id, 'K7QM2XPA9RTD4FHX')).to.be.revertedWithCustomError(f.escrow, 'WrongCode');
      await expect(f.escrow.connect(f.traveler).confirmWithCode(f.id, '')).to.be.revertedWithCustomError(f.escrow, 'WrongCode');
    });
    it('only the traveler can use it', async () => {
      const f = await loadFixture(accepted);
      await expect(f.escrow.connect(f.stranger).confirmWithCode(f.id, CODE)).to.be.revertedWithCustomError(f.escrow, 'NotTraveler');
    });
    it('cannot be used before acceptance or during a dispute', async () => {
      const f = await loadFixture(funded);
      await expect(f.escrow.connect(f.traveler).confirmWithCode(f.id, CODE)).to.be.revertedWithCustomError(f.escrow, 'WrongStatus');
      const g = await loadFixture(disputed);
      await expect(g.escrow.connect(g.traveler).confirmWithCode(g.id, CODE)).to.be.revertedWithCustomError(g.escrow, 'WrongStatus');
    });
    it('a deal created without a code cannot be confirmed with one', async () => {
      const f = await loadFixture(deploy);
      await f.request(f.buyer, usdt(10), {codeHash:ethers.ZeroHash});
      await f.escrow.connect(f.traveler).accept(1);
      await expect(f.escrow.connect(f.traveler).confirmWithCode(1, '')).to.be.revertedWithCustomError(f.escrow, 'WrongCode');
    });
  });

  describe('receipts', () => {
    const PHOTO = ethers.id('receipt-photo-bytes');
    it('traveler attaches the receipt hash and total once', async () => {
      const f = await loadFixture(accepted);
      await expect(f.escrow.connect(f.traveler).attachReceipt(f.id, PHOTO, 9550))
        .to.emit(f.escrow, 'ReceiptAttached').withArgs(f.id, PHOTO, 9550);
      const r = await f.escrow.receipts(f.id);
      expect([r.hash, r.totalCents]).to.deep.equal([PHOTO, 9550n]);
      expect(r.attachedAt).to.equal(await time.latest());
      await expect(f.escrow.connect(f.traveler).attachReceipt(f.id, ethers.id('other'), 1)).to.be.revertedWithCustomError(f.escrow, 'AlreadyAttached');
    });
    it('can be attached after delivery or during a dispute', async () => {
      const f = await loadFixture(disputed);
      await f.escrow.connect(f.traveler).attachReceipt(f.id, PHOTO, 100);
    });
    it('only the traveler, only while the deal runs, and with real values', async () => {
      const f = await loadFixture(accepted);
      await expect(f.escrow.connect(f.buyer).attachReceipt(f.id, PHOTO, 1)).to.be.revertedWithCustomError(f.escrow, 'NotTraveler');
      await expect(f.escrow.connect(f.traveler).attachReceipt(f.id, ethers.ZeroHash, 1)).to.be.revertedWithCustomError(f.escrow, 'InvalidParams');
      await expect(f.escrow.connect(f.traveler).attachReceipt(f.id, PHOTO, 0)).to.be.revertedWithCustomError(f.escrow, 'InvalidParams');
      const g = await loadFixture(funded);
      await expect(g.escrow.connect(g.traveler).attachReceipt(g.id, PHOTO, 1)).to.be.revertedWithCustomError(g.escrow, 'WrongStatus');
      await f.escrow.connect(f.buyer).confirmDelivery(f.id);
      await expect(f.escrow.connect(f.traveler).attachReceipt(f.id, PHOTO, 1)).to.be.revertedWithCustomError(f.escrow, 'WrongStatus');
    });
  });

  describe('ratings', () => {
    async function released(){
      const f = await delivered();
      await f.escrow.connect(f.buyer).confirmDelivery(f.id);
      return f;
    }

    it('both sides can rate each other once a deal is paid out', async () => {
      const f = await loadFixture(released);
      await expect(f.escrow.connect(f.buyer).rate(f.id, 5, 'Perfect, arrived sealed'))
        .to.emit(f.escrow, 'Rated').withArgs(f.id, f.buyer.address, f.traveler.address, 5, 'Perfect, arrived sealed');
      await f.escrow.connect(f.traveler).rate(f.id, 4, 'Quick to reply');
      const [byBuyer, byTraveler] = await f.escrow.getReviews(f.id);
      expect([byBuyer.stars, byBuyer.comment]).to.deep.equal([5n, 'Perfect, arrived sealed']);
      expect([byTraveler.stars, byTraveler.comment]).to.deep.equal([4n, 'Quick to reply']);
      const rep = await f.escrow.reputation(f.traveler.address);
      expect([rep.count, rep.totalStars]).to.deep.equal([1n, 5n]);
    });
    it('each side can rate only once', async () => {
      const f = await loadFixture(released);
      await f.escrow.connect(f.buyer).rate(f.id, 5, '');
      await expect(f.escrow.connect(f.buyer).rate(f.id, 1, 'changed my mind')).to.be.revertedWithCustomError(f.escrow, 'AlreadyRated');
    });
    it('rejects outsiders, bad star counts and long comments', async () => {
      const f = await loadFixture(released);
      await expect(f.escrow.connect(f.stranger).rate(f.id, 5, '')).to.be.revertedWithCustomError(f.escrow, 'NotParty');
      await expect(f.escrow.connect(f.buyer).rate(f.id, 0, '')).to.be.revertedWithCustomError(f.escrow, 'InvalidParams');
      await expect(f.escrow.connect(f.buyer).rate(f.id, 6, '')).to.be.revertedWithCustomError(f.escrow, 'InvalidParams');
      await expect(f.escrow.connect(f.buyer).rate(f.id, 5, 'x'.repeat(281))).to.be.revertedWithCustomError(f.escrow, 'InvalidParams');
      await f.escrow.connect(f.buyer).rate(f.id, 5, 'ş'.repeat(140)); // 140 Turkish letters fit
    });
    it('cannot rate a deal that is still running', async () => {
      const f = await loadFixture(delivered);
      await expect(f.escrow.connect(f.buyer).rate(f.id, 5, '')).to.be.revertedWithCustomError(f.escrow, 'WrongStatus');
    });
    it('cannot rate a request that was never accepted', async () => {
      const f = await loadFixture(funded);
      await f.escrow.connect(f.traveler).decline(f.id);
      await expect(f.escrow.connect(f.buyer).rate(f.id, 1, 'declined me')).to.be.revertedWithCustomError(f.escrow, 'WrongStatus');
    });
    it('buyer can rate a traveler who accepted but never delivered', async () => {
      const f = await loadFixture(accepted);
      await time.increaseTo(f.deliverBy + 1);
      await f.escrow.claimRefund(f.id);
      await f.escrow.connect(f.buyer).rate(f.id, 1, 'Never showed up');
      expect((await f.escrow.reputation(f.traveler.address)).count).to.equal(1);
    });
    it('split disputes can be rated', async () => {
      const f = await loadFixture(disputed);
      await time.increase(30 * DAY);
      await f.escrow.settleStalemate(f.id);
      await f.escrow.connect(f.traveler).rate(f.id, 2, 'Unfair dispute');
      expect((await f.escrow.reputation(f.buyer.address)).totalStars).to.equal(2);
    });
  });

  it('keeps separate deals separate', async () => {
    const f = await loadFixture(deploy);
    await f.escrow.connect(f.stranger).listTrip('DXB', f.tripDate, 1, bits('General'), '');
    await f.request(f.buyer, usdt(10));
    await f.request(f.buyer, usdt(20), {trip:2, category:CAT.General});
    await f.escrow.connect(f.buyer).cancel(2);
    expect(await f.token.balanceOf(f.escrow)).to.equal(usdt(11)); // deal 1: 10 + 1 deposit
    expect((await f.escrow.getDeal(1)).status).to.equal(S.Funded);
  });

  it('works with deposits switched off', async () => {
    const [, buyer, traveler, feeWallet] = await ethers.getSigners();
    const token = await ethers.deployContract('TestUSDT');
    const escrow = await ethers.deployContract('RoamlyEscrow', [token, feeWallet.address, 200, 0]);
    await token.connect(buyer).faucet();
    await token.connect(buyer).approve(escrow, ethers.MaxUint256);
    await escrow.connect(traveler).listTrip('LON', (await time.latest()) + DAY, 1, bits('Electronics'), '');
    await escrow.connect(buyer).createDeal(1, usdt(100), CODE_HASH, 'Laptop', '', CAT.Electronics, 40000);
    await escrow.connect(traveler).accept(1); // no deposit, so no approval needed
    await expect(escrow.connect(buyer).confirmDelivery(1)).to.changeTokenBalance(token, traveler, usdt(98));
  });
});
