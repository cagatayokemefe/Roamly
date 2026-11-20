// ---------- On-chain escrow (BNB Smart Chain) ----------
// Talks to RoamlyEscrow through the browser wallet (MetaMask). A request on a trip whose
// traveler linked a wallet is paid into the contract; everything else stays in demo mode.

const EUR_TO_USDT = 1.08; // fixed demo rate — a live app would read a price feed
const DEPLOYMENTS = {...window.ROAMLY_DEPLOYMENTS, ...window.ROAMLY_LOCAL_DEPLOYMENTS};
const NETWORKS = {
  97: {chainId:'0x61', chainName:'BNB Smart Chain Testnet', rpcUrls:['https://data-seed-prebsc-1-s1.bnbchain.org:8545'],
       nativeCurrency:{name:'tBNB', symbol:'tBNB', decimals:18}, blockExplorerUrls:['https://testnet.bscscan.com']},
  31337: {chainId:'0x7a69', chainName:'Hardhat Local', rpcUrls:['http://127.0.0.1:8545'],
          nativeCurrency:{name:'ETH', symbol:'ETH', decimals:18}, blockExplorerUrls:null},
};
const ESCROW_ABI = [
  'function createDeal(address traveler, uint128 amount, uint64 deliverBy, bytes32 ref) returns (uint256)',
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
  'function getDeal(uint256 id) view returns (tuple(address buyer, address traveler, uint128 amount, uint64 deliverBy, uint64 deliveredAt, uint64 disputedAt, uint8 status, uint128 buyerOffer, uint128 travelerOffer, bool accepted, uint128 buyerDeposit, uint128 travelerDeposit))',
  'function depositBps() view returns (uint16)',
  'function rate(uint256 id, uint8 stars, string comment)',
  'function getReviews(uint256 id) view returns (tuple(uint8 stars, string comment) byBuyer, tuple(uint8 stars, string comment) byTraveler)',
  'function reputation(address) view returns (uint64 count, uint64 totalStars)',
  'event DealCreated(uint256 indexed id, address indexed buyer, address indexed traveler, uint256 amount, uint64 deliverBy, bytes32 ref)',
  'error InvalidParams()', 'error NotBuyer()', 'error NotTraveler()', 'error NotParty()',
  'error WrongStatus(uint8 current)', 'error TooEarly()', 'error TooLate()', 'error AlreadyRated()',
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
const CHAIN_ERRORS = {
  NotBuyer:'Only the buyer’s wallet can do this — switch accounts in MetaMask.',
  NotTraveler:'Only the traveler’s wallet can do this — switch accounts in MetaMask.',
  NotParty:'Only the buyer or the traveler can propose a split.',
  WrongStatus:'This deal has already moved on — refreshing it.',
  TooEarly:'Too early — the waiting period hasn’t ended yet.',
  TooLate:'Too late — that window has closed.',
  InvalidParams:'The contract rejected these details.',
  AlreadyRated:'You’ve already rated this deal — ratings can’t be changed.',
};
const CHAIN_ACTIONS = {
  cancel:        {fn:'cancel',          pending:'Cancelling and refunding'},
  decline:       {fn:'decline',         pending:'Declining and refunding the buyer'},
  accept:        {fn:'accept',          pending:'Accepting the request'},
  deliver:       {fn:'markDelivered',   pending:'Marking as delivered'},
  confirm:       {fn:'confirmDelivery', pending:'Releasing payment to the traveler'},
  dispute:       {fn:'openDispute',     pending:'Opening a dispute'},
  'claim-pay':   {fn:'claimPayment',    pending:'Claiming your payment'},
  'claim-refund':{fn:'claimRefund',     pending:'Claiming your refund'},
  propose:       {fn:'proposeSplit',    pending:'Sending your offer'},
  settle:        {fn:'settleStalemate', pending:'Settling 50/50'},
  rate:          {fn:'rate',            pending:'Saving your rating on-chain'},
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
const fmtSecDay = s => new Date(s * 1000).toLocaleDateString('en-GB', {day:'numeric', month:'short'});

function canPayOnChain(trip){
  return chainReady() && !!trip?.wallet && !sameAddr(trip.wallet, wallet.account);
}
function eurToUnits(eur){
  return ethers.parseUnits((Math.round(eur * EUR_TO_USDT * 100) / 100).toFixed(2), wallet.decimals);
}
// Refundable deposit each side locks — same formula as the contract's depositFor()
const depositFor = units => BigInt(units) * wallet.depositBps / 10000n;
function fmtUnits(units, decimals = wallet.decimals, symbol = wallet.symbol){
  const n = Number(ethers.formatUnits(BigInt(units), decimals));
  return `${n.toLocaleString('en-GB', {maximumFractionDigits:2})} ${symbol}`;
}
const fmtDeal = (req, units) => fmtUnits(units, req.chain.decimals, req.chain.symbol);
function txLink(chainId, hash){
  const base = NETWORKS[chainId]?.blockExplorerUrls?.[0];
  return base ? `<a class="link" href="${base}/tx/${hash}" target="_blank" rel="noopener">view tx ↗</a>` : '';
}
function chainRole(req){
  if(sameAddr(wallet.account, req.chain?.buyer)) return 'buyer';
  if(sameAddr(wallet.account, req.chain?.traveler)) return 'traveler';
  return null;
}

function friendlyError(e){
  if(e?.code === 'ACTION_REJECTED' || e?.code === 4001 || e?.info?.error?.code === 4001) return 'Cancelled in your wallet.';
  if(e?.revert?.name) return CHAIN_ERRORS[e.revert.name] || e.revert.name;
  const data = e?.data?.data ?? e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  try {
    const parsed = data && wallet.escrow?.interface.parseError(data);
    if(parsed) return CHAIN_ERRORS[parsed.name] || parsed.name;
  } catch {}
  return e?.shortMessage || e?.message || 'Something went wrong with the transaction.';
}

// ---------- Wallet connection ----------
async function connectWallet(){
  if(!hasEthers){ toast('Couldn’t load the blockchain library — check your connection.'); return; }
  if(!window.ethereum){
    toast('Install MetaMask to pay on-chain — demo mode keeps working without it.');
    window.open('https://metamask.io/download/', '_blank', 'noopener');
    return;
  }
  try {
    const [account] = await window.ethereum.request({method:'eth_requestAccounts'});
    await ensureNetwork();
    await setupWallet(account);
    if(chainReady()) toast(`Wallet connected — ${shortAddr(wallet.account)} on ${networkName(wallet.chainId)}`);
  } catch(e){ toast(friendlyError(e)); }
}

// Switch the wallet to a chain the contracts are deployed on (testnet first)
async function ensureNetwork(){
  const current = parseInt(await window.ethereum.request({method:'eth_chainId'}), 16);
  if(DEPLOYMENTS[current]) return;
  const target = DEPLOYMENTS[97] ? 97 : Number(Object.keys(DEPLOYMENTS)[0]);
  if(!target) throw new Error('The escrow contract isn’t deployed yet — run npm run deploy:testnet.');
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
  const receipt = await sendTx('Minting 1,000 test USDT', () => wallet.token.faucet());
  if(receipt){ await refreshBalance(); toast(`Added 1,000 ${wallet.symbol} to your wallet`); }
}

// ---------- Transactions ----------
async function sendTx(pending, fn){
  if(wallet.busy){ toast('Finish the open transaction in your wallet first.'); return null; }
  wallet.busy = true;
  document.body.classList.add('tx-busy');
  try {
    toast(`${pending} — confirm in your wallet…`);
    const tx = await fn();
    toast(`${pending} — waiting for the block…`);
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
    toast(`You need ${fmtUnits(units)} but have ${fmtUnits(wallet.balance)}.` + (wallet.dep.testToken ? ' Use “Get test USDT” on your dashboard.' : ''));
    return false;
  }
  const allowance = await wallet.token.allowance(wallet.account, wallet.dep.escrow);
  if(allowance >= units) return true;
  return !!await sendTx(`Allowing Roamly escrow to take ${fmtUnits(units)}`, () => wallet.token.approve(wallet.dep.escrow, units));
}

// Approve + lock the buyer's payment and deposit. Returns the chain record for the request, or null.
async function payOnChain(req, trip){
  const amount = eurToUnits(req.price);
  const deposit = depositFor(amount);
  if(!await ensureFunds(amount + deposit)) return null;
  const deliverBy = Math.floor(parseDay(trip.date).getTime() / 1000) + DELIVER_GRACE_DAYS * 86400;
  const receipt = await sendTx(`Locking ${fmtUnits(amount)} + ${fmtUnits(deposit)} deposit in escrow`,
    () => wallet.escrow.createDeal(trip.wallet, amount, deliverBy, ethers.encodeBytes32String(req.id)));
  if(!receipt) return null;
  const created = receipt.logs.map(l => { try { return wallet.escrow.interface.parseLog(l); } catch { return null; } })
    .find(l => l?.name === 'DealCreated');
  refreshBalance();
  return {dealId:created.args.id.toString(), chainId:wallet.chainId, escrow:wallet.dep.escrow, amount:amount.toString(), deposit:deposit.toString(), decimals:wallet.decimals,
          symbol:wallet.symbol, buyer:wallet.account, traveler:trip.wallet, txs:[receipt.hash]};
}

async function chainAction(req, act, ...args){
  if(!chainReady()){ toast('Connect your wallet to manage on-chain deals.'); return false; }
  if(req.chain.chainId !== wallet.chainId){ toast(`This deal lives on ${networkName(req.chain.chainId)} — switch network in MetaMask.`); return false; }
  if(!isCurrentContract(req)){ toast('This deal belongs to an older Roamly contract.'); return false; }
  const a = CHAIN_ACTIONS[act];
  // Accepting locks the traveler's deposit, so the escrow needs permission to take it first
  if(act === 'accept' && !await ensureFunds(BigInt(req.chain.deposit || 0))) return false;
  const receipt = await sendTx(a.pending, () => wallet.escrow[a.fn](req.chain.dealId, ...args));
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
function chainHistoryLabel(req, s){
  const d = req.deal || {};
  const refunded = fmtDeal(req, BigInt(req.chain.amount) + BigInt(d.buyerDeposit || 0) + BigInt(d.travelerDeposit || 0));
  const net = fmtDeal(req, BigInt(req.chain.amount) * BigInt(10000 - (DEPLOYMENTS[req.chain.chainId]?.feeBps ?? 200)) / 10000n);
  return {
    Accepted:`Accepted — traveler locked a ${fmtDeal(req, d.travelerDeposit || 0)} deposit too`,
    Delivered:'Traveler marked it delivered — 7 days to confirm or dispute',
    Disputed:`Dispute opened${req.dispute ? ` — ${req.dispute.reason.toLowerCase()}` : ''} — funds frozen in the contract`,
    Released:`Released — ${net} to traveler (2% fee), deposits returned`,
    Refunded:`Refunded — ${refunded} back to buyer${BigInt(d.travelerDeposit || 0) > 0n && d.status === 'Refunded' && req.chain.intent === 'claim-refund' ? ', including the traveler’s deposit' : ''}`,
    Split:'Settled by split — paid out by the contract',
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
              buyerDeposit:d.buyerDeposit.toString(), travelerDeposit:d.travelerDeposit.toString()};
  let reviewsChanged = false;
  if(d.accepted && FINAL_DEALS.includes(s)){
    const [byBuyer, byTraveler] = await wallet.escrow.getReviews(req.chain.dealId);
    const reviews = {byBuyer:{stars:Number(byBuyer.stars), comment:byBuyer.comment}, byTraveler:{stars:Number(byTraveler.stars), comment:byTraveler.comment}};
    reviewsChanged = JSON.stringify(reviews) !== JSON.stringify(req.reviews);
    req.reviews = reviews;
  }
  if(prev === s){ save(); return reviewsChanged; }
  const next = appStatusFor(req, s);
  const label = chainHistoryLabel(req, s);
  if(next !== req.status) setStatus(req, next, label);
  else { if(label) req.history.push({label, at:nowIso()}); save(); }
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
  if(!rep.count) return short ? 'New traveler' : 'No ratings yet';
  const avg = (rep.total / rep.count).toFixed(1);
  return short ? `★ ${avg} on-chain` : `★ ${avg} · ${rep.count} on-chain rating${rep.count === 1 ? '' : 's'}`;
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
  return line('from buyer', r.byBuyer) + line('from traveler', r.byTraveler);
}

let rateTarget = null, rateStars = 0;
function openRateDialog(req){
  const role = chainRole(req);
  if(!role){ toast('Connect the buyer’s or traveler’s wallet to rate this deal.'); return; }
  if(!canRate(req, role)){ toast(CHAIN_ERRORS.AlreadyRated); return; }
  rateTarget = req.id;
  const trip = tripById(req.tripId);
  $('rate-title').textContent = role === 'buyer' ? `Rate ${trip?.mine ? 'the traveler' : trip?.traveler || 'the traveler'}` : 'Rate the buyer';
  $('rate-sub').textContent = `${req.item} · saved on-chain for good — it can’t be edited or deleted.`;
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
  if(!rateStars){ $('rate-error').textContent = 'Pick 1 to 5 stars.'; return; }
  if([...comment].length > MAX_COMMENT){ $('rate-error').textContent = `Keep the comment under ${MAX_COMMENT} characters.`; return; }
  $('rate-dialog').close();
  if(await chainAction(req, 'rate', rateStars, comment)){
    await loadReputations();
    renderAll();
    toast('Thanks — your rating is saved on-chain');
  }
}

// ---------- Rendering ----------
function renderWallet(){
  const btn = $('wallet-btn');
  if(!btn) return;
  const label = $('wallet-label');
  btn.classList.toggle('connected', chainReady());
  btn.classList.toggle('warn', !!wallet.account && !wallet.dep);
  if(chainReady()) label.textContent = shortAddr(wallet.account);
  else if(wallet.account) label.textContent = 'Wrong network';
  else label.textContent = 'Connect wallet';
  btn.setAttribute('aria-label', chainReady() ? `Wallet ${wallet.account}` : label.textContent);
  btn.title = chainReady() ? `${wallet.account} on ${networkName(wallet.chainId)}` : 'Connect a wallet to pay through the escrow contract';

  $('lt-wallet').innerHTML = chainReady()
    ? `Buyers will pay into the escrow contract. Payouts go to your wallet <b>${esc(shortAddr(wallet.account))}</b>.`
    : `<span class="link" onclick="connectWallet()">Connect a wallet</span> so buyers can pay you through the escrow contract — otherwise this trip runs in demo mode.`;

  const panel = $('wallet-panel');
  if(!chainReady()){
    panel.innerHTML = `
      <div><b>Pay through a smart contract</b>
        <span>Connect MetaMask and your payment is locked in the Roamly escrow contract on BNB Smart Chain — not held by Roamly or the traveler.</span></div>
      <button class="btn btn-sm btn-primary" onclick="${wallet.account ? 'ensureNetwork().then(() => setupWallet(wallet.account)).catch(e => toast(friendlyError(e)))' : 'connectWallet()'}">${wallet.account ? 'Switch network' : 'Connect wallet'}</button>`;
    return;
  }
  panel.innerHTML = `
    <div><b>${esc(shortAddr(wallet.account))} · ${wallet.balance === null ? '…' : esc(fmtUnits(wallet.balance))}</b>
      <span>${esc(networkName(wallet.chainId))} · escrow ${esc(shortAddr(wallet.dep.escrow))} · ${wallet.dep.feeBps / 100}% fee on payouts, none on refunds</span></div>
    ${wallet.dep.testToken ? '<button class="btn btn-sm btn-sand" onclick="getTestTokens()">Get test USDT</button>' : ''}`;
}

// Meta line + buttons for an on-chain request on the dashboard
function chainItemMeta(req){
  const last = req.chain.txs[req.chain.txs.length - 1];
  const deposit = BigInt(req.chain.deposit || 0);
  const depText = deposit > 0n ? ` + ${esc(fmtDeal(req, deposit))} deposit${req.deal?.accepted ? ' each' : ''}` : '';
  return `<p class="chain-meta">⛓ Deal #${esc(req.chain.dealId)} · ${esc(fmtDeal(req, req.chain.amount))}${depText} in contract · ${txLink(req.chain.chainId, last)}</p>${reviewLines(req)}`;
}

function chainHint(req, side){
  const d = req.deal;
  if(!d) return '';
  const now = nowSec();
  if(d.status === 'Funded') return side === 'buyer'
    ? `Funds are locked in the contract. If ${esc(tripById(req.tripId)?.traveler || 'the traveler')} doesn't accept, cancel any time for a full refund.`
    : `The buyer’s money is already locked in the contract. Accepting locks your refundable ${esc(fmtDeal(req, req.chain.deposit || 0))} deposit — you only lose it if you miss the delivery deadline.`;
  if(d.status === 'Accepted') return now > d.deliverBy
    ? 'The delivery deadline has passed — the buyer can reclaim the funds plus the traveler’s deposit.'
    : `Deliver by ${fmtSecDay(d.deliverBy)}, or the buyer can reclaim the funds plus the traveler’s deposit.`;
  if(d.status === 'Delivered'){
    const due = d.deliveredAt + CONFIRM_WINDOW;
    return now >= due
      ? 'The 7-day window has ended — the traveler can claim the payment.'
      : `Pays out automatically from ${fmtSecDay(due)} unless the buyer confirms sooner or disputes.`;
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
    if(d.status === 'Funded') out.push(b('cancel', 'Cancel & refund'));
    if(d.status === 'Accepted' || (d.status === 'Delivered' && now < d.deliveredAt + CONFIRM_WINDOW))
      out.push(b('confirm', 'Confirm received', 'btn-primary'), b('dispute', 'Raise a dispute'));
    if(d.status === 'Delivered' && now >= d.deliveredAt + CONFIRM_WINDOW) out.push(b('confirm', 'Confirm received', 'btn-primary'));
    if((d.status === 'Funded' || d.status === 'Accepted') && now > d.deliverBy) out.push(b('claim-refund', 'Claim refund', 'btn-outline'));
  } else {
    if(d.status === 'Funded') out.push(b('accept', 'Accept', 'btn-primary'), b('decline', 'Decline'));
    if(d.status === 'Accepted') out.push(b('deliver', 'Mark delivered', 'btn-primary'));
    if(d.status === 'Delivered' && now >= d.deliveredAt + CONFIRM_WINDOW) out.push(b('claim-pay', 'Claim payment', 'btn-primary'));
  }
  if(d.status === 'Disputed') out.push(b('dispute', 'View dispute'));
  if(canRate(req, side)) out.push(b('rate', side === 'buyer' ? '★ Rate the traveler' : '★ Rate the buyer', 'btn-sand'));
  return out.join('');
}

// Detail page: tell the buyer how this request will be paid
function renderPayMode(trip){
  const onChain = canPayOnChain(trip);
  $('pay-by').textContent = onChain ? `${wallet.symbol} (BNB Smart Chain)` : 'Card (demo)';
  $('pay-held').textContent = onChain ? 'Smart contract — no one holds it' : 'Escrow';
  $('pay-release').textContent = onChain ? 'When you confirm, or 7 days after delivery' : 'When you confirm delivery';
  const note = $('pay-note');
  const price = parseFloat($('price-input').value) || 0;
  if(onChain){
    const units = eurToUnits(price);
    note.innerHTML = `Pays ${price > 0 ? `<b>${esc(fmtUnits(units))}</b> (€${price} × ${EUR_TO_USDT})` : 'the price in ' + esc(wallet.symbol)} into the escrow contract` +
      (wallet.depositBps > 0n ? `, plus a refundable ${price > 0 ? `<b>${esc(fmtUnits(depositFor(units)))}</b>` : `${wallet.depositBps / 100n}%`} deposit you get back unless a dispute runs out the 30 days. ` : '. ') +
      `${trip.mine ? 'The traveler' : esc(trip.traveler)} must deliver by ${fmtSecDay(Math.floor(parseDay(trip.date).getTime() / 1000) + DELIVER_GRACE_DAYS * 86400)} or you can reclaim it.`;
  } else if(trip?.wallet && !chainReady()){
    note.innerHTML = `${esc(trip.traveler)} accepts on-chain payment. <span class="link" onclick="connectWallet()">Connect your wallet</span> to pay through the escrow contract.`;
  } else {
    note.textContent = 'This traveler hasn’t linked a wallet, so the request runs in demo escrow.';
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
  const offer = v => v === '0' ? 'No offer yet' : `${fmtDeal(req, BigInt(v) - 1n)} back to buyer`;
  $('dc-amount').textContent = fmtDeal(req, req.chain.amount);
  $('dc-buyer').textContent = offer(d.buyerOffer);
  $('dc-traveler').textContent = offer(d.travelerOffer);
  $('dc-role').textContent = role ? `You're the ${role} on this deal.` : 'Connect the buyer’s or traveler’s wallet to make an offer.';
  $('dc-unit').textContent = req.chain.symbol;
  const theirs = role === 'buyer' ? d.travelerOffer : role === 'traveler' ? d.buyerOffer : '0';
  $('dc-match').style.display = theirs !== '0' ? 'inline-flex' : 'none';
  $('dc-match').dataset.offer = theirs !== '0' ? (BigInt(theirs) - 1n).toString() : '';
  const due = d.disputedAt + DISPUTE_WINDOW;
  const canSettle = nowSec() >= due;
  $('dc-deadline').textContent = canSettle
    ? 'No agreement after 30 days — anyone can now split the payment 50/50. The buyer’s deposit goes to the traveler.'
    : `If you don't agree by ${fmtSecDay(due)}, the contract lets anyone split the payment 50/50 — and the buyer’s ${fmtDeal(req, d.buyerDeposit || 0)} deposit goes to the traveler. Agree before then and both deposits are returned.`;
  $('dc-settle').style.display = canSettle ? 'inline-flex' : 'none';
}

async function proposeSplitUI(units){
  const req = reqById(state.disputeId);
  if(!req?.chain) return;
  let toBuyer = units;
  if(toBuyer === undefined){
    const v = parseFloat($('dc-refund').value);
    if(!(v >= 0)){ toast('Enter how much should go back to the buyer.'); return; }
    toBuyer = ethers.parseUnits(v.toFixed(2), req.chain.decimals);
  }
  if(BigInt(toBuyer) > BigInt(req.chain.amount)){ toast(`That's more than the ${fmtDeal(req, req.chain.amount)} in the contract.`); return; }
  if(await chainAction(req, 'propose', toBuyer)){
    $('dc-refund').value = '';
    toast(req.status === 'disputed' ? 'Offer sent — it pays out as soon as the other side proposes the same split.' : 'You both agreed — the contract paid out.');
  }
}

async function settleUI(){
  const req = reqById(state.disputeId);
  if(req?.chain && await chainAction(req, 'settle')) toast('Settled 50/50 by the contract.');
}

// Reconnect silently if the site was already authorised, and keep deals in sync
function initChain(){
  if(!hasEthers || !window.ethereum) return;
  window.ethereum.request({method:'eth_accounts'}).then(([a]) => a && setupWallet(a)).catch(() => {});
  window.ethereum.on?.('accountsChanged', ([a]) => setupWallet(a || null).catch(() => {}));
  window.ethereum.on?.('chainChanged', () => setupWallet(wallet.account).catch(() => {}));
  setInterval(syncDeals, 15000);
}
