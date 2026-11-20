// ---------- On-chain escrow (BNB Smart Chain) ----------
// Talks to RoamlyEscrow through the browser wallet (MetaMask). A request on a trip whose
// traveler linked a wallet is paid into the contract; everything else stays in demo mode.

// EUR → USD rate from the European Central Bank (via Frankfurter), treating 1 USDT as 1 USD.
// Falls back to the last saved rate, then to a fixed estimate if none was ever fetched.
const RATE_URL = 'https://api.frankfurter.dev/v1/latest?from=EUR&to=USD';
const RATE_KEY = 'roamly-eur-usd';
const FALLBACK_RATE = 1.08;
const fx = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(RATE_KEY));
    if(saved?.rate > 0) return {rate:saved.rate, date:saved.date, source:'saved'};
  } catch {}
  return {rate:FALLBACK_RATE, date:null, source:'fallback'};
})();

async function loadRate(){
  try {
    const res = await fetch(RATE_URL);
    const data = await res.json();
    const rate = data?.rates?.USD;
    if(!(rate > 0.5 && rate < 2)) throw new Error('Unexpected rate');
    Object.assign(fx, {rate, date:data.date, source:'live'});
    try { localStorage.setItem(RATE_KEY, JSON.stringify({rate, date:data.date})); } catch {}
  } catch {
    // keep the saved or fallback rate
  }
  if(typeof renderAll === 'function') renderAll();
}

// "1 € = 1.099 USDT · ECB rate, 20 Nov" — or a warning when no live rate is available
function rateLabel(){
  const day = fx.date ? new Date(fx.date + 'T00:00:00').toLocaleDateString(LOCALE(), {day:'numeric', month:'short'}) : '';
  const vars = {rate:fmtNum(fx.rate, {maximumFractionDigits:4}), sym:wallet.symbol, day};
  return t(fx.source === 'live' ? 'rate.live' : fx.source === 'saved' ? 'rate.saved' : 'rate.fallback', vars);
}
const DEPLOYMENTS = {...window.ROAMLY_DEPLOYMENTS, ...window.ROAMLY_LOCAL_DEPLOYMENTS};
const NETWORKS = {
  97: {chainId:'0x61', chainName:'BNB Smart Chain Testnet', rpcUrls:['https://data-seed-prebsc-1-s1.bnbchain.org:8545'],
       nativeCurrency:{name:'tBNB', symbol:'tBNB', decimals:18}, blockExplorerUrls:['https://testnet.bscscan.com']},
  31337: {chainId:'0x7a69', chainName:'Hardhat Local', rpcUrls:['http://127.0.0.1:8545'],
          nativeCurrency:{name:'ETH', symbol:'ETH', decimals:18}, blockExplorerUrls:null},
};
const ESCROW_ABI = [
  'function createDeal(address traveler, uint128 amount, uint64 deliverBy, bytes32 ref, bytes32 codeHash) returns (uint256)',
  'function confirmWithCode(uint256 id, string code)',
  'function attachReceipt(uint256 id, bytes32 hash, uint32 totalCents)',
  'function receipts(uint256) view returns (bytes32 hash, uint32 totalCents, uint64 attachedAt)',
  'function cancel(uint256 id)',
  'function accept(uint256 id)',
  'function decline(uint256 id)',
  'function markDelivered(uint256 id)',
  'function confirmDelivery(uint256 id)',
  'function openDispute(uint256 id)',
  'function claimPayment(uint256 id)',
  'function claimRefund(uint256 id)',
  'function proposeSplit(uint256 id, uint128 toBuyer)',
  'function settleStalemate(uint256 id)',
  'function getDeal(uint256 id) view returns (tuple(address buyer, address traveler, uint128 amount, uint64 deliverBy, uint64 deliveredAt, uint64 disputedAt, uint8 status, uint128 buyerOffer, uint128 travelerOffer, bool accepted, uint128 buyerDeposit, uint128 travelerDeposit, bytes32 codeHash))',
  'function depositBps() view returns (uint16)',
  'function rate(uint256 id, uint8 stars, string comment)',
  'function getReviews(uint256 id) view returns (tuple(uint8 stars, string comment) byBuyer, tuple(uint8 stars, string comment) byTraveler)',
  'function reputation(address) view returns (uint64 count, uint64 totalStars)',
  'event DealCreated(uint256 indexed id, address indexed buyer, address indexed traveler, uint256 amount, uint64 deliverBy, bytes32 ref)',
  'error InvalidParams()', 'error NotBuyer()', 'error NotTraveler()', 'error NotParty()',
  'error WrongStatus(uint8 current)', 'error TooEarly()', 'error TooLate()', 'error AlreadyRated()', 'error WrongCode()', 'error AlreadyAttached()',
];
const TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function faucet()',
];
const DEAL = ['None','Funded','Accepted','Delivered','Disputed','Released','Refunded','Split'];
const CONFIRM_WINDOW = 7 * 86400;  // must match the contract
const DISPUTE_WINDOW = 30 * 86400;
const DELIVER_GRACE_DAYS = 14;     // traveler has until trip date + 14 days to deliver
// Contract error name → message ('err.<name>' in i18n.js); unknown errors show their name
const chainError = name => STRINGS.en['err.' + name] ? t('err.' + name) : name;
// App action → contract function; the "in progress" text is 'pending.<action>' in i18n.js
const CHAIN_ACTIONS = {
  cancel:'cancel', decline:'decline', accept:'accept', deliver:'markDelivered', confirm:'confirmDelivery',
  dispute:'openDispute', 'claim-pay':'claimPayment', 'claim-refund':'claimRefund', propose:'proposeSplit',
  settle:'settleStalemate', rate:'rate', code:'confirmWithCode', receipt:'attachReceipt',
};

const FINAL_DEALS = ['Released','Refunded','Split'];
const MAX_COMMENT = 140; // characters; the contract allows 280 bytes, enough for 140 Turkish letters
const wallet = {account:null, chainId:null, dep:null, escrow:null, token:null, decimals:18, symbol:'USDT', balance:null, busy:false, reps:{}, depositBps:0n};
const hasEthers = typeof ethers !== 'undefined';

// ---------- Helpers ----------
const shortAddr = a => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
const sameAddr = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const chainReady = () => !!(wallet.account && wallet.escrow);
const isCurrentContract = req => !!req.chain && req.chain.chainId === wallet.chainId && sameAddr(req.chain.escrow, wallet.dep?.escrow);
const networkName = id => NETWORKS[id]?.chainName || `chain ${id}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const fmtSecDay = s => new Date(s * 1000).toLocaleDateString(LOCALE(), {day:'numeric', month:'short'});

function canPayOnChain(trip){
  return chainReady() && !!trip?.wallet && !sameAddr(trip.wallet, wallet.account);
}
function eurToUnits(eur){
  return ethers.parseUnits((Math.round(eur * fx.rate * 100) / 100).toFixed(2), wallet.decimals);
}
// Refundable deposit each side locks — same formula as the contract's depositFor()
const depositFor = units => BigInt(units) * wallet.depositBps / 10000n;
function fmtUnits(units, decimals = wallet.decimals, symbol = wallet.symbol){
  const n = Number(ethers.formatUnits(BigInt(units), decimals));
  return `${fmtNum(n, {maximumFractionDigits:2})} ${symbol}`;
}
const fmtDeal = (req, units) => fmtUnits(units, req.chain.decimals, req.chain.symbol);
function txLink(chainId, hash){
  const base = NETWORKS[chainId]?.blockExplorerUrls?.[0];
  return base ? `<a class="link" href="${base}/tx/${hash}" target="_blank" rel="noopener">${t('tx.view')}</a>` : '';
}
function chainRole(req){
  if(sameAddr(wallet.account, req.chain?.buyer)) return 'buyer';
  if(sameAddr(wallet.account, req.chain?.traveler)) return 'traveler';
  return null;
}

function friendlyError(e){
  if(e?.code === 'ACTION_REJECTED' || e?.code === 4001 || e?.info?.error?.code === 4001) return t('err.rejected');
  if(e?.revert?.name) return chainError(e.revert.name);
  const data = e?.data?.data ?? e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  try {
    const parsed = data && wallet.escrow?.interface.parseError(data);
    if(parsed) return chainError(parsed.name);
  } catch {}
  return e?.shortMessage || e?.message || t('err.generic');
}

// ---------- Wallet connection ----------
async function connectWallet(){
  if(!hasEthers){ toast(t('toast.noLib')); return; }
  if(!window.ethereum){
    toast(t('toast.installMM'));
    window.open('https://metamask.io/download/', '_blank', 'noopener');
    return;
  }
  try {
    const [account] = await window.ethereum.request({method:'eth_requestAccounts'});
    await ensureNetwork();
    await setupWallet(account);
    if(chainReady()) toast(t('toast.connected', {addr:shortAddr(wallet.account), net:networkName(wallet.chainId)}));
  } catch(e){ toast(friendlyError(e)); }
}

// Switch the wallet to a chain the contracts are deployed on (testnet first)
async function ensureNetwork(){
  const current = parseInt(await window.ethereum.request({method:'eth_chainId'}), 16);
  if(DEPLOYMENTS[current]) return;
  const target = DEPLOYMENTS[97] ? 97 : Number(Object.keys(DEPLOYMENTS)[0]);
  if(!target) throw new Error(t('err.notDeployed'));
  const net = NETWORKS[target];
  try {
    await window.ethereum.request({method:'wallet_switchEthereumChain', params:[{chainId:net.chainId}]});
  } catch(e){
    if(e.code !== 4902) throw e;
    await window.ethereum.request({method:'wallet_addEthereumChain', params:[net]});
  }
}

async function setupWallet(account){
  const provider = new ethers.BrowserProvider(window.ethereum);
  provider.pollingInterval = 1500; // BNB Smart Chain makes a block every ~3s
  wallet.chainId = Number((await provider.getNetwork()).chainId);
  wallet.account = account ? ethers.getAddress(account) : null;
  wallet.dep = DEPLOYMENTS[wallet.chainId] || null;
  wallet.escrow = wallet.token = null;
  wallet.balance = null;
  if(wallet.account && wallet.dep){
    const signer = await provider.getSigner(wallet.account);
    wallet.escrow = new ethers.Contract(wallet.dep.escrow, ESCROW_ABI, signer);
    wallet.token = new ethers.Contract(wallet.dep.token, TOKEN_ABI, signer);
    const [decimals, symbol, depositBps] = await Promise.all([wallet.token.decimals(), wallet.token.symbol(), wallet.escrow.depositBps()]);
    wallet.decimals = Number(decimals);
    wallet.symbol = symbol;
    wallet.depositBps = BigInt(depositBps);
    await syncDeals();
    await loadReputations();
    await refreshBalance();
  }
  renderAll();
}

async function refreshBalance(){
  if(!chainReady()) return;
  try { wallet.balance = await wallet.token.balanceOf(wallet.account); } catch {}
  renderWallet();
}

async function getTestTokens(){
  if(!chainReady()) return connectWallet();
  const receipt = await sendTx(t('pending.mint'), () => wallet.token.faucet());
  if(receipt){ await refreshBalance(); toast(t('toast.minted', {sym:wallet.symbol})); }
}

// ---------- Transactions ----------
async function sendTx(pending, fn){
  if(wallet.busy){ toast(t('toast.busy')); return null; }
  wallet.busy = true;
  document.body.classList.add('tx-busy');
  try {
    toast(t('tx.confirm', {p:pending}));
    const tx = await fn();
    toast(t('tx.wait', {p:pending}));
    return await tx.wait();
  } catch(e){
    toast(friendlyError(e));
    return null;
  } finally {
    wallet.busy = false;
    document.body.classList.remove('tx-busy');
  }
}

// Check the wallet holds `units` and let the escrow take them. Returns false if it can't.
async function ensureFunds(units){
  await refreshBalance();
  if(wallet.balance !== null && wallet.balance < units){
    toast(t('toast.needFunds', {need:fmtUnits(units), have:fmtUnits(wallet.balance)}) + (wallet.dep.testToken ? t('toast.useFaucet') : ''));
    return false;
  }
  const allowance = await wallet.token.allowance(wallet.account, wallet.dep.escrow);
  if(allowance >= units) return true;
  return !!await sendTx(t('pending.approve', {amt:fmtUnits(units)}), () => wallet.token.approve(wallet.dep.escrow, units));
}

// Approve + lock the buyer's payment and deposit. Returns the chain record for the request, or null.
async function payOnChain(req, trip){
  const amount = eurToUnits(req.price);
  const deposit = depositFor(amount);
  if(!await ensureFunds(amount + deposit)) return null;
  const deliverBy = Math.floor(parseDay(trip.date).getTime() / 1000) + DELIVER_GRACE_DAYS * 86400;
  const code = newDeliveryCode();
  const receipt = await sendTx(t('pending.lock', {amt:fmtUnits(amount), dep:fmtUnits(deposit)}),
    () => wallet.escrow.createDeal(trip.wallet, amount, deliverBy, ethers.encodeBytes32String(req.id), ethers.id(code)));
  if(!receipt) return null;
  const created = receipt.logs.map(l => { try { return wallet.escrow.interface.parseLog(l); } catch { return null; } })
    .find(l => l?.name === 'DealCreated');
  refreshBalance();
  return {dealId:created.args.id.toString(), chainId:wallet.chainId, escrow:wallet.dep.escrow, amount:amount.toString(), deposit:deposit.toString(), code, rate:fx.rate, rateDate:fx.date, decimals:wallet.decimals,
          symbol:wallet.symbol, buyer:wallet.account, traveler:trip.wallet, txs:[receipt.hash]};
}

async function chainAction(req, act, ...args){
  if(!chainReady()){ toast(t('toast.connectToManage')); return false; }
  if(req.chain.chainId !== wallet.chainId){ toast(t('toast.wrongNet', {net:networkName(req.chain.chainId)})); return false; }
  if(!isCurrentContract(req)){ toast(t('toast.oldContract')); return false; }
  // Accepting locks the traveler's deposit, so the escrow needs permission to take it first
  if(act === 'accept' && !await ensureFunds(BigInt(req.chain.deposit || 0))) return false;
  const receipt = await sendTx(t('pending.' + act), () => wallet.escrow[CHAIN_ACTIONS[act]](req.chain.dealId, ...args));
  if(receipt){
    req.chain.txs.push(receipt.hash);
    req.chain.intent = act;
    await syncDeal(req);
    refreshBalance();
  } else {
    await syncDeal(req).catch(() => {});
  }
  renderAll();
  return !!receipt;
}

// ---------- Reading deals back from the chain ----------
// History entry ({k, v}) for a deal reaching chain status `s`
function chainHistoryLabel(req, s){
  const d = req.deal || {};
  const refunded = fmtDeal(req, BigInt(req.chain.amount) + BigInt(d.buyerDeposit || 0) + BigInt(d.travelerDeposit || 0));
  const net = fmtDeal(req, BigInt(req.chain.amount) * BigInt(10000 - (DEPLOYMENTS[req.chain.chainId]?.feeBps ?? 200)) / 10000n);
  const forfeit = BigInt(d.travelerDeposit || 0) > 0n && req.chain.intent === 'claim-refund';
  return {
    Accepted:{k:'hist.c.Accepted', v:{dep:fmtDeal(req, d.travelerDeposit || 0)}},
    Delivered:{k:'hist.c.Delivered', v:{}},
    Disputed:{k:'hist.c.Disputed', v:{reason:req.dispute?.reason || ''}},
    Released:{k:req.chain.intent === 'code' ? 'hist.c.ReleasedCode' : 'hist.c.Released', v:{net}},
    Refunded:{k:forfeit ? 'hist.c.RefundedForfeit' : 'hist.c.Refunded', v:{amt:refunded}},
    Split:{k:'hist.c.Split', v:{}},
  }[s];
}
function appStatusFor(req, s){
  if(s === 'Refunded'){
    if(req.chain.intent === 'cancel') return 'cancelled';
    if(req.chain.intent === 'decline') return 'declined';
    return 'refunded';
  }
  return {Funded:'pending', Accepted:'escrow', Delivered:'escrow', Disputed:'disputed', Released:'completed', Split:'split'}[s] || req.status;
}

async function syncDeal(req){
  const d = await wallet.escrow.getDeal(req.chain.dealId);
  const s = DEAL[Number(d.status)];
  const prev = req.deal?.status;
  req.deal = {status:s, deliverBy:Number(d.deliverBy), deliveredAt:Number(d.deliveredAt), disputedAt:Number(d.disputedAt),
              buyerOffer:d.buyerOffer.toString(), travelerOffer:d.travelerOffer.toString(), accepted:d.accepted,
              buyerDeposit:d.buyerDeposit.toString(), travelerDeposit:d.travelerDeposit.toString(), codeHash:d.codeHash};
  let reviewsChanged = false;
  if(d.accepted && FINAL_DEALS.includes(s)){
    const [byBuyer, byTraveler] = await wallet.escrow.getReviews(req.chain.dealId);
    const reviews = {byBuyer:{stars:Number(byBuyer.stars), comment:byBuyer.comment}, byTraveler:{stars:Number(byTraveler.stars), comment:byTraveler.comment}};
    reviewsChanged = JSON.stringify(reviews) !== JSON.stringify(req.reviews);
    req.reviews = reviews;
  }
  // A receipt can only be attached once, so stop asking after we've seen it
  if(d.accepted && !req.receipt){
    const rc = await wallet.escrow.receipts(req.chain.dealId);
    if(rc.hash !== ethers.ZeroHash){
      req.receipt = {hash:rc.hash, totalCents:Number(rc.totalCents), attachedAt:Number(rc.attachedAt)};
      reviewsChanged = true;
    }
  }
  if(prev === s){ save(); return reviewsChanged; }
  const next = appStatusFor(req, s);
  const label = chainHistoryLabel(req, s);
  if(next !== req.status) setStatus(req, next, label?.k, label?.v);
  else { if(label) req.history.push({...label, at:nowIso()}); save(); }
  delete req.chain.intent;
  return true;
}

async function syncDeals(){
  if(!chainReady() || wallet.busy) return;
  let changed = false;
  for(const req of state.requests.filter(isCurrentContract)){
    try { changed = await syncDeal(req) || changed; } catch {}
  }
  changed = await loadReputations() || changed;
  if(changed) renderAll();
}

// ---------- Ratings ----------
// On-chain reputation for every wallet the app knows about (traveler wallets, deal parties)
async function loadReputations(){
  if(!chainReady()) return false;
  const addrs = new Set([...state.trips.map(t => t.wallet), ...state.requests.filter(isCurrentContract).flatMap(r => [r.chain.buyer, r.chain.traveler])]
    .filter(Boolean).map(a => a.toLowerCase()));
  let changed = false;
  for(const a of addrs){
    try {
      const rep = await wallet.escrow.reputation(a);
      const next = {count:Number(rep.count), total:Number(rep.totalStars)};
      if(JSON.stringify(next) !== JSON.stringify(wallet.reps[a])){ wallet.reps[a] = next; changed = true; }
    } catch {}
  }
  return changed;
}

const repOf = addr => addr ? wallet.reps[addr.toLowerCase()] : null;
const starsText = n => '★'.repeat(n) + '☆'.repeat(5 - n);

// "★ 4.5 · 2 on-chain ratings" for a trip whose traveler linked a wallet, else null (use the demo rating)
function onChainRating(trip, short = false){
  const rep = repOf(trip?.wallet);
  if(!rep) return null;
  if(!rep.count) return short ? t('rating.new') : t('rating.none');
  const avg = fmtNum(rep.total / rep.count, {minimumFractionDigits:1, maximumFractionDigits:1});
  return short ? t('rating.short', {avg}) : t('rating.long', {avg, n:rep.count});
}

// Comments buyers left for this traveler, from deals this browser knows about
function reviewsFor(trip){
  if(!trip?.wallet) return [];
  return state.requests
    .filter(r => r.reviews?.byBuyer?.stars && sameAddr(r.chain?.traveler, trip.wallet))
    .map(r => ({...r.reviews.byBuyer, item:r.item}));
}

function canRate(req, side){
  if(!req.chain || !req.deal?.accepted || !FINAL_DEALS.includes(req.deal.status)) return false;
  return !(side === 'buyer' ? req.reviews?.byBuyer?.stars : req.reviews?.byTraveler?.stars);
}

function reviewLines(req){
  const r = req.reviews;
  if(!r) return '';
  const line = (who, rv) => rv?.stars
    ? `<p class="review-line"><span class="stars">${starsText(rv.stars)}</span> ${who}${rv.comment ? ` — “${esc(rv.comment)}”` : ''}</p>` : '';
  return line(t('review.fromBuyer'), r.byBuyer) + line(t('review.fromTraveler'), r.byTraveler);
}

let rateTarget = null, rateStars = 0;
function openRateDialog(req){
  const role = chainRole(req);
  if(!role){ toast(t('toast.connectToRate')); return; }
  if(!canRate(req, role)){ toast(chainError('AlreadyRated')); return; }
  rateTarget = req.id;
  const trip = tripById(req.tripId);
  $('rate-title').textContent = role === 'buyer'
    ? (trip && !trip.mine ? t('rate.rateName', {name:trip.traveler}) : t('rate.rateTraveler'))
    : t('rate.rateBuyer');
  $('rate-sub').textContent = t('rate.sub', {item:req.item});
  $('rate-comment').value = '';
  setRateStars(0);
  updateRateCount();
  $('rate-dialog').showModal();
}
function setRateStars(n){
  rateStars = n;
  document.querySelectorAll('#rate-stars button').forEach((b, i) => {
    b.classList.toggle('on', i < n);
    b.setAttribute('aria-pressed', String(i < n));
  });
  $('rate-error').textContent = '';
}
function updateRateCount(){
  $('rate-count').textContent = `${[...$('rate-comment').value].length} / ${MAX_COMMENT}`;
}
async function submitRating(){
  const req = reqById(rateTarget);
  const comment = $('rate-comment').value.trim();
  if(!req) return;
  if(!rateStars){ $('rate-error').textContent = t('rate.errStars'); return; }
  if([...comment].length > MAX_COMMENT){ $('rate-error').textContent = t('rate.errLong', {n:MAX_COMMENT}); return; }
  $('rate-dialog').close();
  if(await chainAction(req, 'rate', rateStars, comment)){
    await loadReputations();
    renderAll();
    toast(t('toast.rated'));
  }
}

// ---------- Receipts ----------
// The photo stays in this browser; the contract keeps its keccak256 hash, the total and the time,
// so anyone holding the photo can prove it's the one the traveler attached.
const RECEIPT_MAX_PX = 1024;
let receiptTarget = null, receiptDraft = null;

const fmtEur = cents => '€' + fmtNum(cents / 100, {minimumFractionDigits:2, maximumFractionDigits:2});
function dataUrlBytes(dataUrl){
  const bin = atob(dataUrl.split(',')[1]);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
const receiptHash = dataUrl => ethers.keccak256(dataUrlBytes(dataUrl));

// Shrink the photo to a JPEG that fits comfortably in browser storage
async function compressImage(file){
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Not an image'));
      i.src = url;
    });
    const scale = Math.min(1, RECEIPT_MAX_PX / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.75);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function receiptLine(req){
  const r = req.receipt;
  if(!r) return '';
  const over = r.totalCents - Math.round(req.price * 100);
  return `<p class="receipt-line">${t('receipt.line', {total:fmtEur(r.totalCents), day:fmtSecDay(r.attachedAt)})}` +
    (over > 0 ? ` · <span class="warn">${t('receipt.over', {over:fmtEur(over), price:fmtNum(req.price)})}</span>` : '') + `</p>`;
}

function openReceiptDialog(req){
  receiptTarget = req.id;
  receiptDraft = null;
  $('receipt-item').textContent = req.item;
  $('receipt-file').value = '';
  $('receipt-total').value = '';
  $('receipt-preview').hidden = true;
  $('receipt-drop-text').textContent = t('receipt.pick');
  $('receipt-error').textContent = '';
  $('receipt-dialog').showModal();
}

async function onReceiptFile(input){
  const file = input.files?.[0];
  if(!file) return;
  $('receipt-error').textContent = '';
  try {
    receiptDraft = await compressImage(file);
    $('receipt-preview').src = receiptDraft;
    $('receipt-preview').hidden = false;
    $('receipt-drop-text').textContent = t('receipt.repick');
  } catch {
    receiptDraft = null;
    $('receipt-error').textContent = t('receipt.errNotImage');
  }
}

async function submitReceipt(){
  const req = reqById(receiptTarget);
  const total = parseFloat($('receipt-total').value);
  if(!req) return;
  if(!receiptDraft){ $('receipt-error').textContent = t('receipt.errPhoto'); return; }
  if(!(total > 0)){ $('receipt-error').textContent = t('receipt.errTotal'); return; }
  // Make sure the photo fits in browser storage before saving its fingerprint for good
  req.receiptImage = receiptDraft;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch {
    delete req.receiptImage;
    $('receipt-error').textContent = t('receipt.errStorage');
    return;
  }
  $('receipt-dialog').close();
  const ok = await chainAction(req, 'receipt', receiptHash(receiptDraft), Math.round(total * 100));
  if(!ok){ delete req.receiptImage; save(); return; }
  toast(t('toast.receipt'));
}

function openReceiptViewer(req){
  const r = req.receipt;
  if(!r) return;
  $('rv-meta').textContent = t('rv.meta', {item:req.item, total:fmtEur(r.totalCents), day:fmtSecDay(r.attachedAt)});
  const img = $('rv-img'), check = $('rv-check');
  img.hidden = !req.receiptImage;
  if(req.receiptImage) img.src = req.receiptImage;
  if(!req.receiptImage){
    check.className = 'rv-check';
    check.textContent = t('rv.noPhoto');
  } else if(receiptHash(req.receiptImage) === r.hash){
    check.className = 'rv-check ok';
    check.textContent = t('rv.ok');
  } else {
    check.className = 'rv-check bad';
    check.textContent = t('rv.bad');
  }
  $('receipt-view').showModal();
}

// ---------- Delivery code ----------
// 16 symbols from a 32-letter alphabet = 80 random bits. Only its hash goes on-chain, and the hash is
// public, so the code must be long enough that nobody can guess it from the hash.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I, so it's easy to read out
const QR_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
const SCAN_LIB = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';

function newDeliveryCode(){
  return [...crypto.getRandomValues(new Uint8Array(16))].map(b => CODE_ALPHABET[b & 31]).join('');
}
const normalizeCode = s => String(s).toUpperCase().replace(/[^0-9A-Z]/g, '');
const formatCode = c => c.match(/.{1,4}/g).join('-');
const codePayload = req => `roamly:${req.chain.dealId}:${req.chain.code}`;

const loadedScripts = {};
function loadScript(src){
  return loadedScripts[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { delete loadedScripts[src]; reject(new Error('Couldn’t load ' + src)); };
    document.head.appendChild(s);
  });
}

// Buyer: show the code as a QR and as text
async function openCodeDialog(req){
  if(!req.chain?.code){ toast(t('code.noCode')); return; }
  $('code-text').textContent = formatCode(req.chain.code);
  $('code-item').textContent = req.item;
  const box = $('code-qr');
  box.innerHTML = '';
  $('code-dialog').showModal();
  try {
    await loadScript(QR_LIB);
    new QRCode(box, {text:codePayload(req), width:220, height:220, colorDark:'#1B1F1A', colorLight:'#FFFFFF', correctLevel:QRCode.CorrectLevel.M});
  } catch {
    box.innerHTML = `<p class="form-hint">${t('code.qrFail')}</p>`;
  }
}

// Traveler: scan the buyer's QR or type the code
let codeTarget = null, scanner = null;
function openEntryDialog(req){
  codeTarget = req.id;
  $('entry-item').textContent = req.item;
  $('code-input').value = '';
  $('entry-error').textContent = '';
  $('entry-dialog').showModal();
}
async function startScan(){
  const box = $('scan-box');
  $('entry-error').textContent = '';
  try {
    await loadScript(SCAN_LIB);
    box.hidden = false;
    scanner = new Html5Qrcode('scan-box');
    await scanner.start({facingMode:'environment'}, {fps:10, qrbox:220}, text => { stopScan(); useScannedCode(text); });
  } catch {
    stopScan();
    $('entry-error').textContent = t('code.camFail');
  }
}
function stopScan(){
  const s = scanner;
  scanner = null;
  $('scan-box').hidden = true;
  if(!s) return;
  // stop() throws synchronously if the camera never started, so wrap it in a promise
  Promise.resolve().then(() => s.isScanning ? s.stop() : null).catch(() => {}).finally(() => { try { s.clear(); } catch {} });
}
function useScannedCode(text){
  const [tag, dealId, code] = String(text).split(':');
  const req = reqById(codeTarget);
  if(tag !== 'roamly' || !code){ $('entry-error').textContent = t('code.notRoamly'); return; }
  if(dealId !== req?.chain.dealId){ $('entry-error').textContent = t('code.otherDeal'); return; }
  $('code-input').value = formatCode(normalizeCode(code));
  submitCode();
}
function closeEntryDialog(){
  stopScan();
  $('entry-dialog').close();
}
async function submitCode(){
  const req = reqById(codeTarget);
  const code = normalizeCode($('code-input').value);
  if(!req) return;
  if(code.length !== 16){ $('entry-error').textContent = t('code.len'); return; }
  // check against the on-chain hash first, so a typo doesn't cost a transaction
  if(req.deal?.codeHash && ethers.id(code) !== req.deal.codeHash){ $('entry-error').textContent = chainError('WrongCode'); return; }
  closeEntryDialog();
  if(await chainAction(req, 'code', code)) toast(t('toast.codeOk'));
}

// ---------- Rendering ----------
function renderWallet(){
  const btn = $('wallet-btn');
  if(!btn) return;
  const label = $('wallet-label');
  btn.classList.toggle('connected', chainReady());
  btn.classList.toggle('warn', !!wallet.account && !wallet.dep);
  if(chainReady()) label.textContent = shortAddr(wallet.account);
  else if(wallet.account) label.textContent = t('wallet.wrongNet');
  else label.textContent = t('wallet.connect');
  btn.setAttribute('aria-label', chainReady() ? t('wallet.aria', {addr:wallet.account}) : label.textContent);
  btn.title = chainReady() ? t('wallet.titleOn', {addr:wallet.account, net:networkName(wallet.chainId)}) : t('wallet.titleOff');

  $('lt-wallet').innerHTML = chainReady() ? t('lt.walletOn', {addr:esc(shortAddr(wallet.account))}) : t('lt.walletOff');

  const panel = $('wallet-panel');
  if(!chainReady()){
    panel.innerHTML = `
      <div><b>${t('panel.title')}</b>
        <span>${t('panel.text')}</span></div>
      <button class="btn btn-sm btn-primary" onclick="${wallet.account ? 'ensureNetwork().then(() => setupWallet(wallet.account)).catch(e => toast(friendlyError(e)))' : 'connectWallet()'}">${wallet.account ? t('panel.switch') : t('wallet.connect')}</button>`;
    return;
  }
  panel.innerHTML = `
    <div><b>${esc(shortAddr(wallet.account))} · ${wallet.balance === null ? '…' : esc(fmtUnits(wallet.balance))}</b>
      <span>${esc(t('panel.info', {net:networkName(wallet.chainId), addr:shortAddr(wallet.dep.escrow), fee:fmtNum(wallet.dep.feeBps / 100)}))}</span></div>
    ${wallet.dep.testToken ? `<button class="btn btn-sm btn-sand" onclick="getTestTokens()">${t('panel.faucet')}</button>` : ''}`;
}

// Meta line + buttons for an on-chain request on the dashboard
function chainItemMeta(req){
  const last = req.chain.txs[req.chain.txs.length - 1];
  const deposit = BigInt(req.chain.deposit || 0);
  const depText = deposit > 0n ? t(req.deal?.accepted ? 'meta.depEach' : 'meta.dep', {d:fmtDeal(req, deposit)}) : '';
  return `<p class="chain-meta">${esc(t('meta.deal', {id:req.chain.dealId, amt:fmtDeal(req, req.chain.amount), dep:depText}))}${txLink(req.chain.chainId, last)}</p>${receiptLine(req)}${reviewLines(req)}`;
}

function chainHint(req, side){
  const d = req.deal;
  if(!d) return '';
  const now = nowSec();
  if(d.status === 'Funded') return side === 'buyer'
    ? t('hint.fundedBuyer', {name:esc(travelerName(tripById(req.tripId)) || t('role.traveler'))})
    : t('hint.fundedTraveler', {dep:esc(fmtDeal(req, req.chain.deposit || 0))});
  if(d.status === 'Accepted'){
    if(now > d.deliverBy) return t('hint.deadlinePassed');
    return side === 'buyer' && req.chain.code
      ? t('hint.acceptedBuyer', {date:fmtSecDay(d.deliverBy)})
      : t('hint.acceptedTraveler', {date:fmtSecDay(d.deliverBy)});
  }
  if(d.status === 'Delivered'){
    const due = d.deliveredAt + CONFIRM_WINDOW;
    return now >= due ? t('hint.windowOver') : t('hint.autoPay', {date:fmtSecDay(due)});
  }
  return '';
}

function chainButtons(req, side){
  const d = req.deal;
  if(!d) return '';
  const now = nowSec();
  const b = (act, label, cls = 'btn-ghost') => `<button class="btn btn-sm ${cls}" data-act="${act}" data-id="${req.id}">${label}</button>`;
  const out = [];
  if(side === 'buyer'){
    if(d.status === 'Funded') out.push(b('cancel', t('btn.cancelRefund')));
    if(req.chain.code && (d.status === 'Accepted' || d.status === 'Delivered')) out.push(b('show-code', t('btn.showCode'), 'btn-primary'));
    if(d.status === 'Accepted' || (d.status === 'Delivered' && now < d.deliveredAt + CONFIRM_WINDOW))
      out.push(b('confirm', t('btn.confirm'), req.chain.code ? 'btn-outline' : 'btn-primary'), b('dispute', t('btn.dispute')));
    if(d.status === 'Delivered' && now >= d.deliveredAt + CONFIRM_WINDOW) out.push(b('confirm', t('btn.confirm'), 'btn-primary'));
    if((d.status === 'Funded' || d.status === 'Accepted') && now > d.deliverBy) out.push(b('claim-refund', t('btn.claimRefund'), 'btn-outline'));
  } else {
    if(d.status === 'Funded') out.push(b('accept', t('btn.accept'), 'btn-primary'), b('decline', t('btn.decline')));
    const hasCode = d.codeHash && d.codeHash !== ethers.ZeroHash;
    if(hasCode && (d.status === 'Accepted' || d.status === 'Delivered')) out.push(b('enter-code', t('btn.enterCode'), 'btn-primary'));
    if(d.status === 'Accepted') out.push(b('deliver', hasCode ? t('btn.deliveredNoCode') : t('btn.markDelivered'), hasCode ? 'btn-ghost' : 'btn-primary'));
    if(d.status === 'Delivered' && now >= d.deliveredAt + CONFIRM_WINDOW) out.push(b('claim-pay', t('btn.claimPay'), 'btn-primary'));
  }
  if(d.status === 'Disputed') out.push(b('dispute', t('btn.viewDispute')));
  if(req.receipt) out.push(b('view-receipt', t('btn.viewReceipt')));
  else if(side === 'traveler' && ['Accepted','Delivered','Disputed'].includes(d.status)) out.push(b('receipt', t('btn.attachReceipt')));
  if(canRate(req, side)) out.push(b('rate', side === 'buyer' ? t('btn.rateTraveler') : t('btn.rateBuyer'), 'btn-sand'));
  return out.join('');
}

// Detail page: tell the buyer how this request will be paid
function renderPayMode(trip){
  const onChain = canPayOnChain(trip);
  $('pay-by').textContent = onChain ? `${wallet.symbol} (BNB Smart Chain)` : t('pay.byDemo');
  $('pay-held').textContent = onChain ? t('pay.heldChain') : t('pay.heldDemo');
  $('pay-release').textContent = onChain ? t('pay.releaseChain') : t('pay.releaseDemo');
  const note = $('pay-note');
  const price = parseFloat($('price-input').value) || 0;
  if(onChain){
    const units = eurToUnits(price);
    const amt = price > 0 ? `<b>${esc(fmtUnits(units))}</b> (${eur(price)})` : esc(t('pay.amountUnknown', {sym:wallet.symbol}));
    const dep = price > 0 ? `<b>${esc(fmtUnits(depositFor(units)))}</b>` : `${fmtNum(Number(wallet.depositBps) / 100)}%`;
    const deliverBy = fmtSecDay(Math.floor(parseDay(trip.date).getTime() / 1000) + DELIVER_GRACE_DAYS * 86400);
    note.innerHTML = t('pay.amount', {amt}) +
      (wallet.depositBps > 0n ? t('pay.deposit', {dep}) : t('pay.noDeposit')) +
      esc(t('pay.deliverBy', {name:trip.mine ? t('pay.theTraveler') : trip.traveler, date:deliverBy})) +
      `<span class="rate-line${fx.source === 'live' ? '' : ' warn'}">${esc(rateLabel())}</span>`;
  } else if(trip?.wallet && !chainReady()){
    note.innerHTML = t('pay.connectHint', {name:esc(travelerName(trip))});
  } else {
    note.textContent = t('pay.demo');
  }
}

// Dispute page: let the two sides agree on a split, or settle 50/50 after 30 days
function renderChainDispute(req){
  const box = $('dispute-chain');
  const show = !!req?.chain && req.status === 'disputed' && !!req.deal;
  box.style.display = show ? 'block' : 'none';
  if(!show) return;
  const d = req.deal;
  const role = chainRole(req);
  const offer = v => v === '0' ? t('dc.noOffer') : t('dc.offer', {amt:fmtDeal(req, BigInt(v) - 1n)});
  $('dc-amount').textContent = fmtDeal(req, req.chain.amount);
  $('dc-buyer').textContent = offer(d.buyerOffer);
  $('dc-traveler').textContent = offer(d.travelerOffer);
  $('dc-role').textContent = role ? t('dc.role', {role:t('role.' + role)}) : t('dc.connect');
  $('dc-unit').textContent = req.chain.symbol;
  const theirs = role === 'buyer' ? d.travelerOffer : role === 'traveler' ? d.buyerOffer : '0';
  $('dc-match').style.display = theirs !== '0' ? 'inline-flex' : 'none';
  $('dc-match').dataset.offer = theirs !== '0' ? (BigInt(theirs) - 1n).toString() : '';
  const due = d.disputedAt + DISPUTE_WINDOW;
  const canSettle = nowSec() >= due;
  $('dc-deadline').textContent = canSettle
    ? t('dc.canSettle')
    : t('dc.deadline', {date:fmtSecDay(due), dep:fmtDeal(req, d.buyerDeposit || 0)});
  $('dc-settle').style.display = canSettle ? 'inline-flex' : 'none';
}

async function proposeSplitUI(units){
  const req = reqById(state.disputeId);
  if(!req?.chain) return;
  let toBuyer = units;
  if(toBuyer === undefined){
    const v = parseFloat($('dc-refund').value);
    if(!(v >= 0)){ toast(t('dc.errAmount')); return; }
    toBuyer = ethers.parseUnits(v.toFixed(2), req.chain.decimals);
  }
  if(BigInt(toBuyer) > BigInt(req.chain.amount)){ toast(t('dc.errTooMuch', {amt:fmtDeal(req, req.chain.amount)})); return; }
  if(await chainAction(req, 'propose', toBuyer)){
    $('dc-refund').value = '';
    toast(req.status === 'disputed' ? t('dc.sent') : t('dc.agreed'));
  }
}

async function settleUI(){
  const req = reqById(state.disputeId);
  if(req?.chain && await chainAction(req, 'settle')) toast(t('dc.settled'));
}

// Reconnect silently if the site was already authorised, and keep deals in sync
function initChain(){
  loadRate();
  setInterval(loadRate, 60 * 60 * 1000);
  if(!hasEthers || !window.ethereum) return;
  window.ethereum.request({method:'eth_accounts'}).then(([a]) => a && setupWallet(a)).catch(() => {});
  window.ethereum.on?.('accountsChanged', ([a]) => setupWallet(a || null).catch(() => {}));
  window.ethereum.on?.('chainChanged', () => setupWallet(wallet.account).catch(() => {}));
  setInterval(syncDeals, 15000);
}
