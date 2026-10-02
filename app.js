"use strict";

(function(){
const SERVER_URL="https://cardgame-server-erng.onrender.com";
const AUTH_API="https://mrmvmoyysxuopqexbxfk.supabase.co/functions/v1/rolplay-api";
const PHASES=["Enderezar","Robar","Poder","Invocar","Habilidades","Ataque"];
const SESSION_KEY="rolplay.session.v1";
const PROFILE_CACHE_KEY="rolplay.profile.cache.v2";
const LAST_USER_KEY="rolplay.last.username";
const PENDING_REWARDS_KEY="rolplay.pending.rewards.v1";
let sessionToken=localStorage.getItem(SESSION_KEY)||"";
const RARITIES=[
  {name:"Común",key:"common",min:0},
  {name:"Rara",key:"rare",min:26},
  {name:"Épica",key:"epic",min:61},
  {name:"Legendaria",key:"legendary",min:91}
];
const $=id=>document.getElementById(id);
const state={
  catalog:[],byId:new Map(),imageMap:{},profile:null,view:"home",
  socket:null,connected:false,connecting:false,users:[],matches:[],chat:[],
  collectionQuery:"",collectionMode:"owned",collectionType:"all",deckTarget:30,
  duel:null,trade:freshTrade(),lastPack:[],sound:localStorage.getItem("rolplay.sound")!=="off",
  authMode:"login",authBusy:false,offlineSession:false
};

function freshTrade(){return{mine:[],theirs:[],theirGold:0,ownGold:0,onlineId:null,partnerId:"",partnerName:"",ready:false,accepted:false}}
function esc(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]))}
function norm(s){return String(s??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase()}
function uid(){return crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2)+Date.now().toString(36)}
function shuffle(a){a=a.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function clamp(n,a,b){return Math.min(b,Math.max(a,n))}
function initial(s){return (String(s||"?").trim()[0]||"?").toUpperCase()}
function rarity(c){let r=RARITIES[0];for(const x of RARITIES)if(c.rarity>=x.min)r=x;return r}
function cardType(c){return c.powerCard?"Poder":c.abilityCard?"Habilidad":"Criatura"}
function cardValue(c){return Math.max(1,Math.round(c.level/2)+Math.round(c.rarity/20))}
function powerValue(c){const m=c&&c.name.match(/^Poder\s+x\s+(\d+)/i);return m?Math.max(1,Number(m[1])||1):1}
function powerTotal(list){return(list||[]).reduce((n,c)=>n+powerValue(c),0)}
function owned(id){return Number(state.profile?.collection?.[id]||0)}
function deckCount(id){return state.profile?.deck?.filter(x=>Number(x)===Number(id)).length||0}
function isBasicPower(c){return !!(c&&c.powerCard&&c.level===1)}
function freeCopies(id){const c=card(id);return isBasicPower(c)?Infinity:Math.max(0,owned(id)-deckCount(id))}
function card(id){return state.byId.get(Number(id))}
function isPowerName(n){return /^Poder(?:\s+x\s+\d+|\s*$)/i.test(n)}
function isAbilityName(n){return /^(Veneno|Fuente de vida|Drenador|Escudal|Barrera Mistica|Poder Mental|Poderador|Rueda)/i.test(n)}

function imageKey(s){
  return norm(s).replace(/\bx\s+(\d+)/g,"$1").replace(/\b(del|de|la|el)\b/g," ").replace(/[^a-z0-9]+/g,"");
}
function cardImage(c){
  if(!c)return"legacy-assets/imagenes/crt_back.jpg";
  const k=imageKey(c.name);
  if(k==="arpada")return"legacy-assets/imagenes/crt_arpia_g.jpg";
  if(k==="dragonoscuro")return"legacy-assets/imagenes/crt_dragon_sombra_g.jpg";
  return state.imageMap[k]||"legacy-assets/imagenes/crt_back.jpg";
}
function parseCards(text){
  state.catalog=text.trim().split(/\r?\n/).slice(1).filter(Boolean).map((line,i)=>{
    const p=line.split(";"),name=p[0],rar=Number(p[1])||1,quantity=Number(p[2])||1,level=Number(p[3])||1;
    const powerCard=isPowerName(name),abilityCard=isAbilityName(name);
    return{id:i+1,name,rarity:rar,quantity,level,powerCard,abilityCard,
      cost:powerCard?0:Math.max(1,Math.min(10,Math.ceil(level/5))),
      atk:(powerCard||abilityCard)?0:Math.max(1,Math.ceil(level*.52)+Math.floor(rar/30)),
      def:(powerCard||abilityCard)?0:Math.max(1,Math.ceil(level*.40)+Math.floor((101-rar)/40))
    };
  });
  state.byId=new Map(state.catalog.map(c=>[c.id,c]));
}
function applyImageIndex(j){
  for(const file of j.files||[]){
    let stem=file.replace(/\.(jpg|gif)$/i,""),isG=/_g$/i.test(stem);
    stem=stem.replace(/^crt_/i,"").replace(/_(g|h)$/i,"");
    const k=imageKey(stem.replace(/_/g," "));
    if(!state.imageMap[k]||isG)state.imageMap[k]="legacy-assets/imagenes/"+file;
  }
}

function cacheProfile(){
  if(!state.profile)return;
  try{localStorage.setItem(PROFILE_CACHE_KEY,JSON.stringify(state.profile))}catch{}
}
function cachedProfile(){
  try{return JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY)||"null")}catch{return null}
}
function applyProfile(profile){
  if(!profile)return;
  state.profile={
    ...profile,
    level:clamp(Number(profile.level)||1,1,50),
    xp:Math.max(0,Number(profile.xp)||0),
    xpRequired:Math.max(0,Number(profile.xpRequired)||0),
    totalXp:Math.max(0,Number(profile.totalXp)||0),
    coins:Math.max(0,Number(profile.coins)||0),
    wins:Math.max(0,Number(profile.wins)||0),
    losses:Math.max(0,Number(profile.losses)||0),
    collection:profile.collection&&typeof profile.collection==="object"?profile.collection:{},
    deck:Array.isArray(profile.deck)?profile.deck.map(Number):[],
    packs:Math.max(0,Number(profile.packs)||0)
  };
  localStorage.setItem(LAST_USER_KEY,state.profile.name||"");
  cacheProfile();
}
function authErrorMessage(code){
  const map={
    username_invalid:"El usuario debe tener entre 3 y 20 caracteres y usar letras, números, _ o -.",
    password_invalid:"La contraseña debe tener al menos 8 caracteres.",
    username_taken:"Ese nombre de usuario ya está registrado.",
    invalid_credentials:"Usuario o contraseña incorrectos.",
    unauthorized:"La sesión ha caducado. Vuelve a iniciar sesión.",
    not_enough_gold:"No tienes oro suficiente.",
    no_cards_for_level:"No hay cartas disponibles para tu nivel.",
    card_above_player_level:"Tu nivel todavía no permite usar una de esas cartas.",
    not_enough_copies:"No posees suficientes copias para ese mazo.",
    no_free_copy:"Esa copia está siendo usada por el mazo.",
    basic_power_is_infinite:"Los Poderes básicos son infinitos y no se venden.",
    network_error:"No se pudo contactar con el servidor de cuentas."
  };
  return map[code]||"No se pudo completar la operación.";
}
async function api(action,payload={},auth=true){
  const headers={"content-type":"application/json"};
  if(auth&&sessionToken)headers["x-rolplay-session"]=sessionToken;
  try{
    const res=await fetch(AUTH_API,{method:"POST",headers,body:JSON.stringify({action,...payload})});
    let data={};try{data=await res.json()}catch{}
    if(!res.ok||!data.ok)return{ok:false,error:data.error||"server_error",status:res.status};
    return data;
  }catch(e){
    return{ok:false,error:"network_error",network:true};
  }
}
function setAuthMode(mode){
  state.authMode=mode==="register"?"register":"login";
  document.querySelectorAll("[data-auth-mode]").forEach(b=>b.classList.toggle("active",b.dataset.authMode===state.authMode));
  const title=$("authTitle"),desc=$("authDesc"),submit=$("authSubmit"),confirm=$("confirmField");
  if(title)title.textContent=state.authMode==="register"?"Crear cuenta":"Entrar al salón";
  if(desc)desc.textContent=state.authMode==="register"
    ?"Empiezas en nivel 1, sin cartas coleccionables, con Poder básico infinito y 100 de oro para abrir tus primeros sobres."
    :"Entra con tu usuario y contraseña para recuperar tu progreso.";
  if(submit)submit.textContent=state.authMode==="register"?"Crear usuario":"Iniciar sesión";
  if(confirm)confirm.classList.toggle("hidden",state.authMode!=="register");
}
function showAuth(){
  $("appShell")?.classList.add("hidden");$("loginScreen")?.classList.remove("hidden");
  $("bootLoader")?.classList.add("hidden");$("loginForm")?.classList.remove("hidden");
  const last=localStorage.getItem(LAST_USER_KEY)||"";
  if($("loginName")&&!$("loginName").value)$("loginName").value=last;
  setAuthMode(state.authMode);
}
async function authenticateForm(){
  if(state.authBusy)return;
  const username=String($("loginName")?.value||"").trim();
  const password=String($("loginPassword")?.value||"");
  const confirm=String($("loginConfirm")?.value||"");
  if(state.authMode==="register"&&password!==confirm){toast("Las contraseñas no coinciden.","bad");return}
  state.authBusy=true;if($("authSubmit"))$("authSubmit").disabled=true;
  const result=await api(state.authMode==="register"?"register":"login",{username,password},false);
  state.authBusy=false;if($("authSubmit"))$("authSubmit").disabled=false;
  if(!result.ok){toast(authErrorMessage(result.error),"bad");return}
  sessionToken=result.token||"";localStorage.setItem(SESSION_KEY,sessionToken);
  applyProfile(result.profile);enterGame();
}
function enterGame(){
  if(!state.profile)return;
  $("loginScreen")?.classList.add("hidden");$("appShell")?.classList.remove("hidden");
  updateChrome();connectOnline();go("home");void syncPendingRewards();
}
async function logout(){
  if(sessionToken)void api("logout",{},true);
  if(state.socket){state.socket.disconnect();state.socket=null}
  state.connected=false;state.duel=null;state.trade=freshTrade();state.profile=null;
  sessionToken="";localStorage.removeItem(SESSION_KEY);localStorage.removeItem(PROFILE_CACHE_KEY);
  showAuth();
}
function saveProfile(){
  cacheProfile();updateChrome();
}
function queueReward(payload){
  try{
    const q=JSON.parse(localStorage.getItem(PENDING_REWARDS_KEY)||"[]");
    if(!q.some(x=>x.rewardKey===payload.rewardKey))q.push(payload);
    localStorage.setItem(PENDING_REWARDS_KEY,JSON.stringify(q.slice(-30)));
  }catch{}
}
async function syncPendingRewards(){
  if(!sessionToken)return;
  let q=[];try{q=JSON.parse(localStorage.getItem(PENDING_REWARDS_KEY)||"[]")}catch{}
  if(!Array.isArray(q)||!q.length)return;
  const remaining=[];
  for(const reward of q){
    const r=await api("award_result",reward,true);
    if(r.ok&&r.profile)applyProfile(r.profile);else remaining.push(reward);
  }
  localStorage.setItem(PENDING_REWARDS_KEY,JSON.stringify(remaining));
  updateChrome();if(state.view==="profile"||state.view==="home")renderView();
}

function playSound(name){
  if(!state.sound)return;
  const files={click:"sonidos/click.WAV",turn:"sonidos/turn.wav",draw:"sonidos/n_cartas.wav",summon:"sonidos/invocar.WAV",power:"sonidos/poder.WAV",hit:"sonidos/lucha1.WAV",win:"sonidos/n_lvl.WAV"};
  const src=files[name];if(!src)return;
  try{const a=new Audio(src);a.volume=.28;a.play().catch(()=>{})}catch{}
}
function toast(message,type=""){
  const stack=$("toasts");if(!stack)return;
  const el=document.createElement("div");el.className="toast "+type;el.textContent=message;stack.appendChild(el);
  setTimeout(()=>el.remove(),3400);
}

async function boot(){
  try{
    const [cardsText,imageIndex]=await Promise.all([
      fetch("cards.csv").then(r=>{if(!r.ok)throw Error("cards");return r.text()}),
      fetch("legacy-assets/image-index.json").then(r=>r.json())
    ]);
    parseCards(cardsText);applyImageIndex(imageIndex);
  }catch(e){
    console.error(e);$("bootError")?.classList.remove("hidden");return;
  }
  if("serviceWorker"in navigator)navigator.serviceWorker.register("sw.js").catch(()=>{});
  if(sessionToken){
    const result=await api("me",{},true);
    if(result.ok&&result.profile){applyProfile(result.profile);enterGame();return}
    if(result.network){
      const cached=cachedProfile();
      if(cached){state.offlineSession=true;applyProfile(cached);enterGame();toast("Sin conexión: progreso cargado en modo offline.","bad");return}
    }
    sessionToken="";localStorage.removeItem(SESSION_KEY);
  }
  showAuth();
}

function updateChrome(){
  if(!state.profile)return;
  $("playerName").textContent=state.profile.name;$("playerAvatar").textContent=initial(state.profile.name);
  $("playerMeta").textContent="Nv "+playerLevel()+" · "+state.profile.xp+"/"+(state.profile.xpRequired||"MAX")+" XP";
  $("coins").textContent=state.profile.coins;
  const fill=$("playerXpFill");if(fill)fill.style.width=xpPercent()+"%";
  $("connectionDot").className="dot "+(state.connected?"online":"");
  $("connectionText").textContent=state.connected?"Online":state.offlineSession?"Offline":"Conectando";
  $("onlineBadge").textContent=state.users.length||0;
  document.querySelectorAll("[data-nav]").forEach(b=>b.classList.toggle("active",b.dataset.nav===state.view));
}
function playerLevel(){return clamp(Number(state.profile?.level)||1,1,50)}
function xpPercent(){if(!state.profile||playerLevel()>=50)return 100;return clamp(Math.round((state.profile.xp/Math.max(1,state.profile.xpRequired))*100),0,100)}
function winrate(){
  const total=(state.profile?.wins||0)+(state.profile?.losses||0);
  return total?Math.round(state.profile.wins/total*100):0;
}
function deckValid(size=20){
  if(!state.profile||state.profile.deck.length<size)return false;
  const count={};
  for(const id of state.profile.deck){
    const c=card(id);if(!c||c.level>playerLevel())return false;
    if(isBasicPower(c))continue;
    count[id]=(count[id]||0)+1;
  }
  return Object.keys(count).every(id=>count[id]<=owned(id));
}
function collectionTotal(){return Object.values(state.profile?.collection||{}).reduce((a,b)=>a+Number(b||0),0)}
function uniqueOwned(){return Object.keys(state.profile?.collection||{}).filter(id=>owned(id)>0).length}

function go(view){
  if(view==="duel"&&!state.duel)return;
  closeModal();
  state.view=view;updateChrome();renderView();
  window.scrollTo({top:0,behavior:"smooth"});
}
function renderView(){
  const root=$("viewRoot");if(!root||!state.profile)return;
  const renderers={home:renderHome,play:renderPlay,collection:renderCollection,deck:renderDeck,shop:renderShop,trade:renderTrade,profile:renderProfile,archive:renderArchive,duel:renderDuel};
  root.innerHTML=(renderers[state.view]||renderHome)();
}

function pageHead(kicker,title,desc,actions=""){
  return `<div class="page-head"><div><div class="kicker">${kicker}</div><h1>${title}</h1><p>${desc}</p></div><div class="actions">${actions}</div></div>`;
}
function renderHome(){
  const deckReady=deckValid(20),matches=state.matches.filter(m=>m.status==="waiting").length;
  return `<div class="page">
    <section class="panel hero">
      <div class="hero-copy">
        <div class="kicker">Rolplay · Reborn</div>
        <h1>La leyenda vuelve<br>con otra armadura.</h1>
        <p>285 cartas originales, colección persistente, mazos, economía, chat, intercambios y duelos online sobre un cliente completamente renovado.</p>
        <div class="actions" style="margin-top:15px">
          <button class="btn primary" data-action="nav" data-view="play">Buscar partida</button>
          <button class="btn" data-action="training">Entrenamiento</button>
        </div>
      </div><div class="hero-visual"></div>
    </section>
    <div class="grid four" style="margin-top:14px">
      <div class="stat-card"><small>Jugadores conectados</small><strong>${state.users.length}</strong><span class="muted">salón en tiempo real</span></div>
      <div class="stat-card"><small>Partidas abiertas</small><strong>${matches}</strong><span class="muted">retos esperando rival</span></div>
      <div class="stat-card"><small>Colección</small><strong>${uniqueOwned()}<span class="muted" style="font-size:14px"> / 285</span></strong><span class="muted">${collectionTotal()} cartas totales</span></div>
      <div class="stat-card"><small>Mazo activo</small><strong>${state.profile.deck.length}</strong><span class="${deckReady?"good":"bad"}">${deckReady?"listo para jugar":"mínimo 20 cartas"}</span></div>
    </div>
    <div class="grid two" style="margin-top:14px">
      <section class="panel">
        <div class="panel-head"><h2>Salón online</h2><span class="pill"><span class="dot ${state.connected?"online":""}"></span>${state.connected?"Conectado":"Modo local"}</span></div>
        <div class="panel-body"><div class="online-list">${renderUsers()}</div></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Chat general</h2><span class="muted">${state.chat.length} mensajes</span></div>
        <div class="chat"><div class="chat-log" id="chatLog">${renderChat()}</div>
          <form class="chat-send" id="chatForm"><input class="input" id="chatInput" maxlength="300" placeholder="Escribe en el salón…" autocomplete="off"><button class="btn primary">Enviar</button></form>
        </div>
      </section>
    </div>
  </div>`;
}
function renderUsers(){
  if(!state.users.length)return'<div class="empty">No hay otros jugadores conectados todavía.</div>';
  return state.users.map(u=>`<div class="online-user"><div class="avatar">${initial(u.name)}</div><div style="min-width:0"><b>${esc(u.name)}</b><div class="muted" style="font-size:11px">Nivel ${u.level||1} · ${esc(u.status||"Disponible")}</div></div>${state.socket&&u.socketId===state.socket.id?'<span class="pill">Tú</span>':""}</div>`).join("");
}
function renderChat(){
  if(!state.chat.length)return'<div class="empty">El salón está tranquilo. Rompe el hielo.</div>';
  return state.chat.slice(-80).map(m=>m.system?`<div class="chat-msg system">${esc(m.text)}</div>`:`<div class="chat-msg"><b>${esc(m.from)}:</b> ${esc(m.text)}</div>`).join("");
}

function renderPlay(){
  const waiting=state.matches.filter(m=>m.status==="waiting");
  return `<div class="page">
    ${pageHead("Competición","Jugar","Crea un reto, entra en una partida existente o entrena contra la IA.",
      '<button class="btn" data-action="training">Entrenamiento</button>')}
    <div class="grid two">
      <section class="panel">
        <div class="panel-head"><h2>Crear partida</h2><span class="pill">${state.profile.deck.length} cartas en tu mazo</span></div>
        <div class="panel-body">
          <div class="grid two">
            <div class="field"><label>Tamaño de baraja</label><select class="select" id="matchSize"><option>20</option><option selected>30</option><option>40</option><option>50</option></select></div>
            <div class="field"><label>Quién empieza</label><select class="select" id="matchStart"><option value="normal">Creador</option><option value="random">Aleatorio</option></select></div>
          </div>
          <div class="actions" style="margin-top:14px"><button class="btn primary" data-action="createMatch" ${state.connected?"":"disabled"}>Crear reto online</button><span class="muted">${state.connected?"Visible para todos los jugadores conectados.":"Conecta con el servidor para crear retos."}</span></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Entrenamiento</h2><span class="pill">IA local</span></div>
        <div class="panel-body"><p class="muted">Prueba tu mazo sin esperar rival. Usa las mismas seis fases, poder, invocaciones y combate.</p><button class="btn" data-action="training">Iniciar entrenamiento</button></div>
      </section>
    </div>
    <section class="panel" style="margin-top:14px">
      <div class="panel-head"><h2>Retos disponibles</h2><span class="pill">${waiting.length} abiertos</span></div>
      <div class="panel-body"><div class="match-list">${renderMatches(waiting)}</div></div>
    </section>
  </div>`;
}
function renderMatches(list){
  if(!list.length)return'<div class="empty">No hay retos abiertos. Puedes crear el primero.</div>';
  return list.map(m=>{
    const mine=state.socket&&m.hostSocketId===state.socket.id;
    return `<div class="match-row"><div class="match-player"><div class="avatar">${initial(m.player)}</div><div>${esc(m.player)}<div class="muted" style="font-size:11px">Nivel ${m.level||1}</div></div></div><b>${m.deckSize}</b><span class="pill">${m.start==="random"?"Aleatorio":"Normal"}</span><span class="good">Esperando</span>${mine?'<button class="btn small danger" data-action="cancelMatch" data-id="'+m.id+'">Cancelar</button>':'<button class="btn small primary" data-action="joinMatch" data-id="'+m.id+'" data-size="'+m.deckSize+'">Unirse</button>'}</div>`;
  }).join("");
}

function collectionCards(){
  const q=norm(state.collectionQuery),mode=state.collectionMode,type=state.collectionType;
  return state.catalog.filter(c=>{
    if(mode==="owned"&&owned(c.id)<=0&&!isBasicPower(c))return false;
    if(type!=="all"&&cardType(c)!==type)return false;
    if(q&&!norm(c.name).includes(q))return false;
    return true;
  });
}
function renderCollection(){
  const list=collectionCards();
  return `<div class="page">
    ${pageHead("Biblioteca","Colección","Explora las 285 cartas recuperadas. Vende duplicados, inspecciona detalles o llévalas al constructor de mazos.")}
    <div class="toolbar"><input class="input" id="collectionSearch" value="${esc(state.collectionQuery)}" placeholder="Buscar carta…"><select class="select" id="collectionMode"><option value="owned" ${state.collectionMode==="owned"?"selected":""}>Mi colección</option><option value="all" ${state.collectionMode==="all"?"selected":""}>Catálogo completo</option></select><select class="select" id="collectionType"><option value="all">Todos los tipos</option><option ${state.collectionType==="Criatura"?"selected":""}>Criatura</option><option ${state.collectionType==="Poder"?"selected":""}>Poder</option><option ${state.collectionType==="Habilidad"?"selected":""}>Habilidad</option></select><span class="toolbar-spacer"></span><span class="muted">${list.length} resultados</span></div>
    <div class="card-grid">${list.map(c=>cardTile(c,{qty:owned(c.id),collection:true})).join("")||'<div class="empty">No hay cartas que coincidan.</div>'}</div>
  </div>`;
}
function cardTile(c,opt={}){
  const r=rarity(c),basic=isBasicPower(c),qty=basic?Infinity:(opt.qty||0),locked=c.level>playerLevel();
  const qtyLabel=qty===Infinity?"∞":qty;
  const canAdd=!locked&&(basic||freeCopies(c.id)>0);
  const canSell=!basic&&freeCopies(c.id)>0;
  return `<article class="game-card r-${r.key}" data-action="cardDetail" data-id="${c.id}">
    <div class="card-art" style="background-image:url('${cardImage(c)}')"><span class="card-cost">${c.cost}</span>${qty?'<span class="card-qty '+(basic?'infinity-badge':'')+'">'+(basic?'∞ básico':'x'+qtyLabel)+'</span>':""}${locked?'<div class="level-lock">Requiere<br>Nivel '+c.level+'</div>':""}</div>
    <div class="card-info"><div class="card-name">${esc(c.name)}</div><div class="card-sub">${cardType(c)} · Nv ${c.level} · ${r.name}${basic?" · Infinito":""}</div></div>
    <div class="card-stats"><span>${c.powerCard?"Poder +"+powerValue(c):"ATQ "+c.atk}</span><span>${c.powerCard?"":"DEF "+c.def}</span></div>
    ${opt.collection?'<div class="card-actions"><button class="btn small" data-action="addDeck" data-id="'+c.id+'" '+(canAdd?"":"disabled")+'>Al mazo</button><button class="btn small ghost" data-action="sellCard" data-id="'+c.id+'" '+(canSell?"":"disabled")+'>'+(basic?'No vendible':'Vender +'+Math.max(1,Math.floor(cardValue(c)/2)))+'</button></div>':""}
  </article>`;
}

function renderDeck(){
  const target=state.deckTarget,count=state.profile.deck.length,avg=count?state.profile.deck.reduce((n,id)=>n+(card(id)?.cost||0),0)/count:0;
  const pool=state.catalog.filter(c=>c.level<=playerLevel()&&(isBasicPower(c)||freeCopies(c.id)>0));
  return `<div class="page">
    ${pageHead("Estrategia","Constructor de mazos","Los Poderes de nivel 1 son un recurso básico infinito. El resto de cartas debe estar en tu colección y no puede superar tu nivel.",
      '<button class="btn" data-action="autoDeck">Auto construir</button><button class="btn danger" data-action="clearDeck">Vaciar</button>')}
    <div class="deck-layout">
      <section class="panel">
        <div class="panel-head"><h2>Mazo activo</h2><span class="pill ${count>=20?"good":"bad"}">${count} cartas</span></div>
        <div class="panel-body">
          <div class="grid two"><div class="stat-card"><small>Coste medio</small><strong>${avg.toFixed(1)}</strong></div><div class="stat-card"><small>Poderes</small><strong>${state.profile.deck.filter(id=>card(id)?.powerCard).length}</strong></div></div>
          <div class="field" style="margin:14px 0"><label>Objetivo para autoconstrucción</label><select class="select" id="deckTarget"><option ${target===20?"selected":""}>20</option><option ${target===30?"selected":""}>30</option><option ${target===40?"selected":""}>40</option><option ${target===50?"selected":""}>50</option></select></div>
          <div class="deck-meter"><span style="width:${Math.min(100,count/50*100)}%"></span></div>
          <p class="muted" style="font-size:11px">Poder básico Nv 1: ∞ · Cartas utilizables: nivel ${playerLevel()} o inferior.</p>
          <div class="deck-list" style="margin-top:12px">${renderDeckRows()}</div>
        </div>
      </section>
      <section class="panel"><div class="panel-head"><h2>Cartas disponibles</h2><span class="muted">${pool.length} opciones utilizables</span></div><div class="panel-body"><div class="card-grid">${pool.map(c=>cardTile(c,{qty:isBasicPower(c)?Infinity:freeCopies(c.id),collection:true})).join("")||'<div class="empty">Abre sobres en la tienda para conseguir cartas.</div>'}</div></div></section>
    </div>
  </div>`;
}
function renderDeckRows(){
  if(!state.profile.deck.length)return'<div class="empty">Tu mazo está vacío. Añade Poder básico infinito y cartas obtenidas en sobres.</div>';
  return state.profile.deck.map((id,i)=>{const c=card(id);return c?`<div class="deck-row"><img src="${cardImage(c)}"><div><b>${esc(c.name)}</b><small>${cardType(c)} · Nv ${c.level}${isBasicPower(c)?" · ∞":""}</small></div><span class="pill">${c.cost}</span><button class="btn small danger" data-action="removeDeck" data-index="${i}">−</button></div>`:""}).join("");
}
async function persistDeck(candidate,successMessage=""){
  if(!sessionToken){toast("Necesitas una sesión activa para guardar el mazo.","bad");return false}
  const r=await api("save_deck",{deck:candidate},true);
  if(!r.ok){toast(authErrorMessage(r.error),"bad");return false}
  applyProfile(r.profile);if(successMessage)toast(successMessage,"good");renderView();return true;
}
async function autoDeck(){
  const target=state.deckTarget;
  const basics=state.catalog.filter(c=>isBasicPower(c)&&c.level<=playerLevel());
  const available=[];
  for(const [id,q] of Object.entries(state.profile.collection)){
    const c=card(id);if(!c||c.level>playerLevel())continue;
    for(let i=0;i<Number(q||0);i++)available.push(Number(id));
  }
  const nonBasicPowers=available.filter(id=>card(id)?.powerCard&&!isBasicPower(card(id)));
  const others=available.filter(id=>!card(id)?.powerCard);
  nonBasicPowers.sort((a,b)=>(card(a)?.level||0)-(card(b)?.level||0));
  others.sort((a,b)=>(card(a)?.level||0)-(card(b)?.level||0));
  const deck=[],wantedPower=Math.ceil(target*.30);
  for(const id of nonBasicPowers){if(deck.length>=wantedPower)break;deck.push(id)}
  let bi=0;while(deck.length<wantedPower&&basics.length){deck.push(basics[bi++%basics.length].id)}
  for(const id of others){if(deck.length>=target)break;deck.push(id)}
  for(const id of nonBasicPowers.slice(deck.filter(id=>card(id)?.powerCard&&!isBasicPower(card(id))).length)){if(deck.length>=target)break;deck.push(id)}
  bi=0;while(deck.length<target&&basics.length){deck.push(basics[bi++%basics.length].id)}
  if(deck.length<20){toast("No hay suficientes cartas disponibles para construir un mazo.","bad");return}
  await persistDeck(deck.slice(0,50),"Mazo construido y guardado.");
}
async function addDeck(id){
  const c=card(id);if(!c||c.level>playerLevel())return;
  if(state.profile.deck.length>=50){toast("El límite es 50 cartas.","bad");return}
  if(!isBasicPower(c)&&freeCopies(id)<=0)return;
  await persistDeck([...state.profile.deck,Number(id)]);
}
async function removeDeck(index){
  const next=state.profile.deck.slice();next.splice(Number(index),1);await persistDeck(next);
}
async function clearDeck(){await persistDeck([],"Mazo vaciado.")}

function renderShop(){
  return `<div class="page">
    ${pageHead("Mercado","Tienda","Los sobres se generan en el servidor y jamás contienen una carta por encima de tu nivel actual.")}
    <div class="grid two">
      <section class="panel pack-hero"><div><div class="pack-card">R</div><h2>Sobre de la Orda</h2><p class="muted">5 cartas coleccionables · máximo Nivel ${playerLevel()} · 20 oro</p><button class="btn primary" data-action="buyPack" ${state.profile.coins<20?"disabled":""}>Abrir por 20 oro</button><p class="muted" style="max-width:420px">Los Poderes de nivel 1 no ocupan colección: dispones de copias infinitas desde que creas la cuenta.</p></div></section>
      <section class="panel"><div class="panel-head"><h2>Última apertura</h2><span class="pill">${state.profile.packs||0} sobres abiertos</span></div><div class="panel-body">${state.lastPack.length?'<div class="reveal-grid">'+state.lastPack.map(c=>cardTile(c,{qty:owned(c.id)})).join("")+'</div>':'<div class="empty">Abre un sobre para revelar cartas aquí.</div>'}</div></section>
    </div>
    <section class="panel" style="margin-top:14px"><div class="panel-head"><h2>Tu punto de partida</h2><span class="muted">Progresión por nivel</span></div><div class="panel-body"><div class="grid three"><div class="stat-card"><small>Oro actual</small><strong>${state.profile.coins}</strong></div><div class="stat-card"><small>Cartas coleccionables</small><strong>${collectionTotal()}</strong></div><div class="stat-card"><small>Poder básico Nv 1</small><strong>∞</strong></div></div></div></section>
  </div>`;
}
async function buyPack(){
  if(state.profile.coins<20)return;
  const r=await api("buy_pack",{},true);
  if(!r.ok){toast(authErrorMessage(r.error),"bad");return}
  applyProfile(r.profile);
  state.lastPack=(r.cards||[]).map(x=>card(x.id)).filter(Boolean);
  playSound("draw");toast("Sobre abierto: todas las cartas son de Nivel "+playerLevel()+" o inferior.","good");renderView();
}
async function sellCard(id){
  const c=card(id);if(!c||isBasicPower(c)||freeCopies(id)<=0)return;
  const r=await api("sell_card",{cardId:Number(id)},true);
  if(!r.ok){toast(authErrorMessage(r.error),"bad");return}
  applyProfile(r.profile);toast(c.name+" vendido por "+r.soldFor+" oro.","good");renderView();
}

function renderTrade(){
  const partners=state.users.filter(u=>!state.socket||u.socketId!==state.socket.id);
  const inventory=state.catalog.filter(c=>freeCopies(c.id)>state.trade.mine.filter(x=>x===c.id).length).slice(0,120);
  return `<div class="page">
    ${pageHead("Comercio","Intercambios","Negocia cartas y oro con jugadores conectados. Si estás solo, usa el Mercader del Gremio para probar el sistema.")}
    <div class="trade-layout">
      <section class="panel"><div class="panel-head"><h2>Tu reserva</h2><span class="muted">${inventory.length} disponibles</span></div><div class="panel-body trade-offer">${inventory.map(c=>`<div class="trade-item"><img src="${cardImage(c)}"><div><b>${esc(c.name)}</b><small class="muted">Nv ${c.level} · valor ${cardValue(c)} · libres ${freeCopies(c.id)-state.trade.mine.filter(x=>x===c.id).length}</small></div><button class="btn small" data-action="tradeAdd" data-id="${c.id}">+</button></div>`).join("")||'<div class="empty">No tienes copias libres.</div>'}</div></section>
      <section class="panel"><div class="panel-head"><h2>Negociación</h2></div><div class="panel-body">
        <div class="field"><label>Jugador</label><select class="select" id="tradePartner"><option value="">Mercader del Gremio</option>${partners.map(u=>`<option value="${esc(u.socketId)}" ${state.trade.partnerId===u.socketId?"selected":""}>${esc(u.name)}</option>`).join("")}</select></div>
        <h3>Tu oferta</h3><div id="myOffer">${renderMyOffer()}</div>
        <div class="field" style="margin-top:10px"><label>Oro ofrecido</label><input class="input" id="tradeGold" type="number" min="0" max="${state.profile.coins}" value="${state.trade.ownGold||0}"></div>
        <div class="actions" style="margin-top:12px"><button class="btn primary" data-action="tradePropose">Proponer</button><button class="btn" data-action="tradeAccept" ${state.trade.ready?"":"disabled"}>Aceptar</button><button class="btn danger" data-action="tradeCancel">Cancelar</button></div>
        <p class="muted" style="margin-bottom:0">${esc(state.trade.status||"Selecciona cartas y prepara una oferta.")}</p>
      </div></section>
      <section class="panel"><div class="panel-head"><h2>Oferta recibida</h2><span class="pill">${state.trade.theirGold||0} oro</span></div><div class="panel-body trade-offer">${renderTheirOffer()}</div></section>
    </div>
  </div>`;
}
function renderMyOffer(){
  if(!state.trade.mine.length)return'<div class="empty">Sin cartas en la oferta.</div>';
  return state.trade.mine.map((id,i)=>{const c=card(id);return`<div class="trade-item"><img src="${cardImage(c)}"><div><b>${esc(c.name)}</b><small class="muted">valor ${cardValue(c)}</small></div><button class="btn small danger" data-action="tradeRemove" data-index="${i}">×</button></div>`}).join("");
}
function renderTheirOffer(){
  if(!state.trade.theirs.length)return'<div class="empty">Todavía no hay contraoferta.</div>';
  return state.trade.theirs.map(id=>{const c=card(id);return c?`<div class="trade-item"><img src="${cardImage(c)}"><div><b>${esc(c.name)}</b><small class="muted">Nv ${c.level} · valor ${cardValue(c)}</small></div></div>`:""}).join("");
}
function tradeAdd(id){
  id=Number(id);if(freeCopies(id)<=state.trade.mine.filter(x=>x===id).length)return;
  state.trade.mine.push(id);state.trade.ready=false;renderView();
}
function tradeRemove(i){state.trade.mine.splice(Number(i),1);state.trade.ready=false;renderView()}
function proposeTrade(){
  const gold=clamp(Number($("tradeGold")?.value)||0,0,state.profile.coins);state.trade.ownGold=gold;
  const partner=$("tradePartner")?.value||"";state.trade.partnerId=partner;
  if(!state.trade.mine.length&&!gold){toast("Añade cartas u oro a la oferta.","bad");return}
  if(partner&&state.connected){
    const u=state.users.find(x=>x.socketId===partner);state.trade.partnerName=u?.name||"Jugador";
    if(state.trade.onlineId){state.socket.emit("trade:offer",{tradeId:state.trade.onlineId,cards:state.trade.mine.slice(),gold});state.trade.status="Oferta actualizada y enviada."}
    else{state.socket.emit("trade:invite",{to:partner});state.trade.status="Solicitud enviada a "+state.trade.partnerName+"…"}
    renderView();return;
  }
  const value=state.trade.mine.reduce((n,id)=>n+cardValue(card(id)),0)+gold;
  const pool=state.catalog.filter(c=>c.level<=Math.max(8,Math.round(value/2)+2));
  let sum=0,tries=0;state.trade.theirs=[];
  while(sum<Math.max(1,Math.round(value*.88))&&state.trade.theirs.length<5&&tries++<40){const c=pool[Math.floor(Math.random()*pool.length)];if(c){state.trade.theirs.push(c.id);sum+=cardValue(c)}}
  state.trade.theirGold=sum<value?Math.min(20,value-sum):0;state.trade.ready=true;state.trade.status="El Mercader del Gremio ha respondido.";renderView();
}
function acceptTrade(){
  if(!state.trade.ready)return;
  state.trade.ownGold=clamp(Number($("tradeGold")?.value)||state.trade.ownGold||0,0,state.profile.coins);
  if(state.trade.onlineId&&state.connected){
    state.socket.emit("trade:accept",{tradeId:state.trade.onlineId});state.trade.status="Aceptado. Esperando confirmación del otro jugador…";renderView();return;
  }
  finalizeTrade("Intercambio completado con el Mercader del Gremio.");
}
function finalizeTrade(message){
  const counts={};for(const id of state.trade.mine)counts[id]=(counts[id]||0)+1;
  if(Object.entries(counts).some(([id,q])=>freeCopies(id)<q)){toast("Tu reserva cambió y la oferta ya no es válida.","bad");resetTrade();return}
  if(state.profile.coins<state.trade.ownGold){toast("No tienes el oro comprometido.","bad");return}
  for(const id of state.trade.mine)state.profile.collection[id]=Math.max(0,owned(id)-1);
  for(const id of state.trade.theirs)state.profile.collection[id]=(state.profile.collection[id]||0)+1;
  state.profile.coins=state.profile.coins-state.trade.ownGold+state.trade.theirGold;
  saveProfile();resetTrade();toast(message,"good");renderView();
}
function cancelTrade(){
  if(state.trade.onlineId&&state.connected)state.socket.emit("trade:cancel",{tradeId:state.trade.onlineId});
  resetTrade();toast("Intercambio cancelado.");renderView();
}
function resetTrade(){state.trade=freshTrade()}

function renderProfile(){
  const total=state.profile.wins+state.profile.losses;
  return `<div class="page">
    <section class="panel profile-banner"><div><div class="kicker">Aprendiz</div><h1>${esc(state.profile.name)}</h1><p class="muted">Nivel ${playerLevel()} · ${state.profile.wins} victorias · ${state.profile.losses} derrotas</p></div></section>
    <div class="grid four" style="margin-top:14px"><div class="stat-card"><small>Victorias</small><strong>${state.profile.wins}</strong></div><div class="stat-card"><small>Derrotas</small><strong>${state.profile.losses}</strong></div><div class="stat-card"><small>Win rate</small><strong>${winrate()}%</strong></div><div class="stat-card"><small>Oro</small><strong>${state.profile.coins}</strong></div></div>
    <div class="grid two" style="margin-top:14px">
      <section class="panel"><div class="panel-head"><h2>Ajustes</h2></div><div class="panel-body"><label class="quick-row"><span class="quick-icon">♪</span><span><b>Sonidos del juego</b><small class="muted" style="display:block">Efectos originales recuperados</small></span><input type="checkbox" id="soundToggle" ${state.sound?"checked":""}></label><div class="actions" style="margin-top:12px"><button class="btn" data-action="nav" data-view="archive">Ver archivo histórico</button><button class="btn danger" data-action="resetProfile">Reiniciar progreso local</button></div></div></section>
      <section class="panel"><div class="panel-head"><h2>Resumen</h2></div><div class="panel-body"><div class="quick-list"><div class="quick-row"><span class="quick-icon">◇</span><span><b>${uniqueOwned()} / 285 cartas</b><small class="muted" style="display:block">coleccionadas</small></span></div><div class="quick-row"><span class="quick-icon">▦</span><span><b>${state.profile.packs||0} sobres</b><small class="muted" style="display:block">abiertos</small></span></div><div class="quick-row"><span class="quick-icon">⚔</span><span><b>${total} partidas</b><small class="muted" style="display:block">registradas localmente</small></span></div></div></div></section>
    </div>
  </div>`;
}
function renderArchive(){
  return `<div class="page">
    ${pageHead("2002–2005","Archivo histórico","La interfaz moderna se construye sobre los archivos originales. Aquí puedes comparar el nuevo cliente con algunas capturas conservadas.")}
    <div class="archive-grid"><div class="archive-shot"><img src="legacy-assets/imagenes/screen_shot_1.gif"><p class="muted">Salón clásico de Rolplay.net</p></div><div class="archive-shot"><img src="2013/screenshot2.jpg"><p class="muted">Tablero histórico</p></div><div class="archive-shot"><img src="2013/screenshot3.jpg"><p class="muted">Álbum y colección</p></div></div>
    <section class="panel" style="margin-top:14px"><div class="panel-body"><h2>Qué se conserva</h2><p class="muted">El catálogo de 285 cartas, arte original, sonidos, música, reglas recuperadas, economía, estructura de salas, intercambios y las seis fases del duelo. La capa de presentación y red ha sido reconstruida para navegadores actuales.</p></div></section>
  </div>`;
}

function cardDetail(id){
  const c=card(id);if(!c)return;const r=rarity(c);
  $("modalRoot").innerHTML=`<div class="modal-backdrop" data-action="closeModal"><div class="modal" onclick="event.stopPropagation()"><div class="modal-head"><div><b>${esc(c.name)}</b><div class="muted" style="font-size:11px">${cardType(c)} · ${r.name}</div></div><button class="btn icon ghost" data-action="closeModal">×</button></div><div class="modal-body"><div class="card-detail"><img src="${cardImage(c)}"><div><div class="kicker">Nivel ${c.level}</div><h2>${esc(c.name)}</h2><div class="grid two"><div class="stat-card"><small>Coste</small><strong>${c.cost}</strong></div><div class="stat-card"><small>${c.powerCard?"Poder":"Ataque / Defensa"}</small><strong>${c.powerCard?"+"+powerValue(c):c.atk+" / "+c.def}</strong></div></div><p class="muted">Rareza de catálogo: ${c.rarity}. Valor económico actual: ${cardValue(c)}. Posees ${owned(c.id)} copia(s), con ${freeCopies(c.id)} libre(s) fuera del mazo.</p><div class="actions"><button class="btn primary" data-action="addDeck" data-id="${c.id}" ${freeCopies(c.id)<=0?"disabled":""}>Añadir al mazo</button><button class="btn" data-action="sellCard" data-id="${c.id}" ${freeCopies(c.id)<=0?"disabled":""}>Vender una</button></div></div></div></div></div></div>`;
}
function openMobileMenu(){
  $("modalRoot").innerHTML=`<div class="modal-backdrop" data-action="closeModal"><div class="modal" style="max-width:420px" onclick="event.stopPropagation()"><div class="modal-head"><b>Más secciones</b><button class="btn icon ghost" data-action="closeModal">×</button></div><div class="modal-body"><div class="quick-list">
    <button class="quick-row btn" data-action="nav" data-view="shop"><span class="quick-icon">✦</span><span><b>Tienda</b><small class="muted" style="display:block">Sobres y economía</small></span></button>
    <button class="quick-row btn" data-action="nav" data-view="trade"><span class="quick-icon">⇄</span><span><b>Intercambios</b><small class="muted" style="display:block">Cartas y oro</small></span></button>
    <button class="quick-row btn" data-action="nav" data-view="profile"><span class="quick-icon">◎</span><span><b>Perfil</b><small class="muted" style="display:block">Estadísticas y ajustes</small></span></button>
    <button class="quick-row btn" data-action="nav" data-view="archive"><span class="quick-icon">⌛</span><span><b>Archivo</b><small class="muted" style="display:block">Historia del cliente clásico</small></span></button>
  </div></div></div></div>`;
}
function closeModal(){$("modalRoot").innerHTML=""}

function connectOnline(){
  if(state.connected||state.connecting||!state.profile)return;
  state.connecting=true;
  const start=()=>{
    if(!window.io){state.connecting=false;return}
    const socket=window.io(SERVER_URL,{transports:["websocket","polling"],timeout:8000});
    state.socket=socket;
    socket.on("connect",()=>{state.connected=true;state.connecting=false;socket.emit("hello",{name:state.profile.name,level:playerLevel(),wins:state.profile.wins});updateChrome();if(state.view==="home"||state.view==="play"||state.view==="trade")renderView()});
    socket.on("disconnect",()=>{state.connected=false;updateChrome();if(state.view!=="duel")renderView()});
    socket.on("connect_error",()=>{state.connected=false;state.connecting=false;updateChrome()});
    socket.on("lobby:users",list=>{state.users=Array.isArray(list)?list:[];updateChrome();if(["home","trade"].includes(state.view))renderView()});
    socket.on("matches:list",list=>{state.matches=Array.isArray(list)?list:[];if(["home","play"].includes(state.view))renderView()});
    socket.on("chat:message",m=>{state.chat.push({from:m.from,text:m.text});if(state.view==="home")renderView()});
    socket.on("chat:system",m=>{state.chat.push({system:true,text:m.text});if(state.view==="home")renderView()});
    socket.on("match:created",m=>{toast("Reto online creado. Esperando rival.","good");if(state.view==="play")renderView()});
    socket.on("match:error",m=>toast(m?.message||"No se pudo entrar en la partida.","bad"));
    socket.on("match:ready",m=>{toast("Reto aceptado contra "+(m.opponent?.name||"otro jugador")+".","good")});
    socket.on("duel:snapshot",applyOnlineSnapshot);
    socket.on("trade:invited",m=>{
      state.trade=freshTrade();state.trade.onlineId=m.tradeId;state.trade.partnerId=m.from?.socketId||"";state.trade.partnerName=m.from?.name||"Jugador";state.trade.status=state.trade.partnerName+" quiere intercambiar contigo.";go("trade");
    });
    socket.on("trade:waiting",m=>{state.trade.onlineId=m.tradeId;state.trade.partnerId=m.to;state.trade.status="Solicitud aceptada por el servidor. Enviando oferta…";socket.emit("trade:offer",{tradeId:m.tradeId,cards:state.trade.mine.slice(),gold:state.trade.ownGold||0});if(state.view==="trade")renderView()});
    socket.on("trade:offer",m=>{if(m.tradeId!==state.trade.onlineId)return;state.trade.theirs=(m.cards||[]).map(Number).filter(id=>card(id));state.trade.theirGold=Math.max(0,Number(m.gold)||0);state.trade.ready=true;state.trade.status="Contraoferta recibida.";if(state.view==="trade")renderView()});
    socket.on("trade:accepted",m=>{if(m.tradeId===state.trade.onlineId){state.trade.status="El otro jugador ha aceptado. Falta la segunda confirmación.";if(state.view==="trade")renderView()}});
    socket.on("trade:locked",m=>{if(m.tradeId===state.trade.onlineId)finalizeTrade("Intercambio online completado.")});
    socket.on("trade:cancelled",m=>{if(m.tradeId===state.trade.onlineId){resetTrade();toast("El intercambio fue cancelado.","bad");if(state.view==="trade")renderView()}});
  };
  if(window.io){start();return}
  const sc=document.createElement("script");sc.src=SERVER_URL+"/socket.io/socket.io.js";sc.async=true;sc.onload=start;sc.onerror=()=>{state.connecting=false;toast("Servidor online no disponible. Puedes seguir entrenando en local.","bad")};document.head.appendChild(sc);
}

function createMatch(){
  const size=Number($("matchSize")?.value)||30,start=$("matchStart")?.value||"normal";
  if(!state.connected){toast("No hay conexión con el servidor.","bad");return}
  if(!deckValid(size)){toast("Tu mazo necesita al menos "+size+" cartas válidas para este reto.","bad");return}
  state.socket.emit("match:create",{deckSize:size,start,deck:state.profile.deck.slice(0,size)});playSound("click");
}
function joinMatch(id,size){
  size=Number(size)||30;if(!state.connected)return;
  if(!deckValid(size)){toast("Necesitas "+size+" cartas válidas para entrar.","bad");return}
  state.socket.emit("match:join",{id,deck:state.profile.deck.slice(0,size)});
}
function cancelMatch(id){if(state.connected)state.socket.emit("match:cancel",{id})}

function wireInstance(inst){
  const base=card(inst.cardId);if(!base)return null;
  return{...base,uid:inst.uid,exhausted:!!inst.exhausted,selected:!!inst.selected,defBonus:Number(inst.defBonus)||0,def:(base.def||0)+(Number(inst.defBonus)||0)}
}
function applyOnlineSnapshot(s){
  if(!s)return;
  const previous=state.duel&&state.duel.online&&state.duel.matchId===s.matchId?state.duel:null;
  state.duel={online:true,matchId:s.matchId,myTurn:!!s.myTurn,opponent:s.opponent?.name||"Rival",turn:Number(s.turn)||1,phase:Number(s.phase)||0,
    playerHp:Number(s.playerHp)||0,enemyHp:Number(s.enemyHp)||0,power:Number(s.power)||0,maxPower:Number(s.maxPower)||0,powerPlayed:!!s.powerPlayed,
    enemyPower:Number(s.enemyPower)||0,enemyMaxPower:Number(s.enemyMaxPower)||0,playerDeckCount:Number(s.playerDeckCount)||0,enemyDeckCount:Number(s.enemyDeckCount)||0,
    playerHand:(s.playerHand||[]).map(wireInstance).filter(Boolean),enemyHandCount:Number(s.enemyHandCount)||0,
    playerBoard:(s.playerBoard||[]).map(wireInstance).filter(Boolean),enemyBoard:(s.enemyBoard||[]).map(wireInstance).filter(Boolean),
    playerPowers:(s.playerPowers||[]).map(wireInstance).filter(Boolean),enemyPowers:(s.enemyPowers||[]).map(wireInstance).filter(Boolean),
    gameOver:!!s.gameOver,won:s.won,defending:!!s.defending,attackDeclared:!!s.attackDeclared,blockAssignments:s.blockAssignments||{},log:s.log||[],resultApplied:previous?.resultApplied||false
  };
  if(state.duel.gameOver&&!state.duel.resultApplied){
    state.duel.resultApplied=true;if(s.won){state.profile.wins++;state.profile.coins+=10;playSound("win")}else state.profile.losses++;
    saveProfile();
  }
  if(state.view!=="duel")state.view="duel";updateChrome();renderView();
}

function renderDuel(){
  const d=state.duel;if(!d)return'<div class="page"><div class="empty">No hay duelo activo.</div></div>';
  const phase=PHASES[d.phase]||PHASES[0];
  return `<div class="duel-page">
    <div class="duel-top">
      <div class="fighter"><div class="avatar">${initial(state.profile.name)}</div><div><b>${esc(state.profile.name)}</b><div class="muted">PV ${d.playerHp} · Poder ${d.power}/${d.maxPower}</div><div class="hpbar"><span style="width:${clamp(d.playerHp/30*100,0,100)}%"></span></div></div></div>
      <div style="text-align:center"><div class="kicker">Turno ${d.turn}</div><b>${d.online?(d.defending?"Defiende el ataque":d.attackDeclared?"Esperando defensa":d.myTurn?"Tu turno":"Turno rival"):"Entrenamiento"}</b></div>
      <div class="fighter enemy"><div><b>${esc(d.opponent||"Guardián")}</b><div class="muted">PV ${d.enemyHp} · Poder ${d.enemyPower||0}/${d.enemyMaxPower||0}</div><div class="hpbar"><span style="width:${clamp(d.enemyHp/30*100,0,100)}%"></span></div></div><div class="avatar">${initial(d.opponent||"G")}</div></div>
    </div>
    <div class="phase-track">${PHASES.map((p,i)=>`<div class="phase-step ${i===d.phase?"active":""}">${i+1}. ${p}</div>`).join("")}</div>
    <div class="board">
      <section class="board-zone"><div class="zone-title"><span>Rival · ${d.enemyHandCount??d.enemyHand?.length??0} cartas en mano</span><span>Mazo ${d.enemyDeckCount??d.enemyDeck?.length??0}</span></div><div class="battle-row">${battleCards(d.enemyBoard||[],"enemy")}</div></section>
      <section class="board-zone"><div class="zone-title"><span>Tu campo · Poder en juego ${(d.playerPowers||[]).map(c=>esc(c.name)).join(", ")||"ninguno"}</span><span>${phase}</span></div><div class="battle-row">${battleCards(d.playerBoard||[],"player")}</div></section>
      <div class="duel-bottom">
        <section class="board-zone"><div class="zone-title"><span>Tu mano</span><span>Mazo ${d.playerDeckCount??d.playerDeck?.length??0}</span></div><div class="battle-row">${battleCards(d.playerHand||[],"hand")}</div><div class="duel-controls">${duelControls(d)}</div></section>
        <section class="panel"><div class="panel-head"><h3>Registro</h3><span class="pill">${phase}</span></div><div class="panel-body"><div class="duel-log">${(d.log||[]).slice(-30).map(x=>`<div>${esc(x)}</div>`).join("")||'<div>El duelo ha comenzado.</div>'}</div></div></section>
      </div>
    </div>
  </div>`;
}
function battleCards(list,zone){
  if(!list?.length)return'<div class="empty" style="min-width:100%">Sin cartas</div>';
  return list.map(c=>{
    const clickable=duelCardClickable(c,zone);
    return `<article class="battle-card ${clickable?"clickable":""} ${c.selected?"selected":""} ${c.exhausted?"exhausted":""}" ${clickable?'data-action="duelCard" data-zone="'+zone+'" data-uid="'+c.uid+'"':""} data-detail="${c.id}"><div class="battle-art" style="background-image:url('${cardImage(c)}')"></div><div class="battle-name">${esc(c.name)}</div><div class="battle-stats"><span>${c.powerCard?"P +"+powerValue(c):"ATQ "+c.atk}</span><span>${c.powerCard?"":"DEF "+c.def}</span></div></article>`;
  }).join("");
}
function duelCardClickable(c,zone){
  const d=state.duel;if(!d||d.gameOver)return false;
  if(d.online&&(d.defending||d.attackDeclared))return false;
  if(d.online&&!d.myTurn)return false;
  if(zone==="hand")return(d.phase===2&&c.powerCard&&!d.powerPlayed)||(d.phase===3&&!c.powerCard&&!c.abilityCard&&c.cost<=d.power)||(d.phase===4&&c.abilityCard&&c.cost<=d.power);
  if(zone==="player")return d.phase===5&&!c.exhausted;
  return false;
}
function duelControls(d){
  if(d.gameOver)return`<div class="turn-wait">${d.won===false?"Derrota":"Victoria"} · <button class="btn small" data-action="leaveDuel">Volver al salón</button></div>`;
  if(d.online&&d.defending)return renderDefenseControls(d);
  if(d.online&&d.attackDeclared)return'<div class="turn-wait">El rival está asignando defensores…</div>';
  if(d.online&&!d.myTurn)return'<div class="turn-wait">Esperando la acción del rival…</div>';
  return`<button class="btn danger" data-action="${d.online?"concede":"restartTraining"}">${d.online?"Retirarse":"Reiniciar"}</button><span style="flex:1"></span><button class="btn primary" data-action="nextPhase">${d.phase===5?"Declarar ataque":"Siguiente fase"}</button>`;
}
function renderDefenseControls(d){
  const attackers=(d.enemyBoard||[]).filter(c=>c.selected&&!c.exhausted);
  const defenders=(d.playerBoard||[]).filter(c=>!c.exhausted);
  if(!attackers.length)return'<div class="turn-wait">El ataque rival se está resolviendo…</div>';
  return`<div style="width:100%"><div class="turn-wait" style="margin-bottom:8px">Asigna un defensor a cada atacante o déjalo pasar.</div>
    <div class="grid" style="gap:6px">${attackers.map(a=>`<label class="quick-row"><span><b>${esc(a.name)}</b><small class="muted" style="display:block">ATQ ${a.atk}</small></span><select class="select" data-block-attacker="${a.uid}"><option value="">Sin bloquear</option>${defenders.map(dfc=>`<option value="${dfc.uid}" ${d.blockAssignments?.[a.uid]===dfc.uid?"selected":""}>${esc(dfc.name)} · DEF ${dfc.def}</option>`).join("")}</select></label>`).join("")}</div>
    <div class="actions" style="margin-top:8px"><button class="btn danger" data-action="concede">Retirarse</button><span style="flex:1"></span><button class="btn primary" data-action="resolveDefense">Resolver defensa</button></div>
  </div>`;
}

function training(){
  const size=Math.max(20,Math.min(30,state.profile.deck.length||30));
  let playerIds=deckValid(20)?state.profile.deck.slice(0,size):[];
  if(playerIds.length<20){toast("Tu mazo necesita 20 cartas para entrenar.","bad");go("deck");return}
  const powers=state.catalog.filter(c=>c.powerCard&&c.level<=15),creatures=state.catalog.filter(c=>!c.powerCard&&!c.abilityCard&&c.level<=10);
  const enemy=[];while(enemy.length<size){enemy.push((enemy.length<Math.ceil(size*.3)?powers:creatures)[Math.floor(Math.random()*(enemy.length<Math.ceil(size*.3)?powers:creatures).length)].id)}
  state.duel={online:false,opponent:"Guardián",turn:1,phase:0,playerHp:30,enemyHp:30,power:0,maxPower:0,enemyPower:0,enemyMaxPower:0,
    playerDeck:shuffle(playerIds).map(makeInst),enemyDeck:shuffle(enemy).map(makeInst),playerHand:[],enemyHand:[],playerBoard:[],enemyBoard:[],playerPowers:[],enemyPowers:[],
    playerPowerPlayed:false,enemyPowerPlayed:false,gameOver:false,won:null,log:["Entrenamiento iniciado con 7 cartas por jugador."]};
  drawLocal("player",7);drawLocal("enemy",7);state.view="duel";updateChrome();playSound("turn");renderView();
}
function makeInst(id){const c=card(id);return c?{...c,uid:uid(),exhausted:false,selected:false}:null}
function drawLocal(side,n=1){
  const d=state.duel;for(let i=0;i<n;i++){const deck=d[side+"Deck"];if(deck.length)d[side+"Hand"].push(deck.pop());else{d.gameOver=true;d.won=side==="enemy";d.log.push(side==="player"?"Te has quedado sin cartas.":"El rival se ha quedado sin cartas.")}}
}
function localPlay(uid){
  const d=state.duel,i=d.playerHand.findIndex(c=>c.uid===uid);if(i<0)return;const c=d.playerHand[i];
  if(d.phase===2&&c.powerCard&&!d.playerPowerPlayed){d.playerHand.splice(i,1);d.playerPowers.push(c);d.maxPower=powerTotal(d.playerPowers);d.power=d.maxPower;d.playerPowerPlayed=true;d.log.push("Conjuras "+c.name+".");playSound("power")}
  else if(d.phase===3&&!c.powerCard&&!c.abilityCard&&c.cost<=d.power){d.power-=c.cost;d.playerHand.splice(i,1);d.playerBoard.push(c);d.log.push("Invocas "+c.name+".");playSound("summon")}
  else if(d.phase===4&&c.abilityCard&&c.cost<=d.power){d.power-=c.cost;d.playerHand.splice(i,1);resolveLocalAbility(c,"player")}
  renderView();
}
function resolveLocalAbility(c,side){
  const d=state.duel,foe=side==="player"?"enemy":"player",n=norm(c.name);
  if(n.startsWith("fuente de vida")){d[side+"Hp"]+=3;d.log.push(c.name+": +3 PV.")}
  else if(n.startsWith("veneno")){d[foe+"Hp"]-=3;d.log.push(c.name+": 3 PV de daño.")}
  else if(n.startsWith("drenador")){d[foe+"Hp"]-=2;d[side+"Hp"]+=2;d.log.push(c.name+": drena 2 PV.")}
  else if(n.startsWith("poder mental")){drawLocal(side,1);d.log.push(c.name+": carta adicional.")}
  else if(n.startsWith("poderador")){d[side==="player"?"power":"enemyPower"]=Math.min(d[side==="player"?"maxPower":"enemyMaxPower"],d[side==="player"?"power":"enemyPower"]+2)}
  else{drawLocal(side,1);d.log.push(c.name+" se resuelve.")}
  checkLocalEnd();
}
function toggleLocalAttack(uid){const c=state.duel.playerBoard.find(x=>x.uid===uid);if(c&&!c.exhausted){c.selected=!c.selected;renderView()}}
function nextLocalPhase(){
  const d=state.duel;if(d.gameOver)return;
  if(d.phase===5){resolveLocalAttack();if(checkLocalEnd())return renderView();enemyTurn();if(checkLocalEnd())return renderView();d.turn++;d.phase=0;d.playerBoard.forEach(c=>{c.exhausted=false;c.selected=false});d.playerPowerPlayed=false;d.maxPower=powerTotal(d.playerPowers);d.power=d.maxPower;d.log.push("Comienza tu turno "+d.turn+".");playSound("turn");renderView();return}
  d.phase++;if(d.phase===1){drawLocal("player",1);playSound("draw")}if(d.phase===2){d.maxPower=powerTotal(d.playerPowers);d.power=d.maxPower}renderView();
}
function resolveLocalAttack(){
  const d=state.duel,atk=d.playerBoard.filter(c=>c.selected&&!c.exhausted),blocks=d.enemyBoard.filter(c=>!c.exhausted).sort((a,b)=>b.def-a.def);
  atk.forEach((a,i)=>{const b=blocks[i];if(b&&d.enemyBoard.includes(b)){const adies=b.atk>=a.def,bdies=a.atk>=b.def;d.log.push(a.name+" combate contra "+b.name+".");if(bdies)d.enemyBoard=d.enemyBoard.filter(x=>x.uid!==b.uid);if(adies)d.playerBoard=d.playerBoard.filter(x=>x.uid!==a.uid)}
    else{d.enemyHp-=a.atk;d.log.push(a.name+" causa "+a.atk+" PV.");playSound("hit")}
    const s=d.playerBoard.find(x=>x.uid===a.uid);if(s){s.exhausted=true;s.selected=false}});
}
function enemyTurn(){
  const d=state.duel;d.enemyBoard.forEach(c=>c.exhausted=false);d.enemyPowerPlayed=false;drawLocal("enemy",1);if(d.gameOver)return;
  const p=d.enemyHand.find(c=>c.powerCard);if(p){d.enemyHand=d.enemyHand.filter(x=>x.uid!==p.uid);d.enemyPowers.push(p)}
  d.enemyMaxPower=powerTotal(d.enemyPowers);d.enemyPower=d.enemyMaxPower;
  const ability=d.enemyHand.find(c=>c.abilityCard&&c.cost<=d.enemyPower);if(ability){d.enemyPower-=ability.cost;d.enemyHand=d.enemyHand.filter(x=>x.uid!==ability.uid);resolveLocalAbility(ability,"enemy")}
  let safe=20;while(safe--){const opts=d.enemyHand.filter(c=>!c.powerCard&&!c.abilityCard&&c.cost<=d.enemyPower);if(!opts.length)break;opts.sort((a,b)=>(b.atk+b.def)-(a.atk+a.def));const c=opts[0];d.enemyPower-=c.cost;d.enemyHand=d.enemyHand.filter(x=>x.uid!==c.uid);d.enemyBoard.push(c)}
  const attackers=d.enemyBoard.filter(c=>!c.exhausted),blocks=d.playerBoard.filter(c=>!c.exhausted).sort((a,b)=>b.def-a.def);
  attackers.forEach((a,i)=>{const b=blocks[i];if(b&&d.playerBoard.includes(b)){const adies=b.atk>=a.def,bdies=a.atk>=b.def;if(bdies)d.playerBoard=d.playerBoard.filter(x=>x.uid!==b.uid);if(adies)d.enemyBoard=d.enemyBoard.filter(x=>x.uid!==a.uid)}
    else d.playerHp-=a.atk;const s=d.enemyBoard.find(x=>x.uid===a.uid);if(s)s.exhausted=true});
  if(attackers.length)d.log.push("El Guardián ataca con "+attackers.length+" criatura(s).");
}
function checkLocalEnd(){
  const d=state.duel;if(d.enemyHp<=0||d.playerHp<=0||d.gameOver){if(!d.gameOver){d.gameOver=true;d.won=d.enemyHp<=0;d.log.push(d.won?"Victoria.":"Derrota.")}if(!d.resultApplied){d.resultApplied=true;if(d.won){state.profile.wins++;state.profile.coins+=10;playSound("win")}else state.profile.losses++;saveProfile()}return true}return false
}
function duelCard(zone,uid){
  const d=state.duel;if(d.online){if(!d.myTurn)return;if(zone==="hand")state.socket.emit("duel:action",{matchId:d.matchId,type:"play",uid});else if(zone==="player")state.socket.emit("duel:action",{matchId:d.matchId,type:"toggleAttack",uid});return}
  if(zone==="hand")localPlay(uid);else if(zone==="player")toggleLocalAttack(uid);
}
function nextPhase(){const d=state.duel;if(!d)return;if(d.online){if(d.myTurn)state.socket.emit("duel:action",{matchId:d.matchId,type:"nextPhase"})}else nextLocalPhase()}
function concede(){const d=state.duel;if(d?.online&&state.connected)state.socket.emit("duel:action",{matchId:d.matchId,type:"concede"})}
function leaveDuel(){state.duel=null;go("home")}

document.addEventListener("click",e=>{
  const el=e.target.closest("[data-action]");if(!el)return;
  const a=el.dataset.action;
  if(a!=="cardDetail")playSound("click");
  if(a==="nav")go(el.dataset.view);
  else if(a==="mobileMenu")openMobileMenu();
  else if(a==="training")training();
  else if(a==="createMatch")createMatch();
  else if(a==="joinMatch")joinMatch(el.dataset.id,el.dataset.size);
  else if(a==="cancelMatch")cancelMatch(el.dataset.id);
  else if(a==="cardDetail")cardDetail(Number(el.dataset.id));
  else if(a==="closeModal")closeModal();
  else if(a==="addDeck"){e.stopPropagation();addDeck(Number(el.dataset.id));closeModal()}
  else if(a==="sellCard"){e.stopPropagation();sellCard(Number(el.dataset.id));closeModal()}
  else if(a==="removeDeck")removeDeck(Number(el.dataset.index));
  else if(a==="autoDeck")autoDeck();
  else if(a==="clearDeck"){state.profile.deck=[];saveProfile();renderView()}
  else if(a==="buyPack")buyPack();
  else if(a==="tradeAdd")tradeAdd(Number(el.dataset.id));
  else if(a==="tradeRemove")tradeRemove(Number(el.dataset.index));
  else if(a==="tradePropose")proposeTrade();
  else if(a==="tradeAccept")acceptTrade();
  else if(a==="tradeCancel")cancelTrade();
  else if(a==="resetProfile"){if(confirm("¿Reiniciar colección, mazo, oro y estadísticas de este jugador?"))resetProfile()}
  else if(a==="duelCard")duelCard(el.dataset.zone,el.dataset.uid);
  else if(a==="nextPhase")nextPhase();
  else if(a==="concede")concede();
  else if(a==="resolveDefense"){const d=state.duel;if(d?.online&&d.defending&&state.connected)state.socket.emit("duel:action",{matchId:d.matchId,type:"resolveDefense"})}
  else if(a==="restartTraining")training();
  else if(a==="leaveDuel")leaveDuel();
  else if(a==="logout")logout();
});
document.addEventListener("input",e=>{
  if(e.target.id==="collectionSearch"){
    const pos=e.target.selectionStart||e.target.value.length;
    state.collectionQuery=e.target.value;renderView();
    requestAnimationFrame(()=>{const n=$("collectionSearch");if(n){n.focus();try{n.setSelectionRange(pos,pos)}catch{}}});
  }
});
document.addEventListener("change",e=>{
  if(e.target.id==="collectionMode"){state.collectionMode=e.target.value;renderView()}
  else if(e.target.id==="collectionType"){state.collectionType=e.target.value;renderView()}
  else if(e.target.id==="deckTarget"){state.deckTarget=Number(e.target.value)||30}
  else if(e.target.id==="soundToggle"){state.sound=e.target.checked;saveProfile();toast(state.sound?"Sonidos activados.":"Sonidos desactivados.")}
  else if(e.target.matches("[data-block-attacker]")){
    const d=state.duel;if(d?.online&&d.defending&&state.connected)state.socket.emit("duel:action",{matchId:d.matchId,type:"assignBlock",attackerUid:e.target.dataset.blockAttacker,defenderUid:e.target.value||""});
  }
});
document.addEventListener("submit",e=>{
  if(e.target.id==="loginForm"){e.preventDefault();login($("loginName").value)}
  if(e.target.id==="chatForm"){e.preventDefault();const input=$("chatInput"),text=input?.value.trim();if(!text)return;if(state.connected)state.socket.emit("chat:send",{text});else{state.chat.push({from:state.profile.name,text});renderView()}}
});
$("logoutBtn")?.addEventListener("click",logout);

boot();
})();