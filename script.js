/* ================================================
   JENDERAL ONLINE — script.js  v3
   Mobile-first · Drag reorder · Deal animation
   Shuffle animation · Host start button · Ghost bots silent
   ================================================ */
"use strict";

/* ================================================================
   0. FIREBASE CONFIG — ganti dengan milik Anda
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
const SUITS    = ['♠','♥','♦','♣'];
const RANKS    = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
const RANK_VAL = Object.fromEntries(RANKS.map((r,i)=>[r,i]));
const SUIT_VAL = {'♠':0,'♥':1,'♦':2,'♣':3};

function buildDeck(){
  const d=[];
  for(const s of SUITS) for(const r of RANKS) d.push({rank:r,suit:s,id:`${r}${s}`});
  return d;
}
function shuffleDeck(deck){
  const d=[...deck];
  for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]];}
  return d;
}
function cardValue(c){ return RANK_VAL[c.rank]*4+SUIT_VAL[c.suit]; }
function compareCards(a,b){ return cardValue(a)-cardValue(b); }
function sortHand(cards){ return [...cards].sort(compareCards); }

const ComboType={SINGLE:'single',TRIPLE:'triple',STRAIGHT:'straight',FOUR:'four'};

function detectCombo(cards){
  if(!cards||!cards.length) return null;
  const n=cards.length, s=sortHand(cards);
  if(n===1) return {type:ComboType.SINGLE,cards:s,high:cardValue(s[0])};
  if(n===4){const r=s.map(c=>c.rank);if(r.every(x=>x===r[0])) return {type:ComboType.FOUR,cards:s,high:cardValue(s[3])};}
  if(n===3){const r=s.map(c=>c.rank);if(r.every(x=>x===r[0])) return {type:ComboType.TRIPLE,cards:s,high:cardValue(s[2])};}
  if(n>=3){
    if(s.some(c=>c.rank==='2')) return null;
    const ri=s.map(c=>RANK_VAL[c.rank]);
    const ok=ri.every((v,i)=>i===0||v===ri[i-1]+1);
    if(ok&&new Set(s.map(c=>c.rank)).size===n)
      return {type:ComboType.STRAIGHT,cards:s,high:cardValue(s[n-1]),len:n};
  }
  return null;
}
function canBeat(cur,att){
  if(!cur) return true;
  if(cur.type!==att.type) return false;
  if(cur.type===ComboType.STRAIGHT&&cur.len!==att.len) return false;
  return att.high>cur.high;
}

/* ================================================================
   2. APP STATE
   ================================================================ */
const State={
  myUid:    null,
  myName:   null,
  roomId:   null,
  roomData: null,
  myHand:   [],         // local hand order (may differ from sorted)
  selected: new Set(),
  unsubRoom:null,
  isHost:   false,
  lastLogAction: '',    // deduplicate log entries
};

/* ================================================================
   3. FIREBASE INIT
   ================================================================ */
let db,auth;
let authReady;
let resolveAuth;

function initFirebase(){
  authReady=new Promise(r=>{resolveAuth=r;});
  try{
    if(!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    db=firebase.firestore();
    auth=firebase.auth();
    auth.onAuthStateChanged(user=>{
      if(user){
        State.myUid=user.uid;
        resolveAuth(user.uid);
        setAuthUI('ready');
      } else {
        setAuthUI('loading');
        auth.signInAnonymously().catch(e=>{setAuthUI('error',e.message);});
      }
    });
  }catch(e){
    setAuthUI('error','Konfigurasi Firebase salah: '+e.message);
  }
}

function setAuthUI(s,msg){
  const bc=document.getElementById('btn-create');
  const bj=document.getElementById('btn-join-toggle');
  const er=document.getElementById('lobby-error');
  if(s==='loading'){
    bc.disabled=bj.disabled=true;
    bc.textContent=bj.textContent='⏳ Menghubungkan…';
  } else if(s==='ready'){
    bc.disabled=bj.disabled=false;
    bc.innerHTML='<span class="btn-icon">⊕</span> Buat Room';
    bj.innerHTML='<span class="btn-icon">⊞</span> Gabung Room';
    er.classList.add('hidden');
  } else {
    bc.disabled=bj.disabled=false;
    bc.innerHTML='<span class="btn-icon">⊕</span> Buat Room';
    bj.innerHTML='<span class="btn-icon">⊞</span> Gabung Room';
    er.textContent='⚠ '+msg;
    er.classList.remove('hidden');
  }
}

async function waitForAuth(){
  return Promise.race([
    authReady,
    new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),12000))
  ]).catch(e=>{
    showToast('Koneksi Firebase gagal. Periksa konfigurasi.',  'error');
    return null;
  });
}

/* ================================================================
   4. ROOM MANAGEMENT
   ================================================================ */
function genCode(){
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s=''; for(let i=0;i<6;i++) s+=c[Math.floor(Math.random()*c.length)];
  return s;
}

async function createRoom(){
  const name=getPlayerName(); if(!name) return;
  const uid=await waitForAuth(); if(!uid) return;
  const code=genCode();
  const player=makePlayer(uid,name,0);
  const doc={
    code, status:'waiting', phase:'ready',
    players:{[uid]:player}, playerOrder:[uid],
    hostUid:uid, currentCombo:null, currentPlayer:null,
    passCount:0, rankings:[], activePlayers:[],
    lastUpdated:firebase.firestore.FieldValue.serverTimestamp(),
  };
  try{
    const ref=await db.collection('rooms').add(doc);
    State.roomId=ref.id; State.myName=name; State.isHost=true;
    enterWaiting(); subscribeRoom();
  }catch(e){ showToast('Gagal buat room: '+e.message,'error'); }
}

async function joinRoom(){
  const name=getPlayerName(); if(!name) return;
  const code=document.getElementById('input-room-code').value.trim().toUpperCase();
  if(code.length<4){showError('Kode room tidak valid.');return;}
  const uid=await waitForAuth(); if(!uid) return;
  try{
    const snap=await db.collection('rooms')
      .where('code','==',code).where('status','==','waiting').limit(1).get();
    if(snap.empty){showError('Room tidak ditemukan atau sudah mulai.');return;}
    const ref=snap.docs[0].ref;
    const data=snap.docs[0].data();
    const count=Object.keys(data.players||{}).length;
    if(count>=4){showError('Room sudah penuh.');return;}
    if(data.players&&data.players[uid]){/* already in */}
    const player=makePlayer(uid,name,count);
    await ref.update({
      [`players.${uid}`]:player,
      playerOrder:firebase.firestore.FieldValue.arrayUnion(uid),
    });
    State.roomId=snap.docs[0].id; State.myName=name; State.isHost=false;
    enterWaiting(); subscribeRoom();
  }catch(e){ showError('Gagal gabung: '+e.message); }
}

function makePlayer(uid,name,seat){
  return {uid,name,seat,ready:false,handCount:0,finished:false,rank:null};
}

/* ================================================================
   5. REALTIME LISTENER
   ================================================================ */
function subscribeRoom(){
  if(State.unsubRoom) State.unsubRoom();
  State.unsubRoom=db.collection('rooms').doc(State.roomId)
    .onSnapshot(snap=>{
      if(!snap.exists){showToast('Room dihapus.','error');showScreen('lobby');return;}
      State.roomData=snap.data();
      onRoomUpdate(State.roomData);
    },e=>console.error('snapshot err',e));
}

function onRoomUpdate(data){
  if(data.status==='waiting'){
    renderWaiting(data);
    // Auto start: semua ready & >= 2 pemain & kita host
    const players=Object.values(data.players||{});
    if(players.length>=2 && players.every(p=>p.ready) && data.hostUid===State.myUid){
      doStartGame(data);
    }
  } else if(data.status==='playing'){
    const cur=document.querySelector('.screen.active');
    if(!cur||cur.id!=='screen-game') showScreen('game');
    renderGame(data);
  } else if(data.status==='ended'){
    renderRanking(data.rankings||[]);
    showScreen('ranking');
  }
}

/* ================================================================
   6. WAITING ROOM UI
   ================================================================ */
function enterWaiting(){
  showScreen('waiting');
  document.getElementById('display-room-code').textContent='…';
}

function renderWaiting(data){
  document.getElementById('display-room-code').textContent=data.code||'…';
  const players=data.players||{};
  const grid=document.getElementById('seats-grid');
  grid.innerHTML='';
  for(let i=0;i<4;i++){
    const p=Object.values(players).find(x=>x.seat===i);
    const card=document.createElement('div');
    card.className='seat-card'+(p?' occupied':'')+(p&&p.uid===State.myUid?' self':'');
    if(p){
      const init=p.name.substring(0,2).toUpperCase();
      card.innerHTML=`
        <div class="seat-avatar filled">${init}</div>
        <div class="seat-info">
          <div class="seat-name">${esc(p.name)}</div>
          <div class="seat-status ${p.ready?'ready':'waiting'}">${p.ready?'Siap ✓':'Menunggu…'}</div>
        </div>
        ${p.ready?'<span class="seat-ready-badge">SIAP</span>':''}`;
    } else {
      card.innerHTML=`
        <div class="seat-avatar empty">+</div>
        <div class="seat-info">
          <div class="seat-name" style="color:var(--text-muted)">Kursi ${i+1}</div>
          <div class="seat-status empty">Kosong</div>
        </div>`;
    }
    grid.appendChild(card);
  }
  // Ready button
  const me=players[State.myUid];
  const readyBtn=document.getElementById('btn-ready');
  if(me){
    readyBtn.textContent=me.ready?'✓ Sudah Siap':'Siap!';
    readyBtn.className=me.ready?'btn btn-ghost':'btn btn-primary';
  }
  // Host start button — tampil jika kita host & >= 2 orang
  const isHost=data.hostUid===State.myUid;
  const count=Object.keys(players).length;
  const startBtn=document.getElementById('btn-start-host');
  startBtn.classList.toggle('hidden',!(isHost&&count>=2));
  // Status
  const allRdy=Object.values(players).every(p=>p.ready);
  document.getElementById('waiting-status').textContent=
    count<2?`Menunggu pemain… (${count}/4)`:
    allRdy?'Semua siap! Memulai permainan…':
    `${count} pemain · Menunggu semua siap…`;
}

async function toggleReady(){
  if(!State.roomId||!State.myUid) return;
  const me=State.roomData?.players?.[State.myUid];
  if(!me) return;
  await db.collection('rooms').doc(State.roomId).update({
    [`players.${State.myUid}.ready`]:!me.ready,
  });
}

async function hostForceStart(){
  // Host bisa mulai tanpa semua klik siap
  const data=State.roomData;
  if(!data||data.hostUid!==State.myUid) return;
  const count=Object.keys(data.players||{}).length;
  if(count<2){showToast('Minimal 2 pemain.','error');return;}
  await doStartGame(data);
}

async function leaveRoom(){
  if(State.unsubRoom) State.unsubRoom();
  if(State.roomId&&State.myUid){
    try{
      await db.collection('rooms').doc(State.roomId).update({
        [`players.${State.myUid}`]:firebase.firestore.FieldValue.delete(),
        playerOrder:firebase.firestore.FieldValue.arrayRemove(State.myUid),
      });
    }catch(e){}
  }
  State.roomId=null; State.roomData=null; State.myHand=[];
  State.selected.clear(); State.isHost=false;
  showScreen('lobby');
}

/* ================================================================
   7. GAME START + DEAL ANIMATION
   ================================================================ */
async function doStartGame(data){
  if(data.phase==='playing') return; // guard double-start
  // Lock phase immediately to prevent double calls from multiple clients
  await db.collection('rooms').doc(State.roomId).update({phase:'dealing'}).catch(()=>{});

  const deck=shuffleDeck(buildDeck());
  const players=Object.values(data.players);

  const hands=[[],[],[],[]];
  deck.forEach((c,i)=>hands[i%4].push(c));

  const seatToUid={};
  players.forEach(p=>{seatToUid[p.seat]=p.uid;});

  const handData={};
  const activePlayers=[];
  for(let seat=0;seat<4;seat++){
    const uid=seatToUid[seat];
    if(uid){ handData[uid]=hands[seat]; activePlayers.push(uid); }
  }

  let startPlayer=activePlayers[0];
  for(const uid of activePlayers){
    if(handData[uid].some(c=>c.rank==='3'&&c.suit==='♠')){startPlayer=uid;break;}
  }
  const playerOrder=[...activePlayers].sort((a,b)=>(data.players[a]?.seat??99)-(data.players[b]?.seat??99));

  // Show deal animation
  await playDealAnimation(players.length);

  const batch=db.batch();
  const roomRef=db.collection('rooms').doc(State.roomId);
  for(const uid of activePlayers){
    batch.set(roomRef.collection('hands').doc(uid),{cards:handData[uid]});
    batch.update(roomRef,{[`players.${uid}.handCount`]:handData[uid].length});
  }
  for(let seat=0;seat<4;seat++){
    if(!seatToUid[seat]) batch.update(roomRef,{[`ghostHands.seat${seat}`]:hands[seat].length});
  }
  batch.update(roomRef,{
    status:'playing',phase:'playing',
    currentPlayer:startPlayer,playerOrder,activePlayers,
    currentCombo:null,passCount:0,rankings:[],
    lastUpdated:firebase.firestore.FieldValue.serverTimestamp(),
  });
  await batch.commit();
}

/* ── Deal + Shuffle animation ── */
function playDealAnimation(playerCount){
  return new Promise(resolve=>{
    const overlay=document.getElementById('deal-overlay');
    const deckEl=document.getElementById('deal-deck');
    const textEl=document.getElementById('deal-text');
    overlay.classList.remove('hidden');
    deckEl.innerHTML='';

    // Build 8 visual cards in deck
    const N=8;
    const cards=[];
    for(let i=0;i<N;i++){
      const c=document.createElement('div');
      c.className='deal-card';
      c.textContent='♠';
      c.style.zIndex=N-i;
      c.style.transform=`translateY(${-i*1.5}px)`;
      deckEl.appendChild(c);
      cards.push(c);
    }

    textEl.textContent='Mengocok kartu…';

    // Shuffle animation: 3 passes
    let pass=0;
    function shufflePass(){
      if(pass>=3){ startDeal(); return; }
      pass++;
      cards.forEach((c,i)=>{
        const goRight=i%2===0;
        c.style.transition='transform .25s ease';
        c.style.animation=`${goRight?'shuffle-right':'shuffle-left'} .35s ease`;
        c.style.animationDelay=`${i*18}ms`;
      });
      setTimeout(()=>{
        cards.forEach(c=>c.style.animation='');
        shufflePass();
      },500);
    }

    function startDeal(){
      textEl.textContent='Membagikan kartu…';
      // Fly cards off to 4 directions
      const dirs=[
        'translateY(200px)',   // bottom
        'translateX(-200px)',  // left
        'translateY(-200px)',  // top
        'translateX(200px)',   // right
      ];
      const total=playerCount*3; // 3 cards per "deal wave"
      let done=0;
      for(let i=0;i<total;i++){
        const dir=dirs[i%4];
        const rot=`${(Math.random()*40-20).toFixed(0)}deg`;
        const c=document.createElement('div');
        c.className='deal-card';
        c.textContent='♠';
        c.style.zIndex=200+i;
        c.style.setProperty('--deal-target',dir);
        c.style.setProperty('--deal-rot',rot);
        deckEl.appendChild(c);
        setTimeout(()=>{
          c.style.transition='none';
          c.style.animation=`deal-fly .45s ease forwards`;
          c.addEventListener('animationend',()=>{
            c.remove(); done++;
            if(done>=total){ finish(); }
          },{once:true});
        },i*60);
      }
    }

    function finish(){
      setTimeout(()=>{
        overlay.classList.add('hidden');
        resolve();
      },300);
    }

    setTimeout(shufflePass,200);
  });
}

/* ================================================================
   8. LOAD MY HAND
   ================================================================ */
async function loadMyHand(){
  try{
    const doc=await db.collection('rooms').doc(State.roomId)
                      .collection('hands').doc(State.myUid).get();
    if(doc.exists){
      const cards=sortHand(doc.data().cards||[]);
      // Preserve local reorder if same cards
      if(State.myHand.length===cards.length&&
         State.myHand.every(c=>cards.find(x=>x.id===c.id))){
        // keep local order
      } else {
        State.myHand=cards;
      }
    }
  }catch(e){ console.error('loadMyHand',e); }
}

/* ================================================================
   9. GAME RENDER
   ================================================================ */
async function renderGame(data){
  const me=data.players?.[State.myUid];
  if(!me) return;

  if(State.myHand.length!==me.handCount||State.myHand.length===0){
    await loadMyHand();
  }

  const allPlayers=Object.values(data.players||{});
  const mySeat=me.seat;
  const relPos=seat=>{
    const diff=((seat-mySeat)+4)%4;
    return ['bottom','left','top','right'][diff];
  };

  const slots={bottom:null,left:null,top:null,right:null};
  allPlayers.forEach(p=>{slots[relPos(p.seat)]=p;});

  for(const pos of ['bottom','left','top','right']){
    renderSlot(pos,slots[pos],data);
  }
  // Ghost seats
  for(let seat=0;seat<4;seat++){
    if(!allPlayers.find(p=>p.seat===seat)){
      renderGhost(relPos(seat),data.ghostHands?.[`seat${seat}`]??0);
    }
  }

  renderPot(data.currentCombo);
  const isMyTurn=data.currentPlayer===State.myUid&&!me.finished;
  setTurnUI(isMyTurn);

  // Log (deduplicate)
  if(data.lastAction&&data.lastAction!==State.lastLogAction){
    State.lastLogAction=data.lastAction;
    addLog(data.lastAction,data.lastActionPlayer);
  }
}

function renderSlot(pos,player,data){
  const lbl=document.getElementById(`label-${pos}`);
  const hnd=document.getElementById(`hand-${pos}`);
  if(pos==='bottom'){
    if(!player){lbl.textContent='';hnd.innerHTML='';return;}
    lbl.textContent=player.name+(player.finished?' ✓':'');
    lbl.className='player-label self'+(data.currentPlayer===player.uid?' active-turn':'');
    renderSelfHand();
    return;
  }
  if(!player){lbl.textContent='';hnd.innerHTML='';return;}
  lbl.textContent=player.name+(player.finished?' ✓':'');
  lbl.className='player-label'+(data.currentPlayer===player.uid?' active-turn':'');
  hnd.innerHTML='';
  const cnt=player.handCount??0;
  if(cnt>0){
    const st=document.createElement('div');
    st.className='card-stack';
    st.appendChild(createFaceDown());
    const b=document.createElement('div');
    b.className='card-count-badge';
    b.textContent=cnt;
    st.appendChild(b);
    hnd.appendChild(st);
  }
}

function renderGhost(pos,count){
  if(pos==='bottom') return;
  const lbl=document.getElementById(`label-${pos}`);
  const hnd=document.getElementById(`hand-${pos}`);
  // Only render if slot empty
  if(lbl.textContent) return;
  lbl.textContent='—';
  lbl.className='player-label ghost-label';
  hnd.innerHTML='';
  // Ghost seats: show face-down stack but NO active play (silent bots)
  if(count>0){
    const st=document.createElement('div');
    st.className='card-stack';
    st.appendChild(createFaceDown());
    const b=document.createElement('div');
    b.className='card-count-badge';
    b.style.background='#444';
    b.textContent=count;
    st.appendChild(b);
    hnd.appendChild(st);
  }
}

/* ── Self hand with drag-to-reorder ── */
function renderSelfHand(){
  const hnd=document.getElementById('hand-bottom');
  hnd.innerHTML='';
  State.myHand.forEach((card,idx)=>{
    const el=createCardEl(card);
    // tap to select
    el.addEventListener('click',()=>toggleSelect(card.id));
    // drag-to-reorder
    attachDrag(el,idx);
    hnd.appendChild(el);
  });
  if(State.myHand.length>0&&State.myHand.length<=13){
    // Fan-out overlap for large hands
    const overlap=Math.max(0,(State.myHand.length-7)*3);
    hnd.querySelectorAll('.card').forEach((c,i)=>{
      c.style.marginLeft=i===0?'0':`-${overlap}px`;
    });
  }
  renderComboPreview();
}

/* ── Drag & Drop reorder (touch + mouse) ── */
let dragSrcIdx=null;

function attachDrag(el,idx){
  // Mouse
  el.draggable=true;
  el.addEventListener('dragstart',e=>{
    dragSrcIdx=idx;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed='move';
  });
  el.addEventListener('dragend',()=>el.classList.remove('dragging'));
  el.addEventListener('dragover',e=>{e.preventDefault();el.classList.add('drag-over');});
  el.addEventListener('dragleave',()=>el.classList.remove('drag-over'));
  el.addEventListener('drop',e=>{
    e.preventDefault();
    el.classList.remove('drag-over');
    reorderHand(dragSrcIdx,idx);
  });

  // Touch (long-press to drag)
  let touchDragActive=false;
  let touchStartX,touchStartY,touchTimer;
  el.addEventListener('touchstart',e=>{
    touchStartX=e.touches[0].clientX;
    touchStartY=e.touches[0].clientY;
    touchTimer=setTimeout(()=>{
      touchDragActive=true;
      el.classList.add('dragging');
    },300);
  },{passive:true});
  el.addEventListener('touchmove',e=>{
    if(!touchDragActive){clearTimeout(touchTimer);return;}
    e.preventDefault();
    const t=e.touches[0];
    const target=document.elementFromPoint(t.clientX,t.clientY);
    document.querySelectorAll('.card.drag-over').forEach(c=>c.classList.remove('drag-over'));
    const targetCard=target?.closest('.card');
    if(targetCard&&targetCard!==el) targetCard.classList.add('drag-over');
  },{passive:false});
  el.addEventListener('touchend',e=>{
    clearTimeout(touchTimer);
    if(!touchDragActive){return;}
    touchDragActive=false;
    el.classList.remove('dragging');
    const t=e.changedTouches[0];
    const target=document.elementFromPoint(t.clientX,t.clientY);
    const targetCard=target?.closest('.card[data-idx]');
    document.querySelectorAll('.card.drag-over').forEach(c=>c.classList.remove('drag-over'));
    if(targetCard){
      const targetIdx=parseInt(targetCard.dataset.idx);
      reorderHand(idx,targetIdx);
    }
  });
  el.dataset.idx=idx;
}

function reorderHand(fromIdx,toIdx){
  if(fromIdx===toIdx||fromIdx==null||toIdx==null) return;
  const h=[...State.myHand];
  const [moved]=h.splice(fromIdx,1);
  h.splice(toIdx,0,moved);
  State.myHand=h;
  renderSelfHand();
}

function renderPot(combo){
  const pot=document.getElementById('pot-cards');
  const lbl=document.getElementById('combo-type-label');
  pot.innerHTML='';
  if(!combo||!combo.cards?.length){lbl.textContent='';return;}
  combo.cards.forEach(c=>pot.appendChild(createCardEl(c,false)));
  const names={single:'Single',triple:'Triple',straight:'Straight',four:'FOUR OF A KIND! 🎉'};
  lbl.textContent=names[combo.type]||'';
}

function renderComboPreview(){
  const prev=document.getElementById('combo-cards-preview');
  const lbl=document.querySelector('.combo-preview-label');
  prev.innerHTML='';
  const sel=State.myHand.filter(c=>State.selected.has(c.id));
  if(!sel.length){
    lbl.textContent='Ketuk kartu untuk pilih…';
    lbl.style.display='';
    enablePlay(false);
    return;
  }
  lbl.style.display='none';
  sel.forEach(c=>prev.appendChild(createCardEl(c,false)));
  enablePlay(!!detectCombo(sel));
}

function renderRanking(rankings){
  const list=document.getElementById('ranking-list');
  list.innerHTML='';
  rankings.forEach((r,i)=>{
    const cls=['p1','p2','p3','p4'][i]||'p4';
    const medals=['🥇','🥈','🥉','4'];
    const row=document.createElement('div');
    row.className='rank-row';
    row.innerHTML=`
      <div class="rank-pos ${cls}">${medals[i]||i+1}</div>
      <div class="rank-name">${esc(r.name)}</div>
      <div class="rank-note">${r.note||''}</div>`;
    list.appendChild(row);
  });
}

/* ================================================================
   10. CARD FACTORIES
   ================================================================ */
function createCardEl(card,clickable=true){
  const el=document.createElement('div');
  const red=['♥','♦'].includes(card.suit);
  el.className=`card ${red?'red':'black'}`;
  el.dataset.cardId=card.id;
  if(State.selected.has(card.id)) el.classList.add('selected');
  el.innerHTML=`
    <div class="card-rank">${card.rank}</div>
    <div class="card-suit">${card.suit}</div>
    <div class="card-rank-bottom">${card.rank}</div>`;
  if(!clickable) el.style.cursor='default';
  return el;
}
function createFaceDown(){
  const el=document.createElement('div');
  el.className='card face-down';
  return el;
}

/* ================================================================
   11. CARD SELECTION & PLAY
   ================================================================ */
function toggleSelect(cardId){
  // Allow selection regardless of turn for visual comfort; play button enforces turn
  if(State.selected.has(cardId)) State.selected.delete(cardId);
  else State.selected.add(cardId);
  renderSelfHand();
}

function cancelCombo(){
  State.selected.clear();
  renderSelfHand();
}

async function playCards(){
  const sel=State.myHand.filter(c=>State.selected.has(c.id));
  if(!sel.length) return;
  const attempt=detectCombo(sel);
  if(!attempt){showToast('Kombinasi tidak valid!','error');return;}
  const current=State.roomData?.currentCombo;
  if(!canBeat(current,attempt)){showToast('Tidak cukup tinggi!','error');return;}

  // Disable buttons immediately (optimistic)
  document.getElementById('btn-play').disabled=true;
  document.getElementById('btn-pass').disabled=true;

  const newHand=State.myHand.filter(c=>!State.selected.has(c.id));
  const isFour=attempt.type===ComboType.FOUR;
  const done=newHand.length===0;

  const roomRef=db.collection('rooms').doc(State.roomId);
  const batch=db.batch();
  batch.set(roomRef.collection('hands').doc(State.myUid),{cards:newHand});

  const me=State.roomData.players[State.myUid];
  let active=[...(State.roomData.activePlayers||[])];
  let rankings=[...(State.roomData.rankings||[])];
  let next=nextPlayer(State.myUid,active,State.roomData.playerOrder);
  let newStatus='playing';
  let note='';

  const comboWithOwner={...attempt,playedBy:State.myUid};

  if(isFour){
    rankings.unshift({uid:State.myUid,name:me.name,note:'Four of a Kind! 🎉'});
    active=active.filter(u=>u!==State.myUid);
    next=nextPlayer(State.myUid,active,State.roomData.playerOrder);
    note=`${me.name} menang FOUR OF A KIND!`;
    batch.update(roomRef,{[`players.${State.myUid}.finished`]:true,[`players.${State.myUid}.rank`]:1});
  } else if(done){
    rankings.push({uid:State.myUid,name:me.name,note:`Selesai ke-${rankings.length+1}`});
    active=active.filter(u=>u!==State.myUid);
    next=nextPlayer(State.myUid,active,State.roomData.playerOrder);
    note=`${me.name} menghabiskan kartu!`;
    batch.update(roomRef,{[`players.${State.myUid}.finished`]:true});
  } else {
    note=`${me.name}: ${attempt.type} (${sel.map(c=>c.rank+c.suit).join(' ')})`;
  }

  if(active.length<=1){
    if(active.length===1){
      const lu=active[0];
      rankings.push({uid:lu,name:State.roomData.players[lu]?.name||'Pemain',note:'Jenderal Terakhir 😈'});
      batch.update(roomRef,{[`players.${lu}.finished`]:true});
    }
    newStatus='ended';
  }

  batch.update(roomRef,{
    currentCombo:comboWithOwner,currentPlayer:next,
    passCount:0,activePlayers:active,rankings,status:newStatus,
    lastAction:note,lastActionPlayer:State.myUid,
    [`players.${State.myUid}.handCount`]:newHand.length,
    lastUpdated:firebase.firestore.FieldValue.serverTimestamp(),
  });
  await batch.commit();
  State.myHand=newHand; // keep local reorder
  State.selected.clear();
}

async function passPlay(){
  const data=State.roomData;
  const active=data.activePlayers||[];
  const me=data.players[State.myUid];
  const newPass=(data.passCount||0)+1;
  const next=nextPlayer(State.myUid,active,data.playerOrder);

  // If all others passed → new round
  if(newPass>=active.length-1){
    const lastPlayer=data.currentCombo?.playedBy||State.myUid;
    await db.collection('rooms').doc(State.roomId).update({
      currentCombo:null,passCount:0,currentPlayer:lastPlayer,
      lastAction:`${me.name} pass — Putaran baru!`,lastActionPlayer:State.myUid,
      lastUpdated:firebase.firestore.FieldValue.serverTimestamp(),
    });
    return;
  }
  await db.collection('rooms').doc(State.roomId).update({
    currentPlayer:next,passCount:newPass,
    lastAction:`${me.name} pass`,lastActionPlayer:State.myUid,
    lastUpdated:firebase.firestore.FieldValue.serverTimestamp(),
  });
}

function nextPlayer(curUid,active,order){
  if(!active||!active.length) return null;
  const ord=(order||[]).filter(u=>active.includes(u));
  const idx=ord.indexOf(curUid);
  return ord[(idx+1)%ord.length]||ord[0];
}

/* ================================================================
   12. TURN UI
   ================================================================ */
function setTurnUI(isMyTurn){
  document.getElementById('turn-indicator').classList.toggle('hidden',!isMyTurn);
  document.getElementById('btn-pass').disabled=!isMyTurn;
  document.getElementById('btn-cancel').disabled=!isMyTurn;
  if(!isMyTurn){
    State.selected.clear();
    renderSelfHand();
    enablePlay(false);
  }
}
function enablePlay(v){
  const isMyTurn=!document.getElementById('btn-pass').disabled;
  document.getElementById('btn-play').disabled=!v||!isMyTurn;
}

/* ================================================================
   13. LOG
   ================================================================ */
function addLog(msg,uid){
  const log=document.getElementById('game-log');
  const el=document.createElement('div');
  el.className='log-entry'+(uid===State.myUid?' highlight':'');
  el.textContent=msg;
  log.prepend(el);
  while(log.children.length>30) log.removeChild(log.lastChild);
}

/* ================================================================
   14. HELPERS
   ================================================================ */
function showScreen(name){
  document.querySelectorAll('.screen').forEach(s=>{
    s.classList.toggle('active',s.id===`screen-${name}`);
  });
}

let toastTimer;
function showToast(msg,type=''){
  const el=document.getElementById('toast');
  el.textContent=msg; el.className=`toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.classList.add('hidden'),3000);
}
function showError(msg){
  const el=document.getElementById('lobby-error');
  el.textContent=msg; el.classList.remove('hidden');
}
function getPlayerName(){
  const n=document.getElementById('input-name').value.trim();
  if(!n){showError('Masukkan nama pemain terlebih dahulu.');return null;}
  return n;
}
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

/* ================================================================
   15. EVENT LISTENERS
   ================================================================ */
document.addEventListener('DOMContentLoaded',()=>{
  initFirebase();

  // Lobby
  document.getElementById('btn-create').addEventListener('click',createRoom);
  document.getElementById('btn-join-toggle').addEventListener('click',()=>{
    document.getElementById('join-section').classList.toggle('hidden');
  });
  document.getElementById('btn-join-confirm').addEventListener('click',joinRoom);
  document.getElementById('input-room-code').addEventListener('keydown',e=>{
    if(e.key==='Enter') joinRoom();
  });

  // Waiting room
  document.getElementById('btn-ready').addEventListener('click',toggleReady);
  document.getElementById('btn-start-host').addEventListener('click',hostForceStart);
  document.getElementById('btn-leave').addEventListener('click',leaveRoom);
  document.getElementById('btn-copy-code').addEventListener('click',()=>{
    const code=document.getElementById('display-room-code').textContent;
    navigator.clipboard?.writeText(code).then(()=>showToast('Kode disalin!','success'));
  });

  // Game
  document.getElementById('btn-play').addEventListener('click',playCards);
  document.getElementById('btn-pass').addEventListener('click',passPlay);
  document.getElementById('btn-cancel').addEventListener('click',cancelCombo);

  // Ranking
  document.getElementById('btn-back-lobby').addEventListener('click',()=>{
    if(State.unsubRoom) State.unsubRoom();
    State.roomId=null; State.myHand=[]; State.selected.clear();
    showScreen('lobby');
  });

  // Hide error on input
  ['input-name','input-room-code'].forEach(id=>{
    document.getElementById(id)?.addEventListener('input',()=>{
      document.getElementById('lobby-error')?.classList.add('hidden');
    });
  });
});
