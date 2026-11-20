// ---------- Constants ----------
const STORE_KEY = 'roamly-state-v1';
const OLD_STORE_KEY = 'tasi-state-v1'; // pre-rename key, read once so saved data carries over
const LIMIT = 430; // personal duty-free allowance per traveler, EUR
const CATEGORIES = ['Electronics','Clothing','Cosmetics','General','Alcohol'];
const CITIES = {
  PRG:{city:'Prague', tr:'Prag', region:'Europe'},
  BER:{city:'Berlin', region:'Europe'},
  LON:{city:'London', tr:'Londra', region:'Europe'},
  VIE:{city:'Vienna', tr:'Viyana', region:'Europe'},
  AMS:{city:'Amsterdam', region:'Europe'},
  PAR:{city:'Paris', region:'Europe'},
  DXB:{city:'Dubai', region:'Gulf'},
  DOH:{city:'Doha', region:'Gulf'},
  NYC:{city:'New York', region:'North America'},
  YYZ:{city:'Toronto', region:'North America'},
};
const ACTIVE = ['pending','escrow','disputed'];      // still in progress
const HOLDS_SLOT = ['pending','escrow','disputed','completed','split']; // uses capacity + allowance
const STATUS = {
  pending:  {cls:'pending', step:1},
  escrow:   {cls:'escrow',  step:2},
  disputed: {cls:'disputed',step:2},
  completed:{cls:'done',    step:4},
  split:    {cls:'done',    step:4},
  refunded: {cls:'muted',   step:0},
  declined: {cls:'muted',   step:0},
  cancelled:{cls:'muted',   step:0},
};

// ---------- Helpers ----------
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = p => p + Math.random().toString(36).slice(2, 9);
const nowIso = () => new Date().toISOString();
const eur = n => '€' + fmtNum(n);

function localDate(offsetDays = 0){
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
const parseDay = iso => new Date(iso + 'T00:00:00');
const fmtDay = iso => parseDay(iso).toLocaleDateString(LOCALE(), {day:'2-digit', month:'short'});
const fmtStamp = iso => new Date(iso).toLocaleDateString(LOCALE(), {day:'2-digit', month:'short'});
const daysFromToday = iso => Math.round((parseDay(iso) - parseDay(localDate())) / 86400000);
const initials = name => name.trim().charAt(0).toUpperCase();
const shortName = name => { const p = name.split(' '); return p.length > 1 ? `${p[0][0]}. ${p.slice(1).join(' ')}` : name; };
// Your own trips and requests are stored as "You"/"you"; show them in the current language
const travelerName = trip => trip?.mine ? t('you') : trip?.traveler || '';
const buyerName = req => req.buyer === 'you' ? t('you') : req.buyer;
// Demo trips carry a sample rating; on-chain trips show their on-chain one (until it loads: "New traveler")
const tripRating = trip => trip.chainTripId || !trip.rating ? t('side.newTraveler')
  : `★ ${fmtNum(trip.rating, {minimumFractionDigits:1, maximumFractionDigits:1})}`;
// History entries are stored as {k, v} (translation key + values); older saved ones as plain text
const histLabel = h => h.k ? t(h.k, h.v) : h.label;

// ---------- State ----------
function seed(){
  const t = (id, code, offset, traveler, capacity, categories, extra = {}) =>
    ({id, code, date:localDate(offset), traveler, capacity, categories, notes:'', mine:false, rating:4.8, completed:2, ...extra});
  const trips = [
    t('t1','PRG', 3,'Eliška Novák',2,['Electronics','Clothing','Cosmetics'],{rating:4.9, completed:4, notes:'Nothing that needs refrigeration or is oversized.'}),
    t('t2','BER', 5,'Marek D.',1,['Cosmetics'],{rating:4.7, completed:1}),
    t('t3','LON', 9,'Ayşe K.',3,['Electronics','General'],{rating:5.0, completed:7}),
    t('t4','DXB',12,'Rana Y.',2,['General'],{completed:3}),
    t('t5','NYC',16,'Tom B.',1,['Electronics'],{rating:4.6}),
    t('t6','VIE',20,'Sofia L.',2,['Clothing','Cosmetics'],{rating:4.9, completed:5}),
    t('t7','AMS', 6,'You',2,['Electronics','General'],{mine:true}),
    t('t8','PRG',-10,'You',1,['Clothing'],{mine:true}),
  ];
  const r = (id, tripId, item, price, category, buyer, status, history) =>
    ({id, tripId, item, link:'', price, category, buyer, status, history:history.map(([k, d]) => ({k, v:{price}, at:new Date(Date.now() + d*86400000).toISOString()}))});
  const requests = [
    r('r1','t1','Sony WH-1000XM6',249,'Electronics','you','escrow',[['hist.sent',-3],['hist.accepted',-2]]),
    r('r2','t2','Skincare set',85,'Cosmetics','you','pending',[['hist.sent',-1]]),
    r('r3','t8','Leather jacket',180,'Clothing','Can B.','completed',[['hist.sent',-16],['hist.accepted',-15],['hist.confirmed',-9]]),
    r('r4','t7','Nintendo Switch 2',329,'Electronics','Deniz A.','pending',[['hist.sent',0]]),
  ];
  return {trips, requests, filter:'all', selectedTripId:null, disputeId:null};
}

// Live mode keeps a separate cache per contract (trips come from the chain; the cache holds what only
// this browser knows, like delivery codes and receipt photos). Demo mode keeps the sample data.
const STATE_KEY = LIVE ? `roamly-live-${LIVE_CHAIN}-${DEPLOYMENTS[LIVE_CHAIN].escrow.toLowerCase()}` : STORE_KEY;
const emptyState = () => ({trips:[], requests:[], filter:'all', selectedTripId:null, disputeId:null});
let state;
try { state = JSON.parse(localStorage.getItem(STATE_KEY) || (LIVE ? null : localStorage.getItem(OLD_STORE_KEY))) || (LIVE ? emptyState() : seed()); }
catch { state = LIVE ? emptyState() : seed(); }
function save(){ try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch {} }

const tripById = id => state.trips.find(t => t.id === id);
const reqById = id => state.requests.find(r => r.id === id);
const tripRequests = trip => state.requests.filter(r => r.tripId === trip.id);
// On-chain trips carry their own counts (the contract tracks every request, not just ours)
const slotsUsed = trip => trip.chainTripId ? trip.slotsUsed : tripRequests(trip).filter(r => HOLDS_SLOT.includes(r.status)).length;
const slotsLeft = trip => trip.closed ? 0 : Math.max(trip.capacity - slotsUsed(trip), 0);
const allowanceUsed = trip => trip.chainTripId ? trip.centsUsed / 100
  : tripRequests(trip).filter(r => HOLDS_SLOT.includes(r.status)).reduce((s, r) => s + r.price, 0);
const cityOf = trip => { const c = CITIES[trip.code]; return c ? (LANG === 'tr' && c.tr) || c.city : trip.code; };
const regionOf = trip => CITIES[trip.code]?.region || 'Europe';
const isUpcoming = trip => daysFromToday(trip.date) >= 0;

function setStatus(req, status, k, v = {}){
  req.status = status;
  req.history.push({k, v, at:nowIso()});
  save();
}

// ---------- Toast ----------
let toastTimer;
function toast(msg){
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// ---------- Navigation ----------
function showView(name){
  if(name === 'detail' && !tripById(state.selectedTripId)){
    const first = state.trips.find(t => !t.mine && isUpcoming(t) && slotsLeft(t) > 0);
    state.selectedTripId = first?.id || null;
  }
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('view-' + name).classList.add('active');
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  renderAll();
  window.scrollTo({top:0, behavior:'smooth'});
}

// ---------- Home ----------
function renderHeroPass(){
  const trip = state.trips
    .filter(t => !t.mine && isUpcoming(t) && slotsLeft(t) > 0)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  const pass = $('hero-pass');
  if(!trip){ pass.style.visibility = 'hidden'; return; }
  pass.style.visibility = 'visible';
  $('pass-route').textContent = `${trip.code} → IST · ${fmtDay(trip.date)}`;
  $('pass-meta').textContent = t('pass.meta', {name:shortName(trip.traveler), n:slotsLeft(trip), free:fmtNum(LIMIT - allowanceUsed(trip))});
  pass.onclick = () => openTrip(trip.id);
}

function renderNotifDot(){
  const waiting = state.requests.some(r => r.status === 'pending' && tripById(r.tripId)?.mine);
  $('notif-dot').classList.toggle('show', waiting);
}

// ---------- Browse ----------
let searchTerm = '';

function visibleTrips(){
  const q = searchTerm.trim().toLocaleLowerCase(LOCALE());
  return state.trips
    .filter(isUpcoming)
    .filter(t => {
      if(state.filter === 'all') return true;
      if(state.filter === 'week') return daysFromToday(t.date) <= 7;
      return regionOf(t) === state.filter;
    })
    .filter(t => !q || [t.code, cityOf(t), CITIES[t.code]?.city || '', travelerName(t), ...t.categories, ...t.categories.map(catName)]
      .some(s => s.toLocaleLowerCase(LOCALE()).includes(q)))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function whenLabel(trip){
  const d = daysFromToday(trip.date);
  return d === 0 ? t('when.today') : d === 1 ? t('when.tomorrow') : t('when.inDays', {n:d});
}

function renderTrips(){
  const trips = visibleTrips();
  const open = trips.filter(t => slotsLeft(t) > 0).length;
  $('trip-count').textContent = t('browse.count', {n:open}) + (searchTerm.trim() ? t('browse.matching', {q:searchTerm.trim()}) : '');
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.filter === state.filter));
  $('trip-grid').innerHTML = trips.length ? trips.map((tr, i) => {
    const left = slotsLeft(tr);
    const free = LIMIT - allowanceUsed(tr);
    const rating = tr.mine ? t('card.yourTrip') : onChainRating(tr, true) || tripRating(tr);
    return `
      <button class="trip-card ${left ? '' : 'full'}" data-trip="${tr.id}">
        <div class="trip-top ${i % 2 ? 'mint' : 'sand'}">
          <span class="trip-route">${esc(tr.code)} <span class="arr">✈</span> IST${tr.mine ? `<span class="badge-mine">${t('card.yours')}</span>` : ''}</span>
          <span class="when ${daysFromToday(tr.date) <= 7 ? 'soon' : ''}">${whenLabel(tr)}</span>
        </div>
        <div class="trip-body">
          <div class="traveler">
            <span class="avatar">${esc(initials(travelerName(tr)))}</span>
            <span><b>${esc(travelerName(tr))}</b><small>${esc(cityOf(tr))} · ${fmtDay(tr.date)} · ${rating}</small></span>
          </div>
          <div class="trip-tags">${tr.categories.map(c => `<span class="tag">${esc(catName(c))}</span>`).join('')}</div>
          <div class="trip-foot">
            <span class="muted">${left ? t('card.left', {left, cap:tr.capacity, free:fmtNum(free)}) : t('card.full')}</span>
            <span class="go">${tr.mine ? t('card.view') : left ? t('card.request') : ''}</span>
          </div>
        </div>
      </button>`;
  }).join('') : `<div class="empty">${LIVE && !market.loaded ? t(market.error ? 'browse.loadFail' : 'browse.loading')
    : state.trips.some(isUpcoming) ? t('browse.empty') : `${t('browse.none')} <span class="link" onclick="showView('list-trip')">${t('dash.listOne')}</span>`}</div>`;
}

function openTrip(id){
  state.selectedTripId = id;
  resetRequestForm();
  showView('detail');
}

// ---------- Trip detail / request ----------
function renderDetail(){
  const trip = tripById(state.selectedTripId);
  const form = $('request-form');
  if(!trip){
    $('detail-route').textContent = t('detail.noTrips');
    $('detail-date').textContent = '';
    $('detail-tags').innerHTML = '';
    $('detail-desc').textContent = t('detail.noTripsDesc');
    form.classList.add('disabled');
    return;
  }
  const left = slotsLeft(trip);
  const name = travelerName(trip);
  $('detail-route').textContent = `${cityOf(trip)} → İstanbul`;
  $('detail-date').textContent = parseDay(trip.date).toLocaleDateString(LOCALE(), {weekday:'long', day:'numeric', month:'long'});
  $('detail-tags').innerHTML =
    `<span class="hl">${t('detail.left', {left, cap:trip.capacity})}</span>` +
    `<span>${trip.categories.map(c => esc(catName(c))).join(' · ')}</span>`;
  $('detail-desc').textContent =
    t('detail.desc', {cap:trip.capacity, cats:trip.categories.map(catName).join(', ').toLocaleLowerCase(LOCALE())}) + (trip.notes ? ` ${trip.notes}` : '');
  $('side-init').textContent = initials(name);
  $('side-name').textContent = name;
  $('side-trips').textContent = trip.completed ?? 0;
  $('side-rating').textContent = onChainRating(trip) || (trip.mine ? t('side.newTraveler') : tripRating(trip));
  const reviews = reviewsFor(trip);
  $('side-reviews').innerHTML = reviews.slice(-3).reverse().map(r =>
    `<div class="review-line"><span class="stars">${starsText(r.stars)}</span>${r.comment ? ` “${esc(r.comment)}”` : ''} <span class="muted">· ${esc(r.item)}</span></div>`).join('');
  $('limit-label').textContent = trip.mine ? t('limit.yours') : t('limit.theirs', {name:name.split(' ')[0]});

  let blocked = '';
  if(trip.mine && !canPayOnChain(trip)) blocked = trip.wallet ? t('blocked.ownWallet') : t('blocked.own');
  else if(trip.closed) blocked = t('blocked.closed');
  else if(!left) blocked = t('blocked.full');
  $('detail-blocked').textContent = blocked;
  $('detail-blocked').style.display = blocked ? 'block' : 'none';
  form.classList.toggle('disabled', !!blocked);
  updateLimit();
}

function checkRequest(){
  const trip = tripById(state.selectedTripId);
  const price = parseFloat($('price-input').value) || 0;
  const cat = $('cat-select').value;
  const used = trip ? allowanceUsed(trip) : 0;
  const total = used + price;
  const base = {total, used, price};
  if(!trip) return {...base, ok:false, msg:''};
  if(trip.mine && !canPayOnChain(trip)) return {...base, ok:false, msg:'', neutral:true};
  if(cat === 'Phone') return {...base, ok:false, msg:t('check.phone')};
  if(!trip.categories.includes(cat)) return {...base, ok:false, msg:t('check.category', {name:travelerName(trip), cat:catName(cat).toLocaleLowerCase(LOCALE())})};
  if(total > LIMIT) return {...base, ok:false, msg:t('check.over', {left:fmtNum(LIMIT - used)})};
  if(price <= 0) return {...base, ok:false, msg:t('check.enterPrice', {left:fmtNum(LIMIT - used)}), neutral:true};
  return {...base, ok:true, msg:t('check.ok', {left:fmtNum(LIMIT - total)})};
}

function updateLimit(){
  const res = checkRequest();
  $('limit-total').textContent = `${eur(res.total)} / ${eur(LIMIT)}`;
  $('limit-used').style.width = Math.min(res.used / LIMIT * 100, 100) + '%';
  $('limit-used-label').textContent = t('limit.already', {n:fmtNum(res.used)});
  const bar = $('limit-bar');
  bar.style.width = Math.min(res.price, Math.max(LIMIT - res.used, 0)) / LIMIT * 100 + '%';
  const bad = !res.ok && !res.neutral;
  bar.classList.toggle('over', bad);
  $('limit-msg').textContent = res.msg;
  $('limit-msg').classList.toggle('warn', bad);
  const trip = tripById(state.selectedTripId);
  if(trip) renderPayMode(trip);
}

function resetRequestForm(){
  ['req-item','req-link','price-input'].forEach(id => $(id).value = '');
  $('cat-select').value = 'General';
  $('req-error').textContent = '';
}

async function sendRequest(){
  const trip = tripById(state.selectedTripId);
  const item = $('req-item').value.trim();
  const link = $('req-link').value.trim();
  const price = parseFloat($('price-input').value) || 0;
  const err = $('req-error');
  const onChain = canPayOnChain(trip);
  if(!trip || (trip.mine && !onChain) || !slotsLeft(trip)) return;
  if(LIVE && !onChain){ err.textContent = t('req.errWallet'); connectWallet(); return; }
  if(!item){ err.textContent = t('req.errItem'); return; }
  if(link && !/^https?:\/\/\S+$/i.test(link)){ err.textContent = t('req.errLink'); return; }
  const res = checkRequest();
  if(!res.ok){ err.textContent = res.msg; return; }
  err.textContent = '';
  const req = {id:uid('r'), tripId:trip.id, item, link, price, category:$('cat-select').value, buyer:'you', status:'pending', history:[{k:'hist.sent', v:{}, at:nowIso()}]};
  if(onChain){
    const chain = await payOnChain(req, trip);
    if(!chain) return;
    req.chain = chain;
    req.id = 'd' + chain.dealId; // matches the id the chain sync uses
    req.history[0] = {k:'hist.sentChain', v:{amt:fmtDeal(req, chain.amount), dep:BigInt(chain.deposit) > 0n ? fmtDeal(req, chain.deposit) : ''}, at:req.history[0].at};
  }
  state.requests.push(req);
  save();
  resetRequestForm();
  const name = trip.mine ? t('pay.theTraveler') : travelerName(trip);
  toast(onChain ? t('toast.paidEscrow', {name}) : t('toast.sent', {name}));
  if(onChain) syncDeals().then(renderAll); // picks up the deal and the trip's new slot/allowance counts
  else scheduleAutoAccept(req.id);
  showView('dashboard');
}

// Demo: other travelers accept pending requests after a few seconds
function scheduleAutoAccept(id){
  setTimeout(() => {
    const req = reqById(id);
    if(!req || req.status !== 'pending' || req.chain) return;
    const trip = tripById(req.tripId);
    setStatus(req, 'escrow', 'hist.accepted', {price:req.price});
    toast(t('toast.autoAccepted', {name:travelerName(trip), item:req.item, price:fmtNum(req.price)}));
    renderAll();
  }, 5000);
}

// ---------- List a trip ----------
async function submitTrip(){
  const code = $('lt-city').value;
  const date = $('lt-date').value;
  const capacity = parseInt($('lt-capacity').value, 10);
  const categories = [...document.querySelectorAll('.cat-chip.on')].map(c => c.dataset.cat);
  const err = $('lt-error');
  if(!code){ err.textContent = t('lt.errCity'); return; }
  if(!date || daysFromToday(date) < 0){ err.textContent = t('lt.errDate'); return; }
  if(!(capacity >= 1 && capacity <= 5)){ err.textContent = t('lt.errCap'); return; }
  if(!categories.length){ err.textContent = t('lt.errCats'); return; }
  if(LIVE && !chainReady()){ err.textContent = t('lt.errWallet'); connectWallet(); return; }
  err.textContent = '';
  const notes = $('lt-notes').value.trim();
  if(LIVE){
    if(!await listTripOnChain(code, date, capacity, categories, notes)) return;
  } else {
    state.trips.push({id:uid('t'), code, date, traveler:'You', capacity, categories, notes, mine:true, rating:0, completed:0,
      wallet:chainReady() ? wallet.account : null});
    save();
  }
  $('trip-confirm').classList.add('show');
  ['lt-city','lt-date','lt-capacity','lt-notes'].forEach(id => $(id).value = '');
  document.querySelectorAll('.cat-chip').forEach(c => c.classList.remove('on'));
  setTimeout(() => { $('trip-confirm').classList.remove('show'); showView('dashboard'); }, 1200);
}

// ---------- Dashboard ----------
function progress(step){
  return `<div class="progress-track">${[1,2,3,4].map(i => `<div class="${i <= step ? 'on' : ''}"></div>`).join('')}</div>`;
}
function statusBadge(req, incoming){
  const label = incoming && req.status === 'pending' ? t('status.needsReply') : t('status.' + req.status);
  return `<span class="status ${STATUS[req.status].cls}">${label}</span>`;
}

function renderDashboard(){
  const sent = state.requests.filter(r => r.buyer === 'you' && r.status !== 'cancelled').reverse();
  const myTrips = state.trips.filter(t => t.mine).sort((a, b) => b.date.localeCompare(a.date));
  const incoming = state.requests.filter(r => tripById(r.tripId)?.mine);
  const incomingActive = incoming.filter(r => ACTIVE.includes(r.status)).length;
  const needsReply = incoming.filter(r => r.status === 'pending').length;
  const active = sent.filter(r => ACTIVE.includes(r.status)).length + incomingActive;
  $('dash-count').textContent = t('dash.count', {active, reply:needsReply});
  const sum = (list, status) => list.filter(r => r.status === status).reduce((s, r) => s + r.price, 0);
  $('dash-escrow').textContent = eur(sum(sent, 'escrow') + sum(sent, 'disputed'));
  $('dash-waiting').textContent = eur(sum(sent, 'pending'));
  $('dash-earned').textContent = eur(sum(incoming, 'completed'));

  const b = (act, id, label, cls) => `<button class="btn btn-sm ${cls}" data-act="${act}" data-id="${id}">${label}</button>`;
  $('dash-sent').innerHTML = sent.length ? sent.map(r => {
    const trip = tripById(r.tripId);
    let actions = '';
    if(r.chain) actions = chainButtons(r, 'buyer');
    else if(r.status === 'pending') actions = b('cancel', r.id, t('btn.cancelRequest'), 'btn-ghost');
    else if(r.status === 'escrow') actions = b('confirm', r.id, t('btn.confirm'), 'btn-primary') + b('dispute', r.id, t('btn.dispute'), 'btn-ghost');
    else if(r.status === 'disputed') actions = b('dispute', r.id, t('btn.viewDispute'), 'btn-ghost');
    return `
      <div class="dash-item">
        <div class="dash-item-top"><b>${esc(r.item)}</b>${statusBadge(r)}</div>
        <p class="dash-sub">${esc(travelerName(trip))} · ${esc(trip.code)} → IST · ${fmtDay(trip.date)} · ${eur(r.price)}</p>
        ${r.chain ? chainItemMeta(r) : ''}
        ${progress(STATUS[r.status].step)}
        ${r.chain && chainHint(r, 'buyer') ? `<div class="form-hint">${chainHint(r, 'buyer')}</div>` : ''}
        ${actions ? `<div class="dash-actions">${actions}</div>` : ''}
      </div>`;
  }).join('') : `<div class="empty">${t('dash.noRequests')} <span class="link" onclick="showView('browse')">${t('dash.explore')}</span></div>`;

  $('dash-carrying').innerHTML = myTrips.length ? myTrips.map(tr => {
    const reqs = tripRequests(tr).filter(r => r.status !== 'cancelled');
    const payout = reqs.filter(r => r.status === 'completed').reduce((s, r) => s + r.price, 0);
    const payTo = tr.wallet ? `<div class="side-row"><span>${t('dash.payoutsTo')}</span><b>${esc(shortAddr(tr.wallet))}</b></div>` : '';
    const past = !isUpcoming(tr);
    const hasPending = reqs.some(r => r.status === 'pending');
    return `
      <div class="dash-item ${hasPending ? 'mine-active' : ''}">
        <div class="dash-item-top"><b>${esc(tr.code)} ✈ IST <span class="muted">· ${fmtDay(tr.date)}</span></b>
          <span class="status ${past ? 'done' : 'muted'}">${past ? t('trip.completed') : t('trip.free', {left:slotsLeft(tr), cap:tr.capacity})}</span></div>
        <div class="side-row"><span>${t('dash.allowanceUsed')}</span><b>${eur(allowanceUsed(tr))} / ${eur(LIMIT)}</b></div>
        ${payTo}
        ${payout ? `<div class="side-row"><span>${t('dash.payout')}</span><b style="color:var(--green)">${t('dash.released', {n:fmtNum(payout)})}</b></div>` : ''}
        ${reqs.length ? reqs.map(r => `
          <div class="incoming ${r.status === 'pending' ? '' : 'quiet'}">
            <div class="dash-item-top"><span>${esc(r.item)} <span class="muted">${eur(r.price)} · ${esc(buyerName(r))}</span></span>${statusBadge(r, true)}</div>
            ${r.chain ? `${chainItemMeta(r)}
              ${chainHint(r, 'traveler') ? `<div class="form-hint">${chainHint(r, 'traveler')}</div>` : ''}
              ${chainButtons(r, 'traveler') ? `<div class="dash-actions">${chainButtons(r, 'traveler')}</div>` : ''}` : `
            ${r.status === 'pending' ? `<div class="dash-actions">${b('accept', r.id, t('btn.accept'), 'btn-primary')}${b('decline', r.id, t('btn.decline'), 'btn-ghost')}</div>` : ''}
            ${r.status === 'escrow' ? `<div class="form-hint">${t('dash.heldHint', {name:esc(buyerName(r))})}</div>` : ''}`}
          </div>`).join('') : `<div class="form-hint">${t('dash.noRequests')}</div>`}
      </div>`;
  }).join('') : `<div class="empty">${t('dash.noTrip')} <span class="link" onclick="showView('list-trip')">${t('dash.listOne')}</span></div>`;
}

function handleDashAction(act, id){
  const req = reqById(id);
  if(!req) return;
  if(act === 'dispute'){ state.disputeId = id; showView('dispute'); return; }
  if(act === 'rate'){ openRateDialog(req); return; }
  if(act === 'show-code'){ openCodeDialog(req); return; }
  if(act === 'enter-code'){ openEntryDialog(req); return; }
  if(act === 'receipt'){ openReceiptDialog(req); return; }
  if(act === 'view-receipt'){ openReceiptViewer(req); return; }
  if(req.chain){
    chainAction(req, act).then(ok => ok && toast(STRINGS.en['done.' + act] ? t('done.' + act) : t('done.default')));
    return;
  }
  const price = fmtNum(req.price);
  if(act === 'cancel'){ setStatus(req, 'cancelled', 'hist.cancelled'); toast(t('toast.cancelled')); }
  if(act === 'confirm'){ setStatus(req, 'completed', 'hist.confirmed', {price}); toast(t('toast.confirmed', {price})); }
  if(act === 'accept'){ setStatus(req, 'escrow', 'hist.accepted', {price}); toast(t('toast.accepted', {price})); }
  if(act === 'decline'){ setStatus(req, 'declined', 'hist.declined'); toast(t('toast.declined')); }
  renderAll();
}

// ---------- Dispute ----------
function renderDispute(){
  const req = reqById(state.disputeId);
  if(!req) return;
  $('dispute-title').textContent = t('dispute.titleFor', {item:req.item});
  $('dispute-status').className = `status ${STATUS[req.status].cls}`;
  $('dispute-status').textContent = req.status === 'disputed' ? (req.chain ? t('dispute.frozen') : t('dispute.review')) : t('status.' + req.status);

  const items = req.history.map(h => ({label:histLabel(h), sub:fmtStamp(h.at), cls:'done'}));
  if(req.status === 'escrow'){
    items.push({label:t('tl.dispute'), sub:req.chain
      ? t('tl.disputeChain') + (req.deal?.status === 'Accepted' ? t('tl.disputeNoArrive', {date:fmtSecDay(req.deal.deliverBy)}) : '')
      : t('tl.disputeDemo'), cls:'active'});
    items.push({label:t('tl.resolution'), sub:t('tl.resolutionEscrow'), cls:''});
  } else if(req.status === 'disputed'){
    items[items.length - 1].cls = 'active';
    items.push({label:t('tl.resolution'), sub:req.chain ? t('tl.resolutionChain') : t('tl.resolutionDemo'), cls:''});
  }
  $('dispute-timeline').innerHTML = items.map(i =>
    `<div class="tl-item"><div class="tl-dot ${i.cls}"></div><div class="tl-body"><b>${esc(i.label)}</b><span>${esc(i.sub)}</span></div></div>`).join('');

  $('dispute-form').style.display = req.status === 'escrow' ? 'block' : 'none';
  $('dispute-resolve').style.display = req.status === 'disputed' && !req.chain ? 'block' : 'none';
  renderChainDispute(req);
}

async function submitDispute(){
  const req = reqById(state.disputeId);
  const desc = $('dispute-desc').value.trim();
  if(!req) return;
  if(desc.length < 10){ $('dispute-error').textContent = t('dispute.errDesc'); return; }
  $('dispute-error').textContent = '';
  req.dispute = {reason:$('dispute-reason').value, desc};
  if(req.chain){
    if(!await chainAction(req, 'dispute')) return;
    $('dispute-desc').value = '';
    toast(t('toast.disputeChain'));
    return;
  }
  setStatus(req, 'disputed', 'hist.disputeRaised', {reason:req.dispute.reason});
  $('dispute-desc').value = '';
  toast(t('toast.disputeDemo'));
  renderAll();
}

function resolveDispute(outcome){
  const req = reqById(state.disputeId);
  if(!req) return;
  const price = fmtNum(req.price);
  if(outcome === 'release') setStatus(req, 'completed', 'hist.resolvedRelease', {price});
  else setStatus(req, 'refunded', 'hist.resolvedRefund', {price});
  toast(t('toast.resolved'));
  renderAll();
}

// ---------- Boot ----------
function renderAll(){
  renderWallet();
  renderHeroPass();
  renderNotifDot();
  renderTrips();
  renderDetail();
  renderDashboard();
  renderDispute();
}

function scheduleSeedAccepts(){
  if(LIVE) return;
  state.requests.filter(r => r.status === 'pending' && !tripById(r.tripId).mine).forEach(r => scheduleAutoAccept(r.id));
}

function resetDemo(){
  state = seed();
  save();
  showView('home');
  scheduleSeedAccepts();
  toast(t('toast.reset'));
}

// Form controls built from data: rebuilt when the language changes, keeping what was picked
function renderFormOptions(){
  const city = $('lt-city').value;
  $('lt-city').innerHTML = `<option value="">${t('lt.chooseCity')}</option>` +
    Object.entries(CITIES).map(([code, c]) => `<option value="${code}">${(LANG === 'tr' && c.tr) || c.city} (${code})</option>`).join('');
  $('lt-city').value = city;
  const picked = new Set([...document.querySelectorAll('.cat-chip.on')].map(c => c.dataset.cat));
  $('lt-categories').innerHTML = CATEGORIES.map(c =>
    `<button type="button" class="cat-chip${picked.has(c) ? ' on' : ''}" data-cat="${c}">${esc(catName(c))}</button>`).join('');
}

function onLangChange(){
  renderFormOptions();
  renderAll();
}

applyStatic();
renderFormOptions();
// Live data can't be reset — it's on the chain
if(LIVE) document.querySelector('[onclick="resetDemo()"]').hidden = true;
$('lt-date').min = localDate();

document.querySelectorAll('[data-view]').forEach(t => t.addEventListener('click', () => showView(t.dataset.view)));
$('search').addEventListener('input', e => {
  searchTerm = e.target.value;
  if(!$('view-browse').classList.contains('active')) showView('browse');
  else renderTrips();
});
document.querySelectorAll('[data-cat-tile]').forEach(tile => tile.addEventListener('click', () => {
  searchTerm = $('search').value = catName(tile.dataset.catTile);
  state.filter = 'all';
  showView('browse');
}));
document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { state.filter = c.dataset.filter; save(); renderTrips(); }));
$('lt-categories').addEventListener('click', e => { const chip = e.target.closest('.cat-chip'); if(chip) chip.classList.toggle('on'); });
$('trip-grid').addEventListener('click', e => { const card = e.target.closest('[data-trip]'); if(card) openTrip(card.dataset.trip); });
$('view-dashboard').addEventListener('click', e => { const b = e.target.closest('[data-act]'); if(b) handleDashAction(b.dataset.act, b.dataset.id); });

renderAll();
scheduleSeedAccepts();
initChain();
