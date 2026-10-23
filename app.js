// ---------- Constants ----------
const STORE_KEY = 'roamly-state-v1';
const OLD_STORE_KEY = 'tasi-state-v1'; // pre-rename key, read once so saved data carries over
const LIMIT = 430; // personal duty-free allowance per traveler, EUR
const CATEGORIES = ['Electronics','Clothing','Cosmetics','General','Alcohol'];
const CITIES = {
  PRG:{city:'Prague', region:'Europe'},
  BER:{city:'Berlin', region:'Europe'},
  LON:{city:'London', region:'Europe'},
  VIE:{city:'Vienna', region:'Europe'},
  AMS:{city:'Amsterdam', region:'Europe'},
  PAR:{city:'Paris', region:'Europe'},
  DXB:{city:'Dubai', region:'Gulf'},
  DOH:{city:'Doha', region:'Gulf'},
  NYC:{city:'New York', region:'North America'},
  YYZ:{city:'Toronto', region:'North America'},
};
const ACTIVE = ['pending','escrow','disputed'];      // still in progress
const HOLDS_SLOT = ['pending','escrow','disputed','completed']; // uses capacity + allowance
const STATUS = {
  pending:  {label:'Awaiting traveler', cls:'pending', step:1},
  escrow:   {label:'In escrow',         cls:'escrow',  step:2},
  disputed: {label:'Disputed',          cls:'disputed',step:2},
  completed:{label:'Delivered',         cls:'done',    step:4},
  refunded: {label:'Refunded',          cls:'muted',   step:0},
  declined: {label:'Declined',          cls:'muted',   step:0},
  cancelled:{label:'Cancelled',         cls:'muted',   step:0},
};

// ---------- Helpers ----------
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = p => p + Math.random().toString(36).slice(2, 9);
const nowIso = () => new Date().toISOString();

function localDate(offsetDays = 0){
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
const parseDay = iso => new Date(iso + 'T00:00:00');
const fmtDay = iso => parseDay(iso).toLocaleDateString('en-GB', {day:'2-digit', month:'short'});
const fmtStamp = iso => new Date(iso).toLocaleDateString('en-GB', {day:'2-digit', month:'short'});
const daysFromToday = iso => Math.round((parseDay(iso) - parseDay(localDate())) / 86400000);
const initials = name => name.trim().charAt(0).toUpperCase();
const shortName = name => { const p = name.split(' '); return p.length > 1 ? `${p[0][0]}. ${p.slice(1).join(' ')}` : name; };

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
    ({id, tripId, item, link:'', price, category, buyer, status, history:history.map(([label, d]) => ({label, at:new Date(Date.now() + d*86400000).toISOString()}))});
  const requests = [
    r('r1','t1','Sony WH-1000XM6',249,'Electronics','you','escrow',[['Request sent',-3],['Accepted — €249 locked in escrow',-2]]),
    r('r2','t2','Skincare set',85,'Cosmetics','you','pending',[['Request sent',-1]]),
    r('r3','t8','Leather jacket',180,'Clothing','Can B.','completed',[['Request sent',-16],['Accepted — €180 locked in escrow',-15],['Buyer confirmed delivery — €180 released',-9]]),
    r('r4','t7','Nintendo Switch 2',329,'Electronics','Deniz A.','pending',[['Request sent',0]]),
  ];
  return {trips, requests, filter:'all', selectedTripId:null, disputeId:null};
}

let state;
try { state = JSON.parse(localStorage.getItem(STORE_KEY) || localStorage.getItem(OLD_STORE_KEY)) || seed(); } catch { state = seed(); }
function save(){ try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {} }

const tripById = id => state.trips.find(t => t.id === id);
const reqById = id => state.requests.find(r => r.id === id);
const tripRequests = trip => state.requests.filter(r => r.tripId === trip.id);
const slotsUsed = trip => tripRequests(trip).filter(r => HOLDS_SLOT.includes(r.status)).length;
const slotsLeft = trip => Math.max(trip.capacity - slotsUsed(trip), 0);
const allowanceUsed = trip => tripRequests(trip).filter(r => HOLDS_SLOT.includes(r.status)).reduce((s, r) => s + r.price, 0);
const cityOf = trip => CITIES[trip.code]?.city || trip.code;
const regionOf = trip => CITIES[trip.code]?.region || 'Europe';
const isUpcoming = trip => daysFromToday(trip.date) >= 0;

function setStatus(req, status, label){
  req.status = status;
  req.history.push({label, at:nowIso()});
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
  const left = slotsLeft(trip);
  $('pass-route').textContent = `${trip.code} → IST · ${fmtDay(trip.date)}`;
  $('pass-meta').textContent = `${shortName(trip.traveler)} · ${left} item${left === 1 ? '' : 's'} left · €${LIMIT - allowanceUsed(trip)} allowance`;
  pass.onclick = () => openTrip(trip.id);
}

function renderNotifDot(){
  const waiting = state.requests.some(r => r.status === 'pending' && tripById(r.tripId)?.mine);
  $('notif-dot').classList.toggle('show', waiting);
}

// ---------- Browse ----------
let searchTerm = '';

function visibleTrips(){
  const q = searchTerm.trim().toLowerCase();
  return state.trips
    .filter(isUpcoming)
    .filter(t => {
      if(state.filter === 'all') return true;
      if(state.filter === 'week') return daysFromToday(t.date) <= 7;
      return regionOf(t) === state.filter;
    })
    .filter(t => !q || [t.code, cityOf(t), t.traveler, ...t.categories].some(s => s.toLowerCase().includes(q)))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function whenLabel(trip){
  const d = daysFromToday(trip.date);
  return d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : `In ${d} days`;
}

function renderTrips(){
  const trips = visibleTrips();
  const open = trips.filter(t => slotsLeft(t) > 0).length;
  $('trip-count').textContent = `${open} trip${open === 1 ? '' : 's'} with space` + (searchTerm.trim() ? ` matching “${searchTerm.trim()}”` : '');
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.filter === state.filter));
  $('trip-grid').innerHTML = trips.length ? trips.map((t, i) => {
    const left = slotsLeft(t);
    const free = LIMIT - allowanceUsed(t);
    const rating = t.mine ? 'Your trip' : `★ ${t.rating.toFixed(1)}`;
    return `
      <button class="trip-card ${left ? '' : 'full'}" data-trip="${t.id}">
        <div class="trip-top ${i % 2 ? 'mint' : 'sand'}">
          <span class="trip-route">${esc(t.code)} <span class="arr">✈</span> IST${t.mine ? '<span class="badge-mine">YOURS</span>' : ''}</span>
          <span class="when ${daysFromToday(t.date) <= 7 ? 'soon' : ''}">${whenLabel(t)}</span>
        </div>
        <div class="trip-body">
          <div class="traveler">
            <span class="avatar">${esc(initials(t.traveler))}</span>
            <span><b>${esc(t.traveler)}</b><small>${esc(cityOf(t))} · ${fmtDay(t.date)} · ${rating}</small></span>
          </div>
          <div class="trip-tags">${t.categories.map(c => `<span class="tag">${esc(c)}</span>`).join('')}</div>
          <div class="trip-foot">
            <span class="muted">${left ? `${left} of ${t.capacity} item${t.capacity === 1 ? '' : 's'} left · €${free} free` : 'Full'}</span>
            <span class="go">${t.mine ? 'View →' : left ? 'Request →' : ''}</span>
          </div>
        </div>
      </button>`;
  }).join('') : '<div class="empty">No upcoming trips match. Try another filter or search.</div>';
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
    $('detail-route').textContent = 'No open trips';
    $('detail-date').textContent = '';
    $('detail-tags').innerHTML = '';
    $('detail-desc').textContent = 'There are no trips with free capacity right now.';
    form.classList.add('disabled');
    return;
  }
  const left = slotsLeft(trip);
  $('detail-route').textContent = `${cityOf(trip)} → İstanbul`;
  $('detail-date').textContent = parseDay(trip.date).toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long'});
  $('detail-tags').innerHTML =
    `<span class="hl">${left} of ${trip.capacity} item${trip.capacity === 1 ? '' : 's'} left</span>` +
    `<span>${trip.categories.map(esc).join(' · ')}</span>`;
  $('detail-desc').textContent =
    `Carrying up to ${trip.capacity} personal item${trip.capacity === 1 ? '' : 's'}. ` +
    `Willing to bring ${trip.categories.join(', ').toLowerCase()}.` + (trip.notes ? ` ${trip.notes}` : '');
  $('side-init').textContent = initials(trip.traveler);
  $('side-name').textContent = trip.traveler;
  $('side-trips').textContent = trip.completed ?? 0;
  $('side-rating').textContent = trip.mine ? 'New traveler' : `★ ${trip.rating.toFixed(1)}`;
  $('limit-label').textContent = trip.mine ? 'Your duty-free allowance' : `${trip.traveler.split(' ')[0]}'s duty-free allowance`;

  let blocked = '';
  if(trip.mine) blocked = 'This is your own trip — buyers will send requests to you.';
  else if(!left) blocked = 'This trip is full.';
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
  if(cat === 'Phone') return {...base, ok:false, msg:'Phones are limited to one per traveler per 3 years and need IMEI registration — not available yet.'};
  if(!trip.categories.includes(cat)) return {...base, ok:false, msg:`${trip.traveler} isn't carrying ${cat.toLowerCase()} on this trip.`};
  if(total > LIMIT) return {...base, ok:false, msg:`Over the allowance — this traveler has €${LIMIT - used} left on this trip.`};
  if(price <= 0) return {...base, ok:false, msg:`Enter a price. €${LIMIT - used} of this traveler's allowance is still free.`, neutral:true};
  return {...base, ok:true, msg:`Within the allowance — €${LIMIT - total} would remain for other buyers.`};
}

function updateLimit(){
  const res = checkRequest();
  $('limit-total').textContent = `€${res.total} / €${LIMIT}`;
  $('limit-used').style.width = Math.min(res.used / LIMIT * 100, 100) + '%';
  $('limit-used-label').textContent = `Already requested · €${res.used}`;
  const bar = $('limit-bar');
  bar.style.width = Math.min(res.price, Math.max(LIMIT - res.used, 0)) / LIMIT * 100 + '%';
  const bad = !res.ok && !res.neutral;
  bar.classList.toggle('over', bad);
  $('limit-msg').textContent = res.msg;
  $('limit-msg').classList.toggle('warn', bad);
}

function resetRequestForm(){
  ['req-item','req-link','price-input'].forEach(id => $(id).value = '');
  $('cat-select').value = 'General';
  $('req-error').textContent = '';
}

function sendRequest(){
  const trip = tripById(state.selectedTripId);
  const item = $('req-item').value.trim();
  const link = $('req-link').value.trim();
  const price = parseFloat($('price-input').value) || 0;
  const err = $('req-error');
  if(!trip || trip.mine || !slotsLeft(trip)) return;
  if(!item){ err.textContent = 'Tell the traveler what you need.'; return; }
  if(link && !/^https?:\/\/\S+$/i.test(link)){ err.textContent = 'The link should start with http:// or https://'; return; }
  const res = checkRequest();
  if(!res.ok){ err.textContent = res.msg; return; }
  err.textContent = '';
  const req = {id:uid('r'), tripId:trip.id, item, link, price, category:$('cat-select').value, buyer:'you', status:'pending', history:[{label:'Request sent', at:nowIso()}]};
  state.requests.push(req);
  save();
  resetRequestForm();
  toast(`Request sent to ${trip.traveler}`);
  scheduleAutoAccept(req.id);
  showView('dashboard');
}

// Demo: other travelers accept pending requests after a few seconds
function scheduleAutoAccept(id){
  setTimeout(() => {
    const req = reqById(id);
    if(!req || req.status !== 'pending') return;
    const trip = tripById(req.tripId);
    setStatus(req, 'escrow', `Accepted — €${req.price} locked in escrow`);
    toast(`${trip.traveler} accepted “${req.item}” — €${req.price} is in escrow`);
    renderAll();
  }, 5000);
}

// ---------- List a trip ----------
function submitTrip(){
  const code = $('lt-city').value;
  const date = $('lt-date').value;
  const capacity = parseInt($('lt-capacity').value, 10);
  const categories = [...document.querySelectorAll('.cat-chip.on')].map(c => c.dataset.cat);
  const err = $('lt-error');
  if(!code){ err.textContent = 'Pick a departure city.'; return; }
  if(!date || daysFromToday(date) < 0){ err.textContent = 'Pick a travel date from today onwards.'; return; }
  if(!(capacity >= 1 && capacity <= 5)){ err.textContent = 'You can carry between 1 and 5 items.'; return; }
  if(!categories.length){ err.textContent = 'Choose at least one category.'; return; }
  err.textContent = '';
  state.trips.push({id:uid('t'), code, date, traveler:'You', capacity, categories, notes:$('lt-notes').value.trim(), mine:true, rating:0, completed:0});
  save();
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
  const s = STATUS[req.status];
  const label = incoming && req.status === 'pending' ? 'Needs your reply' : s.label;
  return `<span class="status ${s.cls}">${label}</span>`;
}

function renderDashboard(){
  const sent = state.requests.filter(r => r.buyer === 'you' && r.status !== 'cancelled').reverse();
  const myTrips = state.trips.filter(t => t.mine).sort((a, b) => b.date.localeCompare(a.date));
  const incoming = state.requests.filter(r => tripById(r.tripId)?.mine);
  const incomingActive = incoming.filter(r => ACTIVE.includes(r.status)).length;
  const needsReply = incoming.filter(r => r.status === 'pending').length;
  const active = sent.filter(r => ACTIVE.includes(r.status)).length + incomingActive;
  $('dash-count').textContent = `${active} active` + (needsReply ? ` · ${needsReply} need${needsReply === 1 ? 's' : ''} your reply` : '');
  const sum = (list, status) => list.filter(r => r.status === status).reduce((s, r) => s + r.price, 0);
  $('dash-escrow').textContent = `€${sum(sent, 'escrow') + sum(sent, 'disputed')}`;
  $('dash-waiting').textContent = `€${sum(sent, 'pending')}`;
  $('dash-earned').textContent = `€${sum(incoming, 'completed')}`;

  $('dash-sent').innerHTML = sent.length ? sent.map(r => {
    const trip = tripById(r.tripId);
    let actions = '';
    if(r.status === 'pending') actions = `<button class="btn btn-sm btn-ghost" data-act="cancel" data-id="${r.id}">Cancel request</button>`;
    if(r.status === 'escrow') actions = `<button class="btn btn-sm btn-primary" data-act="confirm" data-id="${r.id}">Confirm received</button>
      <button class="btn btn-sm btn-ghost" data-act="dispute" data-id="${r.id}">Raise a dispute</button>`;
    if(r.status === 'disputed') actions = `<button class="btn btn-sm btn-ghost" data-act="dispute" data-id="${r.id}">View dispute</button>`;
    return `
      <div class="dash-item">
        <div class="dash-item-top"><b>${esc(r.item)}</b>${statusBadge(r)}</div>
        <p class="dash-sub">${esc(trip.traveler)} · ${esc(trip.code)} → IST · ${fmtDay(trip.date)} · €${r.price}</p>
        ${progress(STATUS[r.status].step)}
        ${actions ? `<div class="dash-actions">${actions}</div>` : ''}
      </div>`;
  }).join('') : `<div class="empty">No requests yet. <span class="link" onclick="showView('browse')">Explore trips →</span></div>`;

  $('dash-carrying').innerHTML = myTrips.length ? myTrips.map(t => {
    const reqs = tripRequests(t).filter(r => r.status !== 'cancelled');
    const payout = reqs.filter(r => r.status === 'completed').reduce((s, r) => s + r.price, 0);
    const past = !isUpcoming(t);
    const hasPending = reqs.some(r => r.status === 'pending');
    return `
      <div class="dash-item ${hasPending ? 'mine-active' : ''}">
        <div class="dash-item-top"><b>${esc(t.code)} ✈ IST <span class="muted">· ${fmtDay(t.date)}</span></b>
          <span class="status ${past ? 'done' : 'muted'}">${past ? 'Completed' : `${slotsLeft(t)} of ${t.capacity} free`}</span></div>
        <div class="side-row"><span>Allowance used</span><b>€${allowanceUsed(t)} / €${LIMIT}</b></div>
        ${payout ? `<div class="side-row"><span>Payout</span><b style="color:var(--green)">€${payout} released</b></div>` : ''}
        ${reqs.length ? reqs.map(r => `
          <div class="incoming ${r.status === 'pending' ? '' : 'quiet'}">
            <div class="dash-item-top"><span>${esc(r.item)} <span class="muted">€${r.price} · ${esc(r.buyer)}</span></span>${statusBadge(r, true)}</div>
            ${r.status === 'pending' ? `<div class="dash-actions">
              <button class="btn btn-sm btn-primary" data-act="accept" data-id="${r.id}">Accept</button>
              <button class="btn btn-sm btn-ghost" data-act="decline" data-id="${r.id}">Decline</button></div>` : ''}
            ${r.status === 'escrow' ? `<div class="form-hint">Funds are held — released when ${esc(r.buyer)} confirms delivery.</div>` : ''}
          </div>`).join('') : '<div class="form-hint">No requests yet.</div>'}
      </div>`;
  }).join('') : `<div class="empty">You haven't listed a trip. <span class="link" onclick="showView('list-trip')">List one →</span></div>`;
}

function handleDashAction(act, id){
  const req = reqById(id);
  if(!req) return;
  if(act === 'cancel'){ setStatus(req, 'cancelled', 'Request cancelled by buyer'); toast('Request cancelled'); }
  if(act === 'confirm'){ setStatus(req, 'completed', `Buyer confirmed delivery — €${req.price} released`); toast(`Delivery confirmed — €${req.price} released to the traveler`); }
  if(act === 'accept'){ setStatus(req, 'escrow', `Accepted — €${req.price} locked in escrow`); toast(`Accepted — €${req.price} is now in escrow`); }
  if(act === 'decline'){ setStatus(req, 'declined', 'Declined by traveler'); toast('Request declined'); }
  if(act === 'dispute'){ state.disputeId = id; showView('dispute'); return; }
  renderAll();
}

// ---------- Dispute ----------
function renderDispute(){
  const req = reqById(state.disputeId);
  if(!req) return;
  const s = STATUS[req.status];
  $('dispute-title').textContent = `Dispute — ${req.item}`;
  $('dispute-status').className = `status ${s.cls}`;
  $('dispute-status').textContent = req.status === 'disputed' ? 'Under review' : s.label;

  const items = req.history.map(h => ({label:h.label, sub:fmtStamp(h.at), cls:'done'}));
  if(req.status === 'escrow'){
    items.push({label:'Dispute', sub:'Add your details below — funds stay locked until resolved', cls:'active'});
    items.push({label:'Resolution', sub:'Funds released to traveler, or refunded to buyer', cls:''});
  } else if(req.status === 'disputed'){
    items[items.length - 1].cls = 'active';
    items.push({label:'Resolution', sub:'Typically within 2 business days', cls:''});
  }
  $('dispute-timeline').innerHTML = items.map(i =>
    `<div class="tl-item"><div class="tl-dot ${i.cls}"></div><div class="tl-body"><b>${esc(i.label)}</b><span>${esc(i.sub)}</span></div></div>`).join('');

  $('dispute-form').style.display = req.status === 'escrow' ? 'block' : 'none';
  $('dispute-resolve').style.display = req.status === 'disputed' ? 'block' : 'none';
}

function submitDispute(){
  const req = reqById(state.disputeId);
  const desc = $('dispute-desc').value.trim();
  if(!req) return;
  if(desc.length < 10){ $('dispute-error').textContent = 'Describe the issue in a sentence or two.'; return; }
  $('dispute-error').textContent = '';
  req.dispute = {reason:$('dispute-reason').value, desc};
  setStatus(req, 'disputed', `Dispute raised — ${req.dispute.reason.toLowerCase()}`);
  $('dispute-desc').value = '';
  toast('Dispute submitted — funds stay locked while it is reviewed');
  renderAll();
}

function resolveDispute(outcome){
  const req = reqById(state.disputeId);
  if(!req) return;
  if(outcome === 'release') setStatus(req, 'completed', `Resolved — €${req.price} released to traveler`);
  else setStatus(req, 'refunded', `Resolved — €${req.price} refunded to buyer`);
  toast('Dispute resolved');
  renderAll();
}

// ---------- Boot ----------
function renderAll(){
  renderHeroPass();
  renderNotifDot();
  renderTrips();
  renderDetail();
  renderDashboard();
  renderDispute();
}

function scheduleSeedAccepts(){
  state.requests.filter(r => r.status === 'pending' && !tripById(r.tripId).mine).forEach(r => scheduleAutoAccept(r.id));
}

function resetDemo(){
  state = seed();
  save();
  showView('home');
  scheduleSeedAccepts();
  toast('Demo data reset');
}

$('lt-city').innerHTML = '<option value="">Choose a city</option>' +
  Object.entries(CITIES).map(([code, c]) => `<option value="${code}">${c.city} (${code})</option>`).join('');
$('lt-date').min = localDate();
$('lt-categories').innerHTML = CATEGORIES.map(c => `<button type="button" class="cat-chip" data-cat="${c}">${c === 'General' ? 'Gifts & general' : c}</button>`).join('');

document.querySelectorAll('[data-view]').forEach(t => t.addEventListener('click', () => showView(t.dataset.view)));
$('search').addEventListener('input', e => {
  searchTerm = e.target.value;
  if(!$('view-browse').classList.contains('active')) showView('browse');
  else renderTrips();
});
document.querySelectorAll('[data-cat-tile]').forEach(t => t.addEventListener('click', () => {
  searchTerm = $('search').value = t.dataset.catTile;
  state.filter = 'all';
  showView('browse');
}));
document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { state.filter = c.dataset.filter; save(); renderTrips(); }));
document.querySelectorAll('.cat-chip').forEach(c => c.addEventListener('click', () => c.classList.toggle('on')));
$('trip-grid').addEventListener('click', e => { const card = e.target.closest('[data-trip]'); if(card) openTrip(card.dataset.trip); });
$('view-dashboard').addEventListener('click', e => { const b = e.target.closest('[data-act]'); if(b) handleDashAction(b.dataset.act, b.dataset.id); });

renderAll();
scheduleSeedAccepts();
