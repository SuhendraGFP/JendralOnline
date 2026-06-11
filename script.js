/* ================================================
   JENDERAL ONLINE — script.js
   Vanilla JS + Firebase Firestore realtime multiplayer
   ================================================ */

"use strict";

/* ================================================================
   0. FIREBASE CONFIGURATION
   ─ Ganti nilai di bawah dengan konfigurasi project Firebase Anda.
   ─ Buat project di https://console.firebase.google.com/
   ─ Aktifkan: Firestore Database + Anonymous Authentication
   ================================================================ */
const firebaseConfig = {
  apiKey: "AIzaSyDmvjWxdrpjsX6KXoV6ICVySjqiEiJEuDM",
  authDomain: "jendral-a50ff.firebaseapp.com",
  projectId: "jendral-a50ff",
  storageBucket: "jendral-a50ff.firebasestorage.app",
  messagingSenderId: "159159752383",
  appId: "1:159159752383:web:62163996db10f5ce73580a",
  measurementId: "G-YTHVQV1L47"
};

/* ================================================================
   1. CARD ENGINE
   ================================================================ */
const SUITS   = ['♠','♥','♦','♣'];          // spade, heart, diamond, club
const RANKS   = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
const RANK_VAL= Object.fromEntries(RANKS.map((r,i) => [r, i]));
const SUIT_VAL= {'♠':0,'♥':1,'♦':2,'♣':3};

function buildDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (const rank of RANKS)
      deck.push({ rank, suit, id: `${rank}${suit}` });
  return deck;
}

function shuffleDeck(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function cardValue(card) {
  return RANK_VAL[card.rank] * 4 + SUIT_VAL[card.suit];
}

function compareCards(a, b) { return cardValue(a) - cardValue(b); }

function sortHand(cards) { return [...cards].sort(compareCards); }

/* ──────── Combo detection ──────── */
const ComboType = { SINGLE:'single', TRIPLE:'triple', STRAIGHT:'straight', FOUR:'four' };

function detectCombo(cards) {
  if (!cards || cards.length === 0) return null;
  const n = cards.length;
  const sorted = sortHand(cards);

  // Single
  if (n === 1) return { type: ComboType.SINGLE, cards: sorted, high: cardValue(sorted[0]) };

  // Four of a kind
  if (n === 4) {
    const ranks = sorted.map(c => c.rank);
    if (ranks.every(r => r === ranks[0]))
      return { type: ComboType.FOUR, cards: sorted, high: cardValue(sorted[3]) };
  }

  // Triple
  if (n === 3) {
    const ranks = sorted.map(c => c.rank);
    if (ranks.every(r => r === ranks[0]))
      return { type: ComboType.TRIPLE, cards: sorted, high: cardValue(sorted[2]) };
  }

  // Straight (min 3, no 2)
  if (n >= 3) {
    const hasTwo = sorted.some(c => c.rank === '2');
    if (hasTwo) return null;
    const rankIdxs = sorted.map(c => RANK_VAL[c.rank]);
    // must be consecutive unique ranks
    const isContig = rankIdxs.every((v, i) => i === 0 || v === rankIdxs[i-1] + 1);
    const allUniqRank = new Set(sorted.map(c => c.rank)).size === n;
    if (isContig && allUniqRank)
      return { type: ComboType.STRAIGHT, cards: sorted, high: cardValue(sorted[n-1]), len: n };
  }

  return null;
}

function canBeat(current, attempt) {
  if (!current) return true; // opening move
  if (current.type !== attempt.type) return false;
  if (current.type === ComboType.STRAIGHT && current.len !== attempt.len) return false;
  return attempt.high > current.high;
}

/* ================================================================
   2. APP STATE
   ================================================================ */
const State = {
  myUid:      null,
  myName:     null,
  roomId:     null,
  roomData:   null,
  myHand:     [],          // Card objects for local player
  selected:   new Set(),   // selected card ids
  unsubRoom:  null,        // Firestore listener
  positions:  ['bottom','left','top','right'], // relative positions
};

/* ================================================================
   3. FIREBASE INIT
   ================================================================ */
let db, auth;

function initFirebase() {
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    db   = firebase.firestore();
    auth = firebase.auth();
    auth.signInAnonymously().then(cred => {
      State.myUid = cred.user.uid;
      console.log('[Auth] UID:', State.myUid);
    }).catch(err => {
      showToast('Firebase Auth gagal: ' + err.message, 'error');
      console.error(err);
    });
  } catch(e) {
    console.error('Firebase init error:', e);
    showToast('Konfigurasi Firebase belum diisi. Lihat script.js bagian atas.', 'error');
  }
}

/* ================================================================
   4. ROOM MANAGEMENT
   ================================================================ */
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function createRoom() {
  const name = getPlayerName(); if (!name) return;
  if (!State.myUid) { showToast('Autentikasi belum selesai, coba lagi.', 'error'); return; }

  const code = generateRoomCode();
  const player = makePlayerObj(State.myUid, name, 0);

  const roomDoc = {
    code,
    status:   'waiting',        // waiting | playing | ended
    phase:    'ready',          // ready | deal | play
    players:  { [State.myUid]: player },
    playerOrder: [State.myUid],
    hostUid:  State.myUid,
    currentCombo:  null,
    currentPlayer: null,
    passCount: 0,
    rankings:  [],
    activePlayers: [],
    lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
  };

  try {
    const ref = await db.collection('rooms').add(roomDoc);
    State.roomId = ref.id;
    State.myName = name;
    enterWaitingRoom();
    subscribeRoom();
  } catch(e) {
    showToast('Gagal membuat room: ' + e.message, 'error');
  }
}

async function joinRoom() {
  const name = getPlayerName(); if (!name) return;
  const code = document.getElementById('input-room-code').value.trim().toUpperCase();
  if (code.length < 4) { showError('Masukkan kode room yang valid.'); return; }
  if (!State.myUid) { showToast('Autentikasi belum selesai, coba lagi.', 'error'); return; }

  try {
    const snap = await db.collection('rooms').where('code','==',code).where('status','==','waiting').limit(1).get();
    if (snap.empty) { showError('Room tidak ditemukan atau sudah mulai.'); return; }

    const ref   = snap.docs[0].ref;
    const data  = snap.docs[0].data();
    const count = Object.keys(data.players || {}).length;
    if (count >= 4) { showError('Room sudah penuh (4 pemain).'); return; }
    if (data.players[State.myUid]) { /* already in */ }

    const seatIndex = count;
    const player = makePlayerObj(State.myUid, name, seatIndex);

    await ref.update({
      [`players.${State.myUid}`]: player,
      playerOrder: firebase.firestore.FieldValue.arrayUnion(State.myUid),
    });

    State.roomId = snap.docs[0].id;
    State.myName = name;
    enterWaitingRoom();
    subscribeRoom();
  } catch(e) {
    showError('Gagal gabung: ' + e.message);
  }
}

function makePlayerObj(uid, name, seat) {
  return { uid, name, seat, ready: false, handCount: 0, finished: false, rank: null };
}

/* ================================================================
   5. FIRESTORE REALTIME LISTENER
   ================================================================ */
function subscribeRoom() {
  if (State.unsubRoom) State.unsubRoom();
  State.unsubRoom = db.collection('rooms').doc(State.roomId)
    .onSnapshot(snap => {
      if (!snap.exists) { handleRoomDeleted(); return; }
      const data = snap.data();
      State.roomData = data;
      onRoomUpdate(data);
    }, err => console.error('Room listener error:', err));
}

function onRoomUpdate(data) {
  if (data.status === 'waiting') {
    renderWaitingRoom(data);
    // Auto-start if all ready and >= 2 players
    const players = Object.values(data.players || {});
    const humanCount = players.length;
    if (humanCount >= 2 && players.every(p => p.ready) && data.hostUid === State.myUid) {
      startGame(data);
    }
  } else if (data.status === 'playing') {
    const currentScreen = document.querySelector('.screen.active');
    if (!currentScreen || currentScreen.id !== 'screen-game') showScreen('game');
    renderGameState(data);
  } else if (data.status === 'ended') {
    renderRanking(data.rankings || []);
    showScreen('ranking');
  }
}

/* ================================================================
   6. WAITING ROOM UI
   ================================================================ */
function enterWaitingRoom() {
  showScreen('waiting');
  document.getElementById('display-room-code').textContent = '…';
}

function renderWaitingRoom(data) {
  document.getElementById('display-room-code').textContent = data.code;

  const players = data.players || {};
  const grid    = document.getElementById('seats-grid');
  grid.innerHTML = '';

  for (let i = 0; i < 4; i++) {
    const playerEntry = Object.values(players).find(p => p.seat === i);
    const card = document.createElement('div');
    card.className = 'seat-card' + (playerEntry ? ' occupied' : '') +
                     (playerEntry && playerEntry.uid === State.myUid ? ' self' : '');

    if (playerEntry) {
      const initials = playerEntry.name.substring(0,2).toUpperCase();
      const isReady  = playerEntry.ready;
      card.innerHTML = `
        <div class="seat-avatar filled">${initials}</div>
        <div class="seat-info">
          <div class="seat-name">${esc(playerEntry.name)}</div>
          <div class="seat-status ${isReady?'ready':'waiting'}">${isReady?'Siap ✓':'Menunggu…'}</div>
        </div>
        ${isReady ? '<span class="seat-ready-badge">SIAP</span>' : ''}
      `;
    } else {
      card.innerHTML = `
        <div class="seat-avatar empty">+</div>
        <div class="seat-info">
          <div class="seat-name" style="color:var(--text-muted)">Kursi ${i+1}</div>
          <div class="seat-status empty">Kosong</div>
        </div>
      `;
    }
    grid.appendChild(card);
  }

  // Update ready button
  const me = players[State.myUid];
  const readyBtn = document.getElementById('btn-ready');
  if (me) {
    readyBtn.textContent = me.ready ? '✓ Sudah Siap' : 'Siap!';
    readyBtn.className   = me.ready ? 'btn btn-ghost' : 'btn btn-primary';
  }

  const count  = Object.keys(players).length;
  const allRdy = Object.values(players).every(p => p.ready);
  document.getElementById('waiting-status').textContent =
    count < 2 ? `Menunggu pemain… (${count}/4)` :
    allRdy     ? 'Semua siap! Memulai permainan…' :
                 `${count} pemain bergabung · Menunggu semua siap…`;
}

async function toggleReady() {
  if (!State.roomId || !State.myUid) return;
  const me = State.roomData?.players?.[State.myUid];
  if (!me) return;
  await db.collection('rooms').doc(State.roomId).update({
    [`players.${State.myUid}.ready`]: !me.ready,
  });
}

async function leaveRoom() {
  if (State.unsubRoom) State.unsubRoom();
  if (State.roomId && State.myUid) {
    // Remove from players (best effort)
    try {
      await db.collection('rooms').doc(State.roomId).update({
        [`players.${State.myUid}`]: firebase.firestore.FieldValue.delete(),
        playerOrder: firebase.firestore.FieldValue.arrayRemove(State.myUid),
      });
    } catch(e) {}
  }
  State.roomId = null; State.roomData = null; State.myHand = []; State.selected.clear();
  showScreen('lobby');
}

/* ================================================================
   7. GAME START — Deal cards (host only)
   ================================================================ */
async function startGame(data) {
  // Guard: only start once
  if (data.phase === 'playing') return;

  const deck    = shuffleDeck(buildDeck());
  const players = Object.values(data.players);
  const humanCount = players.length;

  // 4 hands (including ghost seats)
  const hands = [[],[],[],[]];
  deck.forEach((card, i) => hands[i % 4].push(card));

  // Map seat → uid
  const seatToUid = {};
  players.forEach(p => { seatToUid[p.seat] = p.uid; });

  // Build per-player hand data
  const handData = {};
  const activePlayers = [];
  for (let seat = 0; seat < 4; seat++) {
    const uid = seatToUid[seat];
    const h   = hands[seat];
    if (uid) {
      handData[uid] = h;
      activePlayers.push(uid);
    }
    // ghost seat: no storage needed (just visual)
  }

  // Find who has 3♠ (lowest card) → starts
  let startPlayer = activePlayers[0];
  for (const uid of activePlayers) {
    const has3S = handData[uid].some(c => c.rank === '3' && c.suit === '♠');
    if (has3S) { startPlayer = uid; break; }
  }

  // Build playerOrder in seat order
  const playerOrder = [...activePlayers].sort((a,b) => {
    return (data.players[a]?.seat ?? 99) - (data.players[b]?.seat ?? 99);
  });

  // Persist
  const batch = db.batch();
  const roomRef = db.collection('rooms').doc(State.roomId);

  // Store each player's hand as sub-doc for security
  for (const uid of activePlayers) {
    const handRef = roomRef.collection('hands').doc(uid);
    batch.set(handRef, { cards: handData[uid] });
    batch.update(roomRef, { [`players.${uid}.handCount`]: handData[uid].length });
  }

  // Ghost hands (store counts only)
  for (let seat = 0; seat < 4; seat++) {
    if (!seatToUid[seat]) {
      batch.update(roomRef, { [`ghostHands.seat${seat}`]: hands[seat].length });
    }
  }

  batch.update(roomRef, {
    status:       'playing',
    phase:        'playing',
    currentPlayer: startPlayer,
    playerOrder,
    activePlayers,
    currentCombo:  null,
    passCount:     0,
    rankings:      [],
    lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();
}

/* ================================================================
   8. LOAD MY HAND
   ================================================================ */
async function loadMyHand() {
  try {
    const doc = await db.collection('rooms').doc(State.roomId)
                        .collection('hands').doc(State.myUid).get();
    if (doc.exists) State.myHand = sortHand(doc.data().cards || []);
  } catch(e) {
    console.error('loadMyHand error:', e);
  }
}

/* ================================================================
   9. GAME RENDER
   ================================================================ */
async function renderGameState(data) {
  // Load my hand from sub-collection if not yet loaded or hand changed
  const me = data.players?.[State.myUid];
  if (!me) return;

  if (State.myHand.length !== (me.handCount ?? 0) || State.myHand.length === 0) {
    await loadMyHand();
  }

  const allPlayers = Object.values(data.players || {});

  // Map players to visual positions relative to me
  // Positions: bottom = me, left, top, right (clockwise)
  const mySeat  = me.seat;
  const relPos  = (seat) => {
    const diff = ((seat - mySeat) + 4) % 4;
    return ['bottom','left','top','right'][diff];
  };

  // Fill 4 visual slots
  const visualSlots = { bottom: null, left: null, top: null, right: null };
  allPlayers.forEach(p => { visualSlots[relPos(p.seat)] = p; });

  // Render each position
  const positions = ['bottom','left','top','right'];
  for (const pos of positions) {
    const p = visualSlots[pos];
    renderPlayerSlot(pos, p, data);
  }

  // Render ghost seats (card backs for empty seats)
  for (let seat = 0; seat < 4; seat++) {
    if (!allPlayers.find(p => p.seat === seat)) {
      const pos  = relPos(seat);
      const cnt  = data.ghostHands?.[`seat${seat}`] ?? 0;
      renderGhostSlot(pos, cnt);
    }
  }

  // Render pot
  renderPot(data.currentCombo);

  // Action bar
  const isMyTurn = data.currentPlayer === State.myUid;
  const finished = me.finished;
  setTurnUI(isMyTurn && !finished);

  // Game log
  if (data.lastAction) addLog(data.lastAction, data.lastActionPlayer);
}

function renderPlayerSlot(pos, player, data) {
  const labelEl = document.getElementById(`label-${pos}`);
  const handEl  = document.getElementById(`hand-${pos}`);

  if (pos === 'bottom') {
    // Self
    if (!player) { labelEl.textContent = ''; handEl.innerHTML = ''; return; }
    labelEl.textContent = player.name;
    labelEl.className   = 'player-label self';
    if (data.currentPlayer === player.uid) labelEl.classList.add('active-turn');
    renderSelfHand();
    return;
  }

  // Opponent slot
  if (!player) {
    labelEl.textContent = '';
    handEl.innerHTML    = '';
    return;
  }

  const isActive = data.currentPlayer === player.uid;
  labelEl.textContent = player.name + (player.finished ? ' ✓' : '');
  labelEl.className   = 'player-label' + (isActive ? ' active-turn' : '');

  // Show card stack (face-down)
  handEl.innerHTML = '';
  const cnt = player.handCount ?? 0;
  if (cnt > 0) {
    const stack = document.createElement('div');
    stack.className = 'card-stack';
    const cardEl = createFaceDownCard();
    const badge  = document.createElement('div');
    badge.className = 'card-count-badge';
    badge.textContent = cnt;
    stack.appendChild(cardEl);
    stack.appendChild(badge);
    handEl.appendChild(stack);
  }
}

function renderGhostSlot(pos, count) {
  if (pos === 'bottom') return;
  const handEl  = document.getElementById(`hand-${pos}`);
  const labelEl = document.getElementById(`label-${pos}`);
  if (handEl.innerHTML !== '' && !handEl.querySelector('.ghost-label')) return; // already rendered by real player
  if (!document.getElementById(`label-${pos}`).textContent) {
    labelEl.textContent = 'Bot';
    labelEl.className   = 'player-label';
  }
  if (handEl.innerHTML === '') {
    handEl.innerHTML = '';
    if (count > 0) {
      const stack = document.createElement('div');
      stack.className = 'card-stack';
      stack.appendChild(createFaceDownCard());
      const badge = document.createElement('div');
      badge.className = 'card-count-badge';
      badge.textContent = count;
      stack.appendChild(badge);
      handEl.appendChild(stack);
    }
  }
}

function renderSelfHand() {
  const handEl = document.getElementById('hand-bottom');
  handEl.innerHTML = '';
  const sorted = sortHand(State.myHand);
  sorted.forEach(card => {
    const el = createCardEl(card);
    el.addEventListener('click', () => toggleSelectCard(card.id));
    handEl.appendChild(el);
  });
  renderComboPreview();
}

function renderPot(combo) {
  const potEl   = document.getElementById('pot-cards');
  const labelEl = document.getElementById('combo-type-label');
  potEl.innerHTML = '';
  if (!combo || !combo.cards || combo.cards.length === 0) {
    labelEl.textContent = '';
    return;
  }
  combo.cards.forEach(card => potEl.appendChild(createCardEl(card, false)));
  const typeLabels = {
    single:'Single', triple:'Triple', straight:'Straight', four:'FOUR OF A KIND!'
  };
  labelEl.textContent = typeLabels[combo.type] || '';
}

function renderComboPreview() {
  const preview  = document.getElementById('combo-cards-preview');
  const label    = document.querySelector('.combo-preview-label');
  preview.innerHTML = '';
  const selectedCards = State.myHand.filter(c => State.selected.has(c.id));

  if (selectedCards.length === 0) {
    label.textContent = 'Pilih kartu untuk combo…';
    label.style.display = '';
    enablePlayBtn(false);
    return;
  }

  label.style.display = 'none';
  selectedCards.forEach(c => preview.appendChild(createCardEl(c, false)));

  const combo = detectCombo(selectedCards);
  enablePlayBtn(!!combo);
}

function renderRanking(rankings) {
  const list = document.getElementById('ranking-list');
  list.innerHTML = '';
  rankings.forEach((r, i) => {
    const posClass = ['p1','p2','p3','p4'][i] || 'p4';
    const medals   = ['🥇','🥈','🥉','4'];
    const row = document.createElement('div');
    row.className = 'rank-row';
    row.innerHTML = `
      <div class="rank-pos ${posClass}">${medals[i] || i+1}</div>
      <div class="rank-name">${esc(r.name)}</div>
      <div class="rank-note">${r.note || ''}</div>
    `;
    list.appendChild(row);
  });
}

/* ================================================================
   10. CARD ELEMENT FACTORIES
   ================================================================ */
function createCardEl(card, clickable = true) {
  const el  = document.createElement('div');
  const red = ['♥','♦'].includes(card.suit);
  el.className = `card ${red?'red':'black'}`;
  el.dataset.cardId = card.id;
  if (State.selected.has(card.id)) el.classList.add('selected');
  el.innerHTML = `
    <div class="card-rank">${card.rank}</div>
    <div class="card-suit">${card.suit}</div>
    <div class="card-rank-bottom">${card.rank}</div>
  `;
  if (!clickable) el.style.cursor = 'default';
  return el;
}

function createFaceDownCard() {
  const el = document.createElement('div');
  el.className = 'card face-down';
  return el;
}

/* ================================================================
   11. CARD SELECTION & ACTIONS
   ================================================================ */
function toggleSelectCard(cardId) {
  if (!document.getElementById('btn-play').disabled === false) {
    // Only allow selection on my turn (btn-play enabled = my turn)
    if (document.getElementById('btn-pass').disabled) return;
  }
  if (State.selected.has(cardId)) State.selected.delete(cardId);
  else                            State.selected.add(cardId);
  renderSelfHand();
}

function cancelCombo() {
  State.selected.clear();
  renderSelfHand();
}

async function playCards() {
  const selectedCards = State.myHand.filter(c => State.selected.has(c.id));
  if (selectedCards.length === 0) return;

  const attempt = detectCombo(selectedCards);
  if (!attempt) { showToast('Kombinasi tidak valid!', 'error'); return; }

  const current = State.roomData?.currentCombo;
  if (!canBeat(current, attempt)) { showToast('Kombinasi tidak cukup tinggi!', 'error'); return; }

  // Animate selected cards
  State.myHand.filter(c => State.selected.has(c.id))
    .forEach(c => {
      const el = document.querySelector(`[data-card-id="${c.id}"]`);
      if (el) el.classList.add('playing');
    });

  // Remove from hand
  const newHand = State.myHand.filter(c => !State.selected.has(c.id));
  const isFour  = attempt.type === ComboType.FOUR;
  const handFinished = newHand.length === 0;

  // Prepare DB updates
  const roomRef = db.collection('rooms').doc(State.roomId);
  const batch   = db.batch();

  // Update hand sub-doc
  batch.set(roomRef.collection('hands').doc(State.myUid), { cards: newHand });

  const me       = State.roomData.players[State.myUid];
  const active   = [...(State.roomData.activePlayers || [])];
  const rankings = [...(State.roomData.rankings || [])];

  let newActivePlayers = active;
  let nextPlayer       = nextActivePlayer(State.myUid, active, State.roomData.playerOrder);
  let newStatus        = 'playing';
  let actionNote       = '';

  if (isFour) {
    // Auto win this round
    rankings.unshift({ uid: State.myUid, name: me.name, note: 'Four of a Kind! 🎉' });
    newActivePlayers = active.filter(u => u !== State.myUid);
    nextPlayer       = nextActivePlayer(State.myUid, newActivePlayers, State.roomData.playerOrder);
    actionNote       = `${me.name} menang dengan FOUR OF A KIND!`;
    batch.update(roomRef, { [`players.${State.myUid}.finished`]: true,
                             [`players.${State.myUid}.rank`]: rankings.length });
  } else if (handFinished) {
    rankings.push({ uid: State.myUid, name: me.name, note: `Selesai ke-${rankings.length+1}` });
    newActivePlayers = active.filter(u => u !== State.myUid);
    nextPlayer       = nextActivePlayer(State.myUid, newActivePlayers, State.roomData.playerOrder);
    actionNote       = `${me.name} menghabiskan kartu!`;
    batch.update(roomRef, { [`players.${State.myUid}.finished`]: true,
                             [`players.${State.myUid}.rank`]: rankings.length });
  } else {
    actionNote = `${me.name} memainkan ${attempt.type} (${selectedCards.map(c=>c.rank+c.suit).join(' ')})`;
  }

  // Check game over
  if (newActivePlayers.length <= 1) {
    if (newActivePlayers.length === 1) {
      const lastUid  = newActivePlayers[0];
      const lastName = State.roomData.players[lastUid]?.name || 'Pemain';
      rankings.push({ uid: lastUid, name: lastName, note: 'Jenderal Terakhir' });
      batch.update(roomRef, { [`players.${lastUid}.finished`]: true });
    }
    newStatus = 'ended';
  }

  batch.update(roomRef, {
    currentCombo:     attempt,
    currentPlayer:    nextPlayer,
    passCount:        0,
    activePlayers:    newActivePlayers,
    rankings,
    status:           newStatus,
    lastAction:       actionNote,
    lastActionPlayer: State.myUid,
    [`players.${State.myUid}.handCount`]: newHand.length,
    lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();

  State.myHand  = sortHand(newHand);
  State.selected.clear();
}

async function passPlay() {
  const data   = State.roomData;
  const active = data.activePlayers || [];
  const me     = data.players[State.myUid];

  const newPassCount = (data.passCount || 0) + 1;
  const nextPlayer   = nextActivePlayer(State.myUid, active, data.playerOrder);

  let newCombo  = data.currentCombo;
  let passCount = newPassCount;

  // If all other active players passed → clear combo, winner of round opens next
  if (newPassCount >= active.length - 1) {
    // The player who last played (not passed) opens next
    const lastPlayer = data.currentCombo?.playedBy || State.myUid;
    newCombo  = null;
    passCount = 0;
    await db.collection('rooms').doc(State.roomId).update({
      currentCombo:  null,
      passCount:     0,
      currentPlayer: lastPlayer,
      lastAction:    `${me.name} pass — Putaran baru dimulai`,
      lastActionPlayer: State.myUid,
      lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
    });
    return;
  }

  await db.collection('rooms').doc(State.roomId).update({
    currentPlayer:    nextPlayer,
    passCount,
    lastAction:       `${me.name} pass`,
    lastActionPlayer: State.myUid,
    lastUpdated: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

function nextActivePlayer(currentUid, activePlayers, playerOrder) {
  if (!activePlayers || activePlayers.length === 0) return null;
  const ordered = (playerOrder || []).filter(u => activePlayers.includes(u));
  const idx = ordered.indexOf(currentUid);
  return ordered[(idx + 1) % ordered.length] || ordered[0];
}

/* ================================================================
   12. TURN UI
   ================================================================ */
function setTurnUI(isMyTurn) {
  document.getElementById('turn-indicator').classList.toggle('hidden', !isMyTurn);
  document.getElementById('btn-pass').disabled  = !isMyTurn;
  document.getElementById('btn-cancel').disabled = !isMyTurn;
  if (!isMyTurn) {
    State.selected.clear();
    renderSelfHand();
    enablePlayBtn(false);
  }
}

function enablePlayBtn(enable) {
  const isMyTurn = !document.getElementById('btn-pass').disabled;
  document.getElementById('btn-play').disabled = !enable || !isMyTurn;
}

/* ================================================================
   13. LOG
   ================================================================ */
function addLog(msg, senderUid) {
  const log  = document.getElementById('game-log');
  const el   = document.createElement('div');
  el.className = 'log-entry' + (senderUid === State.myUid ? ' highlight' : '');
  el.textContent = msg;
  log.prepend(el);
  while (log.children.length > 30) log.removeChild(log.lastChild);
}

/* ================================================================
   14. SCREEN MANAGER
   ================================================================ */
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.toggle('active', s.id === `screen-${name}`);
  });
}

/* ================================================================
   15. TOAST & HELPERS
   ================================================================ */
let toastTimer;
function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

function showError(msg) {
  const el = document.getElementById('lobby-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function getPlayerName() {
  const name = document.getElementById('input-name').value.trim();
  if (!name) { showError('Masukkan nama pemain terlebih dahulu.'); return null; }
  return name;
}

function esc(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function handleRoomDeleted() {
  showToast('Room telah dihapus.', 'error');
  showScreen('lobby');
}

/* ================================================================
   16. EVENT LISTENERS
   ================================================================ */
document.addEventListener('DOMContentLoaded', () => {
  initFirebase();

  // Lobby
  document.getElementById('btn-create').addEventListener('click', createRoom);
  document.getElementById('btn-join').addEventListener('click', () => {
    document.getElementById('join-section').classList.toggle('hidden');
  });
  document.getElementById('btn-join-confirm').addEventListener('click', joinRoom);

  // Waiting room
  document.getElementById('btn-ready').addEventListener('click', toggleReady);
  document.getElementById('btn-leave').addEventListener('click', leaveRoom);
  document.getElementById('btn-copy-code').addEventListener('click', () => {
    const code = document.getElementById('display-room-code').textContent;
    navigator.clipboard?.writeText(code).then(() => showToast('Kode disalin!', 'success'));
  });

  // Game actions
  document.getElementById('btn-play').addEventListener('click',   playCards);
  document.getElementById('btn-pass').addEventListener('click',   passPlay);
  document.getElementById('btn-cancel').addEventListener('click', cancelCombo);

  // Ranking
  document.getElementById('btn-back-lobby').addEventListener('click', () => {
    if (State.unsubRoom) State.unsubRoom();
    State.roomId = null; State.myHand = []; State.selected.clear();
    showScreen('lobby');
  });

  // Hide error on input
  ['input-name','input-room-code'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      document.getElementById('lobby-error')?.classList.add('hidden');
    });
  });

  // Enter key in room code
  document.getElementById('input-room-code')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') joinRoom();
  });
});