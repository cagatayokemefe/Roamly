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
  'function getDeal(uint256 id) view returns (tuple(address buyer, address traveler, uint128 amount, uint64 deliverBy, uint64 deliveredAt, uint64 disputedAt, uint8 status, uint128 buyerOffer, uint128 travelerOffer))',
  'event DealCreated(uint256 indexed id, address indexed buyer, address indexed traveler, uint256 amount, uint64 deliverBy, bytes32 ref)',
  'error InvalidParams()', 'error NotBuyer()', 'error NotTraveler()', 'error NotParty()',
  'error WrongStatus(uint8 current)', 'error TooEarly()', 'error TooLate()',
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
};

const wallet = {account:null, chainId:null, dep:null, escrow:null, token:null, decimals:18, symbol:'USDT', balance:null, busy:false};
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
    const [decimals, symbol] = await Promise.all([wallet.token.decimals(), wallet.token.symbol()]);
    wallet.decimals = Number(decimals);
    wallet.symbol = symbol;
    await syncDeals();
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

// Approve + lock the buyer's payment. Returns the chain record for the request, or null.
async function payOnChain(req, trip){
  const amount = eurToUnits(req.price);
  await refreshBalance();
  if(wallet.balance !== null && wallet.balance < amount){
    toast(`You need ${fmtUnits(amount)} but have ${fmtUnits(wallet.balance)}.` + (wallet.dep.testToken ? ' Use “Get test USDT” on your dashboard.' : ''));
    return null;
  }
  const allowance = await wallet.token.allowance(wallet.account, wallet.dep.escrow);
  if(allowance < amount && !await sendTx(`Allowing Roamly escrow to take ${fmtUnits(amount)}`, () => wallet.token.approve(wallet.dep.escrow, amount))) return null;
  const deliverBy = Math.floor(parseDay(trip.date).getTime() / 1000) + DELIVER_GRACE_DAYS * 86400;
  const receipt = await sendTx(`Locking ${fmtUnits(amount)} in escrow`,
    () => wallet.escrow.createDeal(trip.wallet, amount, deliverBy, ethers.encodeBytes32String(req.id)));
  if(!receipt) return null;
  const created = receipt.logs.map(l => { try { return wallet.escrow.interface.parseLog(l); } catch { return null; } })
    .find(l => l?.name === 'DealCreated');
  refreshBalance();
  return {dealId:created.args.id.toString(), chainId:wallet.chainId, escrow:wallet.dep.escrow, amount:amount.toString(), decimals:wallet.decimals,
          symbol:wallet.symbol, buyer:wallet.account, traveler:trip.wallet, txs:[receipt.hash]};
}

async function chainAction(req, act, ...args){
  if(!chainReady()){ toast('Connect your wallet to manage on-chain deals.'); return false; }
  if(req.chain.chainId !== wallet.chainId){ toast(`This deal lives on ${networkName(req.chain.chainId)} — switch network in MetaMask.`); return false; }
  if(!isCurrentContract(req)){ toast('This deal belongs to an older Roamly contract.'); return false; }
  const a = CHAIN_ACTIONS[act];
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
  const amt = fmtDeal(req, req.chain.amount);
  const net = fmtDeal(req, BigInt(req.chain.amount) * BigInt(10000 - (DEPLOYMENTS[req.chain.chainId]?.feeBps ?? 200)) / 10000n);
  return {
    Accepted:'Accepted — funds stay locked in the contract',
    Delivered:'Traveler marked it delivered — 7 days to confirm or dispute',
    Disputed:`Dispute opened${req.dispute ? ` — ${req.dispute.reason.toLowerCase()}` : ''} — funds frozen in the contract`,
    Released:`Released — ${net} to traveler (2% fee)`,
    Refunded:`Refunded — ${amt} back to buyer`,
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
              buyerOffer:d.buyerOffer.toString(), travelerOffer:d.travelerOffer.toString()};
  if(prev === s){ save(); return false; }
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
  if(changed) renderAll();
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
  return `<p class="chain-meta">⛓ Deal #${esc(req.chain.dealId)} · ${esc(fmtDeal(req, req.chain.amount))} in contract · ${txLink(req.chain.chainId, last)}</p>`;
}

function chainHint(req, side){
  const d = req.deal;
  if(!d) return '';
  const now = nowSec();
  if(d.status === 'Funded') return side === 'buyer'
    ? `Funds are locked in the contract. If ${esc(tripById(req.tripId)?.traveler || 'the traveler')} doesn't accept, cancel any time for a full refund.`
    : 'The buyer’s money is already locked in the contract — accept to commit to carrying it.';
  if(d.status === 'Accepted') return now > d.deliverBy
    ? 'The delivery deadline has passed — the buyer can reclaim the funds.'
    : `Deliver by ${fmtSecDay(d.deliverBy)}, or the buyer can reclaim the funds.`;
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
    note.innerHTML = `Pays ${price > 0 ? `<b>${esc(fmtUnits(eurToUnits(price)))}</b> (€${price} × ${EUR_TO_USDT})` : 'the price in ' + esc(wallet.symbol)} into the escrow contract. ` +
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
    ? 'No agreement after 30 days — anyone can now split the funds 50/50.'
    : `If you don't agree by ${fmtSecDay(due)}, the contract lets anyone split it 50/50.`;
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
