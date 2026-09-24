(() => {
'use strict';

// ── Canvas contexts ───────────────────────────────────────────────────────────
const arena   = document.querySelector('#arena');
const x       = arena.getContext('2d');
const chart   = document.querySelector('#chart');
const cx      = chart.getContext('2d');
const ngCvs   = document.querySelector('#neuronGraph');
const ng      = ngCvs.getContext('2d');

// Arena logical size
const W = 820, H = 500;
// Neuron graph logical size
const NGW = 310, NGH = 210;

const dt = 1/30;

// State colors
const C = {
  calm  : '#805ee1',
  love  : '#ff5c9a',
  angry : '#ed4c4c',
  chill : '#52b8a0',
  happy : '#40b981',
  sad   : '#e07a2a', // drama/stress = arousal, orange-amber not blue
};

// Fly body colors (keyed by type)
const FLY_COL = {
  player : '#805ee1',
  lover  : '#ff5c9a',
  enemy  : '#ed4c4c',
  friend : '#52b8a0',
};

const keys = {}, events = [], samples = [];
let running = true, time = 0, mode = 'food';
let replaying = false, lastLive = null, p1Flash = 0;
let selectedFly = null;

// ── Circuit topology (loaded async from flywire_p1.json) ──────────────────────
let circuitData = null;
let nodePos     = null; // built once after circuitData loads
fetch('flywire_p1.json')
  .then(r => r.json())
  .then(d => { circuitData = d; })
  .catch(() => { circuitData = null; });

// Per-neuron afterglow (index matches LIF .n array order within each group)
const nodeGlow = {
  sensory : new Float32Array(4),
  p1      : new Float32Array(6),
  motor   : new Float32Array(4),
};
const GLOW_DECAY = 0.80; // per frame at 30fps → 50% gone in ~3 frames

// ── Helpers ───────────────────────────────────────────────────────────────────
const clamp = (n,a,b) => Math.max(a, Math.min(b, n));
const dist  = (a,b)   => Math.hypot(a.x-b.x, a.y-b.y);
const unit  = (a,b)   => { const l=Math.hypot(b.x-a.x,b.y-a.y)||1; return{x:(b.x-a.x)/l,y:(b.y-a.y)/l} };

function hexToRgba(hex, a) {
  const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

function blendHex(hex1, hex2, t) {
  const r1=parseInt(hex1.slice(1,3),16),g1=parseInt(hex1.slice(3,5),16),b1=parseInt(hex1.slice(5,7),16);
  const r2=parseInt(hex2.slice(1,3),16),g2=parseInt(hex2.slice(3,5),16),b2=parseInt(hex2.slice(5,7),16);
  return `rgb(${Math.round(r1*(1-t)+r2*t)},${Math.round(g1*(1-t)+g2*t)},${Math.round(b1*(1-t)+b2*t)})`;
}

// ── LIF Neuron group ──────────────────────────────────────────────────────────
class LIF {
  constructor(name, n, t=.85) {
    this.name = name;
    this.n = Array.from({length:n}, ()=>({v:0,s:0}));
    this.t = t; this.rate = 0;
  }
  tick(drive, linked=0) {
    let z = 0;
    this.n.forEach((q,i) => {
      q.v *= .78;
      q.v += drive*(.8+i*.03) + linked*.14;
      q.s  = 0;
      if (q.v > this.t) { q.v=0; q.s=1; z++; }
    });
    const inst = z / this.n.length;
    this.rate = this.rate * 0.65 + inst * 0.35;
    return this.rate;
  }
}

// ── Brain — P1 circuit (Love / Angry / Chill / Happy / Sad) ──────────────────
// Snack contact: reward-like signal → mild P1 drive, no threat → love-leaning
// Drama zone:    stress/arousal signal → P1 drive with simulated threat → angry-leaning
// Friend fly:    calm social presence → gentle baseline P1 drive (~20-25%), no courtship
// Honest label: all outputs run through the SAME P1 group, not separate circuits.
class Brain {
  constructor() {
    this.social = new LIF('Social sensory', 4, .74);
    this.p1     = new LIF('P1 group',       6, .83);
    this.motor  = new LIF('Motor group',    4, .8);
    this.r = { love:0, angry:0, happy:0, sad:0, chill:0 };
  }
  tick(s) {
    // Social drive (fly proximity)
    const so = this.social.tick(s.social);
    // Food adds a reward-like low P1 drive (no threat → positive-leaning)
    const foodDrive  = s.food  ? 0.48 : 0;
    // Drama adds an arousal drive with simulated threat component
    const dramaDrive = s.sad   ? 0.62 : 0;
    const dramaThreat= s.sad   ? 0.55 : 0;
    // Combined P1 drive = max of social and environmental inputs
    const totalDrive = Math.max(s.social, foodDrive, dramaDrive);
    const totalLinked= so;
    const p1 = this.p1.tick(totalDrive, totalLinked);
    // Effective threat blends social threat with drama stress
    const effThreat = Math.max(s.threat, dramaThreat);

    // Love: only eligible when near Lover fly (no threat, no friend)
    const isCourtshipEligible = !s.friendNear && effThreat < 0.20 && s.isLover;
    this.r.love  = isCourtshipEligible ? clamp(p1 * 1.45, 0, 1) : 0;

    // Aggression (angry): triggers whenever Enemy threat is present and P1 is aroused (>18%)
    this.r.angry = (s.threat > 0.20 && p1 > 0.18) ? clamp(p1 * s.threat * 1.6, 0.25, 1) : 0;

    // Happy: appetitive reward contact from snack
    this.r.happy = s.food ? clamp(p1 * 1.30, 0.25, 1) : 0;

    // Sad / Stressed: drama zone stress arousal
    this.r.sad   = s.sad ? clamp(p1 * 1.35, 0.30, 1) : 0;

    // Chill: calm social presence when near friend
    this.r.chill = s.friendNear ? clamp(p1 * 1.1, 0.18, 0.40) : 0;

    this.motor.tick(Math.max(this.r.love, this.r.angry, this.r.happy, this.r.sad, this.r.chill), p1);
    return this.r;
  }
}

// ── Fly factory ───────────────────────────────────────────────────────────────
let nextId = 1;
const mk = (type, px, py) => ({
  id    : type==='player' ? 'A' : String(nextId++),
  type, x:px, y:py,
  r     : type==='player' ? 24 : 22,
  vx:0, vy:0, h:0,
  brain : new Brain(),
  state : 'calm',
  history : ['CALM'],
  last: 0, search: 0, trail: []
});

const player = mk('player', 385, 255);
let flies  = [player];
let foods  = [{x:150,y:110,r:31,type:'food'},{x:670,y:375,r:31,type:'food'}];
let bads   = [{x:650,y:115,r:48,type:'drama'}];

// ── Safe placement helper (Fix 1: enforce minimum separation) ────────────────
function getSafePosition(x, y, radius) {
  const allExisting = [
    ...flies.map(f => ({ x: f.x, y: f.y, r: f.r })),
    ...foods.map(f => ({ x: f.x, y: f.y, r: 31 })),
    ...bads.map(b => ({ x: b.x, y: b.y, r: 48 }))
  ];
  let cand = { x: clamp(x, radius + 15, W - radius - 15), y: clamp(y, radius + 15, H - radius - 15) };

  for (let iter = 0; iter < 15; iter++) {
    let moved = false;
    for (const q of allExisting) {
      const minD = radius + q.r + 18; // 18px visual buffer between boundaries
      const d = dist(cand, q);
      if (d < minD) {
        const angle = d > 0.5 ? Math.atan2(cand.y - q.y, cand.x - q.x) : Math.random() * Math.PI * 2;
        cand.x = clamp(q.x + Math.cos(angle) * minD, radius + 15, W - radius - 15);
        cand.y = clamp(q.y + Math.sin(angle) * minD, radius + 15, H - radius - 15);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return cand;
}

// ── Floating emoji reactions ──────────────────────────────────────────────────
let floaties = [];
function spawnFloatie(emoji, fx, fy) {
  floaties.push({ emoji, x:fx, y:fy-28, life:1.6, vy:-38, alpha:1 });
}

// ── Spawn / remove flies ──────────────────────────────────────────────────────
function spawn(type) {
  const a = Math.random()*6.28, r = 190;
  const initial = {
    x: clamp(player.x + Math.cos(a)*r, 30, W-30),
    y: clamp(player.y + Math.sin(a)*r, 30, H-30)
  };
  const safe = getSafePosition(initial.x, initial.y, 22);
  flies.push(mk(type, safe.x, safe.y));
  updateRemoveBtn();
}

function removeFly(fly) {
  if (!fly || fly.type==='player') return;
  flies = flies.filter(f => f!==fly);
  if (selectedFly===fly) selectedFly=null;
  updateRemoveBtn();
}

function updateRemoveBtn() {
  const btn = document.querySelector('#removeFlyBtn');
  if (selectedFly && selectedFly.type !== 'player') {
    btn.classList.add('visible');
    btn.textContent = `\uD83D\uDDD1 Remove ${selectedFly.type}`;
  } else {
    btn.classList.remove('visible');
  }
}

// ── Sense ─────────────────────────────────────────────────────────────────────
function sense(f) {
  const lovers  = flies.filter(q => q.type==='lover');
  const enemies = flies.filter(q => q.type==='enemy');
  const friends = flies.filter(q => q.type==='friend');

  const nearL = lovers.sort ((a,b) => dist(f,a)-dist(f,b))[0];
  const nearE = enemies.sort((a,b) => dist(f,a)-dist(f,b))[0];
  const nearFr= friends.sort((a,b) => dist(f,a)-dist(f,b))[0];

  const dl  = nearL  ? dist(f,nearL)  : 999;
  const de  = nearE  ? dist(f,nearE)  : 999;
  const dFr = nearFr ? dist(f,nearFr) : 999;

  const inDrama   = bads.some(q => dist(f,q) < 102);
  const enemyNear = de < 150;
  const isLover   = !enemyNear && dl < 125;
  // Friend is "near" when within 115px and no enemy/lover dominates
  const friendNear = !enemyNear && !isLover && dFr < 115;

  // Social signal priority: enemy > lover > friend (calm baseline drive)
  let social;
  if (enemyNear) {
    social = clamp((150-de)/115, 0, 1);
  } else if (isLover) {
    social = clamp((125-dl)/125*0.95, 0, 1);
  } else if (friendNear) {
    // Honest: no dedicated friendship neuron in fly biology; provides a calm baseline drive (~0.24-0.30)
    // to P1 circuit producing low/baseline firing (~18-24%) instead of staying flat
    social = clamp((120-dFr)/120 * 0.10 + 0.22, 0.22, 0.30);
  } else {
    social = 0;
  }

  return {
    social,
    threat     : enemyNear ? clamp((150-de)/105,0,1) : 0,
    food       : foods.some(q => dist(f,q)<70) ? 1 : 0,
    sad        : inDrama,
    friendNear,
    isLover,
    nearL, nearE, nearFr,
    dl, de, dFr
  };
}

// ── Dominant emotion ──────────────────────────────────────────────────────────
// Priority: angry > love > sad > happy > chill > calm
function dominant(r, friendNear) {
  if (friendNear && r.angry === 0) return 'chill';
  let k='calm', v=.2;
  for (const q of ['sad','happy','love','angry'])
    if (r[q] > v) { k=q; v=r[q]; }
  if (k==='calm' && friendNear) k='chill';
  return k;
}

// ── Copy text per state ───────────────────────────────────────────────────────
function words(s) {
  return {
    calm  : ['Fly A is just chilling \u2728',            'No dominant circuit is firing',                          'P1 circuit: baseline',                              'explore the arena'],
    love  : ['Fly A is currently smitten \uD83D\uDC98',  'Lover proximity sensor fired',                          'P1 group, low/mid drive \u2192 love-leaning',        'orient and flutter closer'],
    angry : ['Fly A is throwing hands \uD83E\uDD4A',     'Enemy proximity sensor fired',                          'P1 group, high drive \u2192 angry-leaning',          'brace and evade the lunge'],
    chill : ['Fly A is vibing with Friend \uD83D\uDE0C', 'Friend proximity sensor fired \u2014 calm social cue',   'P1 circuit: calm social presence (~20% baseline)',  'hold comfortable proximity'],
    happy : ['Fly A found a snack! \uD83C\uDF89',        'Snack reached \u2192 reward-like signal \u2192 P1 low/mid', 'P1 group, food drive \u2192 calm/positive-leaning', 'linger and reinforce this spot'],
    sad   : ['Fly A is stressed out \uD83D\uDE2C',       'Drama zone detected \u2192 stress response \u2192 P1',  'P1 group, arousal drive \u2192 angry-leaning',      'escape and avoid this area'],
  }[s];
}

// ── State change ──────────────────────────────────────────────────────────────
function change(s) {
  player.state = s;
  player.history.unshift(s.toUpperCase());
  player.history = player.history.slice(0,3);
  player.last = time;
  triggerCascade(s); // Initiate staged circuit cascade immediately

  if (s==='love'||s==='angry') {
    p1Flash = 10;
    spawnFloatie(s==='love' ? '\uD83D\uDC98' : '\uD83D\uDCA2', player.x, player.y);
  } else if (s==='chill') {
    spawnFloatie('\uD83D\uDE0C', player.x, player.y);
  } else if (s==='happy') {
    p1Flash = 6;
    spawnFloatie('\uD83C\uDF89', player.x, player.y);
  } else if (s==='sad') {
    p1Flash = 8;
    spawnFloatie('\uD83D\uDE2C', player.x, player.y);
  }

  const e = { state:s, parts:words(s), rates:{...player.brain.r} };
  events.push(e);
  lastLive = e;
  if (!replaying) trace(e, false);
}

// ── Causal trace panel ────────────────────────────────────────────────────────
function trace(e, replay) {
  document.querySelector('#traceMode').textContent = replay ? 'REPLAY' : 'LIVE';
  const el = document.querySelector('#explanation');
  el.style.borderColor = C[e.state] || C.calm;
  el.innerHTML = `
    <p><strong>FLY A \u00B7 ${e.state.toUpperCase()}${replay?' \u00B7 REPLAY':''}</strong></p>
    <p>01 \u00B7 ${e.parts[0]}</p>
    <p>02 \u00B7 ${e.parts[1]} \u2192 <strong>${e.parts[2]}</strong></p>
    <p>03 \u00B7 Motor choice: <strong>${e.parts[3]}</strong></p>`;
}

// ── Movement ──────────────────────────────────────────────────────────────────
function movePlayer() {
  let dx=(keys.KeyD||keys.ArrowRight?1:0)-(keys.KeyA||keys.ArrowLeft?1:0);
  let dy=(keys.KeyS||keys.ArrowDown ?1:0)-(keys.KeyW||keys.ArrowUp   ?1:0);
  if (dx||dy) {
    const l=Math.hypot(dx,dy); dx/=l; dy/=l;
    player.vx += (dx*155-player.vx)*.2;
    player.vy += (dy*155-player.vy)*.2;
  } else {
    player.vx*=.8; player.vy*=.8;
  }
  player.x = clamp(player.x+player.vx*dt, 18, W-18);
  player.y = clamp(player.y+player.vy*dt, 18, H-18);
  if (player.vx||player.vy) player.h = Math.atan2(player.vy, player.vx);
}

function moveNPC(f) {
  const D = dist(f, player);
  let v = unit(f, player);
  let speed = 50;

  if (f.type === 'lover') {
    // Orbits: backs off when close, approaches when far
    v = D>100 ? unit(f,player) : {x:-v.x, y:-v.y};
    speed = 42;
  } else if (f.type === 'enemy') {
    // Chases aggressively
    speed = D<155 ? 145 : 82;
  } else if (f.type === 'friend') {
    // Gentle orbit at comfortable distance (~110px)
    if (D > 140) {
      // Approach
      speed = 38;
    } else if (D < 75) {
      // Back off
      v = {x:-v.x, y:-v.y};
      speed = 28;
    } else {
      // Orbit tangentially (perpendicular to radial vector)
      const mag = D || 1;
      v = {x:-(f.y-player.y)/mag, y:(f.x-player.x)/mag};
      speed = 30;
    }
  }

  f.vx += (v.x*speed-f.vx)*.09;
  f.vy += (v.y*speed-f.vy)*.09;
  f.x = clamp(f.x+f.vx*dt, 18, W-18);
  f.y = clamp(f.y+f.vy*dt, 18, H-18);
  f.h = Math.atan2(f.vy, f.vx);
}

function separate() {
  for (let i=0;i<flies.length;i++)
    for (let j=i+1;j<flies.length;j++) {
      const a=flies[i],b=flies[j],D=dist(a,b);
      const minD = a.r + b.r + 12; // 12px clear visual gap between flies
      if (D<minD) {
        const v=unit(a,b),p=(minD-D)/2;
        a.x-=v.x*p; a.y-=v.y*p; b.x+=v.x*p; b.y+=v.y*p;
      }
    }
}

function separateVisual() {
  for (const f of flies) {
    if (f.type === 'player') continue; // Player must freely walk onto snacks and into drama zones
    for (const z of [...foods,...bads]) {
      const visualR = z.type==='drama' ? 48 : 31;
      const gap=f.r+visualR+8;
      const D=dist(f,z);
      if (D<gap) {
        const v=unit(z,f);
        f.x=clamp(z.x+v.x*gap,28,W-28); f.y=clamp(z.y+v.y*gap,28,H-28);
      }
    }
  }
}

// ── Per-neuron afterglow update (call AFTER brain.tick) ───────────────────────
function updateNodeGlow() {
  const b = player.brain;
  [
    [nodeGlow.sensory, b.social],
    [nodeGlow.p1,      b.p1   ],
    [nodeGlow.motor,   b.motor],
  ].forEach(([gArr, lif]) => {
    lif.n.forEach((nrn, i) => {
      if (nrn.s) gArr[i] = 1.0;
      else        gArr[i] = Math.max(0, gArr[i] * GLOW_DECAY);
    });
  });
}

// ── Main tick ─────────────────────────────────────────────────────────────────
function tick() {
  if (!running && !replaying) return;
  time += dt;

  if (!replaying) {
    movePlayer();
    flies.slice(1).forEach(moveNPC);
    separate(); separateVisual();

    const s  = sense(player);
    const r  = player.brain.tick(s);
    updateNodeGlow(); // reads .s immediately after brain tick
    const st = dominant(r, s.friendNear);
    const p1pct = Math.round(player.brain.p1.rate * 100);

    // ── Diagnostic console.log on every tick (Required Debugging Step 1) ─────────
    const entityList = [
      ...flies.slice(1).map(f => `${f.type}#${f.id}@(${Math.round(f.x)},${Math.round(f.y)}) d=${dist(player,f).toFixed(1)}px`),
      ...foods.map((fd, i) => `snack#${i+1}@(${Math.round(fd.x)},${Math.round(fd.y)}) d=${dist(player,fd).toFixed(1)}px`),
      ...bads.map((bd, i) => `drama#${i+1}@(${Math.round(bd.x)},${Math.round(bd.y)}) d=${dist(player,bd).toFixed(1)}px`)
    ];
    console.log(
      `[FlyMind Tick] Fly A: (${Math.round(player.x)}, ${Math.round(player.y)}) | ` +
      `Entities: [${entityList.join(', ') || 'none'}] | ` +
      `P1: ${p1pct}% | State: ${player.state} (target: ${st}) | ` +
      `r: {love:${r.love.toFixed(2)}, angry:${r.angry.toFixed(2)}, chill:${r.chill.toFixed(2)}, happy:${r.happy.toFixed(2)}, sad:${r.sad.toFixed(2)}}`
    );

    const forceLeaveAngry = (player.state === 'angry' && s.threat < 0.15 && p1pct < 18);
    if (st !== player.state && (time-player.last > .35 || forceLeaveAngry)) change(st);
    if (p1Flash > 0) p1Flash--;

    // Loop or sustain circuit cascade while in an emotional interaction
    if (player.state !== 'calm' && player.state !== 'chill') {
      if (!cascade.active || cascade.state !== player.state || (time - cascade.startTime >= CASCADE_DURATION + 0.35)) {
        triggerCascade(player.state);
      }
    } else if (player.state === 'chill') {
      // Retrigger chill cascade with a calm 0.5s pause so the circuit continues showing transmission
      if (!cascade.active || cascade.state !== 'chill' || (time - cascade.startTime >= CASCADE_DURATION + 0.50)) {
        triggerCascade('chill');
      }
    } else {
      if (cascade.active && time - cascade.startTime >= CASCADE_DURATION) {
        cascade.active = false;
      }
    }

    flies.slice(1).forEach(f => f.brain.tick({
      social : dist(f,player)<145 ? 1 : 0,
      threat : f.type==='enemy' ? 1 : 0,
      food   : 0, sad: false, friendNear: false
    }));

    flies.forEach(f => {
      f.trail.push({x:f.x, y:f.y});
      f.trail = f.trail.slice(-16);
    });

    // Floaties tick
    floaties.forEach(fl => {
      fl.y    += fl.vy * dt;
      fl.life -= dt;
      fl.alpha = Math.max(0, fl.life/1.6);
    });
    floaties = floaties.filter(fl => fl.life>0);

    if (Math.floor(time*4) > samples.length) {
      samples.push({love:r.love, angry:r.angry});
      if (samples.length>120) samples.shift();
    }
  }

  render();
}

// ── Unified label placement (collision avoidance) ────────────────────────────
// Every entity label (flies, snacks, drama zones) is positioned here.
let labelBoxes = [];

function reserveLabel(cx, cy, text, r, isSel=false) {
  let w = 0;
  for (const ch of [...text]) w += ch.codePointAt(0) > 127 ? 14 : 7.2;
  const padX = 5, padY = 4;

  // Search concentric distance rings around entity
  const rings = [r + 14, r + 28, r + 44, r + 62, r + 84, r + 110, r + 140];
  const numAngles = 16;
  let best = null, bestOverlap = Infinity;

  // All entity visual circles to avoid covering their bodies
  const allCircles = [
    ...flies.map(f => ({ cx: f.x, cy: f.y, r: f.r })),
    ...foods.map(f => ({ cx: f.x, cy: f.y, r: 31 })),
    ...bads.map(b => ({ cx: b.x, cy: b.y, r: 48 }))
  ];

  for (const d of rings) {
    for (let i = 0; i < numAngles; i++) {
      const angleOrder = [12, 4, 0, 8, 14, 2, 6, 10, 13, 15, 1, 3, 5, 7, 9, 11];
      const a = (angleOrder[i] / numAngles) * Math.PI * 2;

      const lx = cx + Math.cos(a) * d - w / 2;
      const ly = cy + Math.sin(a) * d + 4;

      const bx1 = lx - padX, by1 = ly - 11 - padY, bx2 = lx + w + padX, by2 = ly + (isSel ? 13 : 3) + padY;
      if (bx1 < 4 || bx2 > W - 4 || by1 < 14 || by2 > H - 4) continue;

      let totalOverlap = 0;
      // Overlap against already reserved label boxes
      for (const p of labelBoxes) {
        const ox = Math.max(0, Math.min(bx2, p.bx2) - Math.max(bx1, p.bx1));
        const oy = Math.max(0, Math.min(by2, p.by2) - Math.max(by1, p.by1));
        if (ox > 0 && oy > 0) totalOverlap += ox * oy * 10;
      }

      // Overlap against other entity bodies
      const mx = (bx1 + bx2) / 2, my = (by1 + by2) / 2;
      for (const ent of allCircles) {
        if (Math.abs(ent.cx - cx) < 2 && Math.abs(ent.cy - cy) < 2) continue; // skip own center
        const ed = Math.hypot(mx - ent.cx, my - ent.cy);
        if (ed < ent.r + 6) totalOverlap += (ent.r + 6 - ed) * 8;
      }

      if (totalOverlap === 0) {
        best = { lx, ly, bx1, by1, bx2, by2 };
        bestOverlap = 0;
        break;
      }

      if (totalOverlap < bestOverlap) {
        bestOverlap = totalOverlap;
        best = { lx, ly, bx1, by1, bx2, by2 };
      }
    }
    if (bestOverlap === 0) break;
  }

  if (!best) {
    const lx = Math.max(4, Math.min(W - w - 4, cx - w/2));
    const ly = Math.max(14, Math.min(H - 4, cy - r - 14));
    best = { lx, ly, bx1: lx-padX, by1: ly-11-padY, bx2: lx+w+padX, by2: ly+(isSel?13:3)+padY };
  }

  labelBoxes.push(best);
  return { x: best.lx, y: best.ly };
}

// ── Draw a single fly ─────────────────────────────────────────────────────────
function drawFly(f, p) {
  const color = FLY_COL[f.type] || '#805ee1';
  const isSel = (f===selectedFly);

  x.save();
  x.translate(f.x, f.y);

  // Selection ring
  if (isSel) {
    x.beginPath(); x.arc(0,0,f.r+10,0,Math.PI*2);
    x.strokeStyle='#fffb00'; x.lineWidth=3; x.setLineDash([6,4]);
    x.stroke(); x.setLineDash([]);
  }

  x.fillStyle=color; x.strokeStyle='#432c4a'; x.lineWidth=3;

  if (f.type==='player') {
    // Wings
    x.beginPath(); x.ellipse(-9,-11,13,8,-.5,0,7); x.fill();
    x.beginPath(); x.ellipse(-9, 11,13,8, .5,0,7); x.fill();
    // Body
    x.beginPath(); x.ellipse(3,0,15,11,0,0,7); x.fill(); x.stroke();
    // Eyes
    x.fillStyle='#fff8ed';
    x.beginPath(); x.arc(9,-3,2,0,7); x.arc(9,3,2,0,7); x.fill();

  } else if (f.type==='lover') {
    // Heart
    x.beginPath();
    x.moveTo(0,18);
    x.bezierCurveTo(-34,-3,-10,-28,0,-10);
    x.bezierCurveTo(10,-28,34,-3,0,18);
    x.fill(); x.stroke();
    x.fillStyle='#fff8ed'; x.font='18px Arial';
    x.textAlign='center'; x.fillText('\u2665',0,6);

  } else if (f.type==='enemy') {
    // Rotating star — counter-rotate text so '!' stays upright
    x.rotate(f.h);
    x.beginPath();
    for (let i=0;i<12;i++) {
      const rad=i%2?12:23, a=i*Math.PI/6;
      x.lineTo(Math.cos(a)*rad, Math.sin(a)*rad);
    }
    x.closePath(); x.fill(); x.stroke();
    x.rotate(-f.h); // counter-rotate
    x.fillStyle='#fff8ed'; x.font='bold 16px Arial';
    x.textAlign='center'; x.fillText('!',0,6);

  } else {
    // Friend — smiley circle
    x.beginPath(); x.arc(0,0,17,0,Math.PI*2); x.fill(); x.stroke();
    x.fillStyle='#fff8ed';
    // Eyes
    x.beginPath(); x.arc(-5,-5,2.5,0,Math.PI*2); x.fill();
    x.beginPath(); x.arc( 5,-5,2.5,0,Math.PI*2); x.fill();
    // Smile
    x.beginPath(); x.arc(0,2,7,0.18,Math.PI-0.18);
    x.strokeStyle='#fff8ed'; x.lineWidth=2.5; x.stroke();
  }

  x.restore();

  // External label
  x.fillStyle=color; x.font='bold 11px DM Mono'; x.textAlign='left';
  const label = f.type==='player' ? 'FLY A \u00B7 YOU'
              : f.type==='lover'  ? 'LOVER \uD83D\uDC98'
              : f.type==='enemy'  ? 'ENEMY \uD83D\uDE20'
              :                     'FRIEND \uD83D\uDE0A';
  x.fillText(label, p.x, p.y);
  if (isSel) {
    x.fillStyle='#fffb00'; x.font='bold 9px DM Mono';
    x.fillText('[DEL] to remove', p.x, p.y+13);
  }
}

// ── Main render ───────────────────────────────────────────────────────────────
function render() {
  // Arena background
  x.clearRect(0,0,W,H);
  x.fillStyle='#ffe7c8'; x.fillRect(0,0,W,H);

  // ── Unified label placement pre-pass ─────────────────────────────────────────
  labelBoxes = [];
  const flyLabelPos = flies.map(f => {
    const text = f.type==='player' ? 'FLY A \u00B7 YOU'
               : f.type==='lover'  ? 'LOVER \uD83D\uDC98'
               : f.type==='enemy'  ? 'ENEMY \uD83D\uDE20'
               :                     'FRIEND \uD83D\uDE0A';
    return reserveLabel(f.x, f.y, text, f.r, f === selectedFly);
  });
  const foodLabelPos = foods.map(f => reserveLabel(f.x, f.y, 'SNACK \uD83C\uDF53', 31));
  const badLabelPos  = bads.map(b => reserveLabel(b.x, b.y, 'DRAMA ZONE', 48));

  // Food
  foods.forEach((q, i) => {
    x.fillStyle='#c9f0d9'; x.beginPath(); x.arc(q.x,q.y,31,0,7); x.fill();
    x.fillStyle='#40b981'; x.beginPath(); x.arc(q.x,q.y+3,19,0,7); x.fill();
    x.fillStyle='#fff8ed'; x.beginPath(); x.arc(q.x-7,q.y,4,0,7); x.arc(q.x+7,q.y,4,0,7); x.fill();
    x.fillStyle='#287d59'; x.beginPath(); x.ellipse(q.x+7,q.y-19,8,4,-.6,0,7); x.fill();
    const lp = foodLabelPos[i];
    x.fillStyle='#287d59'; x.font='bold 10px DM Mono'; x.textAlign='left';
    x.fillText('SNACK \uD83C\uDF53', lp.x, lp.y);
  });

  // Drama zones
  bads.forEach((q, i) => {
    x.fillStyle='#e1d8ff'; x.beginPath(); x.arc(q.x,q.y,48,0,7); x.fill();
    x.strokeStyle='#8c6be8'; x.lineWidth=3; x.setLineDash([6,5]);
    x.beginPath(); x.arc(q.x,q.y,43,0,7); x.stroke(); x.setLineDash([]);
    x.fillStyle='#8c6be8'; x.beginPath(); x.arc(q.x,q.y,25,0,7); x.fill();
    x.fillStyle='#fff8ed'; x.font='bold 22px Arial'; x.textAlign='center';
    x.fillText('\u2620',q.x,q.y+8);
    const lp = badLabelPos[i];
    x.fillStyle='#674fb2'; x.font='bold 10px DM Mono'; x.textAlign='left';
    x.fillText('DRAMA ZONE', lp.x, lp.y);
  });

  // Trails
  flies.forEach(f => {
    x.strokeStyle = (FLY_COL[f.type]||'#805ee1') + '33';
    x.lineWidth=2; x.beginPath();
    f.trail.forEach((p,j) => j ? x.lineTo(p.x,p.y) : x.moveTo(p.x,p.y));
    x.stroke();
  });

  // Flies
  flies.forEach((f,i) => drawFly(f, flyLabelPos[i]));

  // Floaties
  floaties.forEach(fl => {
    x.save(); x.globalAlpha=fl.alpha;
    x.font='26px Arial'; x.textAlign='center';
    x.fillText(fl.emoji, fl.x, fl.y);
    x.restore();
  });

  // UI panels
  callout();
  telemetry();
  syncTraceColor();
  drawNeuronGraph();
  drawChart();
}

// ── Simple callout ────────────────────────────────────────────────────────────
const CALLOUT_BG = {
  calm  : 'linear-gradient(105deg,#633d66,#a35a7e)',
  love  : 'linear-gradient(105deg,#8c1f5e,#e05590)',
  angry : 'linear-gradient(105deg,#7a1d1d,#c94040)',
  chill : 'linear-gradient(105deg,#1a5f54,#52b8a0)',
  happy : 'linear-gradient(105deg,#1d6b43,#40b981)',
  sad   : 'linear-gradient(105deg,#2d3a6b,#5a6ee8)',
};
const CALLOUT_AVATAR = {
  calm:'\uD83E\uDEB0', love:'\uD83D\uDC98', angry:'\uD83E\uDD4A',
  chill:'\uD83D\uDE0C', happy:'\uD83C\uDF89', sad:'\uD83D\uDE30'
};

// ── Live unified P1 status helper (prevents contradictory UI text) ───────────
function getLiveP1Status(state, p1pct) {
  if (state === 'angry') return `P1 group, high drive (${p1pct}%) \u2192 angry-leaning`;
  if (state === 'love')  return `P1 group, low/mid drive (${p1pct}%) \u2192 love-leaning`;
  if (state === 'chill') return `P1 circuit, calm social presence (${p1pct}%) \u2192 neutral baseline`;
  if (state === 'happy') return `P1 group, food reward drive (${p1pct}%) \u2192 appetitive-leaning`;
  if (state === 'sad')   return `P1 group, stress arousal drive (${p1pct}%) \u2192 escape-leaning`;
  if (p1pct < 15)        return `P1 circuit: baseline resting (${p1pct}%)`;
  return `P1 circuit: transient drive (${p1pct}%)`;
}

function callout() {
  const p1pct = Math.round(player.brain.p1.rate * 100);
  const statusDesc = getLiveP1Status(player.state, p1pct);
  const p  = words(player.state);
  const el = document.querySelector('#callout');
  el.style.background = CALLOUT_BG[player.state] || CALLOUT_BG.calm;
  document.querySelector('.avatar').textContent         = CALLOUT_AVATAR[player.state];
  document.querySelector('#calloutTitle').textContent   = p[0];
  document.querySelector('#calloutSub').textContent     = 'Circuit: '+statusDesc+'. Motor: '+p[3]+'.';
}

// ── Telemetry ─────────────────────────────────────────────────────────────────
function telemetry() {
  const col = C[player.state] || C.calm;
  document.querySelector('#telemetry').innerHTML = `
    <div class="metric"><small>DOMINANT</small><b style="color:${col}">${player.state.toUpperCase()}</b></div>
    <div class="metric"><small>HISTORY</small><b>${player.history.join(' \u2192 ')}</b></div>
    <div class="metric"><small>P1 DRIVE</small><b>${player.brain.p1.rate.toFixed(2)}</b></div>
    <div class="metric"><small>MOTOR</small><b>${player.brain.motor.rate.toFixed(2)}</b></div>`;
}

// ── Build node position map (called once after circuitData loads) ──────────────
function buildNodePos() {
  if (!circuitData || nodePos) return;
  nodePos = {};
  const groupX = {sensory:52, p1:160, motor:268};
  ['sensory','p1','motor'].forEach(g => {
    const ns = circuitData.neurons.filter(n => n.group===g);
    ns.forEach((n,i) => {
      nodePos[n.id] = {
        x    : groupX[g],
        y    : 24 + i * (NGH-48) / (ns.length-1||1),
        group: g,
        idx  : i,
      };
    });
  });
}

// ── Bézier curve math & signal pulse renderer ─────────────────────────────────
function getBezierPoint(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const mt2 = mt * mt, mt3 = mt2 * mt;
  const t2 = t * t, t3 = t2 * t;
  return {
    x: mt3 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x,
    y: mt3 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y
  };
}

function drawPartialCurve(ctx, p0, p1, p2, p3, t) {
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  const steps = Math.max(3, Math.round(t * 22));
  for (let s = 1; s <= steps; s++) {
    const pt = getBezierPoint(p0, p1, p2, p3, (s / steps) * t);
    ctx.lineTo(pt.x, pt.y);
  }
  ctx.stroke();
}

function drawSignalDot(ctx, pt, color) {
  // Outer soft glow aura
  const gr = ctx.createRadialGradient(pt.x, pt.y, 1, pt.x, pt.y, 7.5);
  gr.addColorStop(0, '#ffffff');
  gr.addColorStop(0.35, color);
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gr;
  ctx.beginPath(); ctx.arc(pt.x, pt.y, 7.5, 0, Math.PI * 2); ctx.fill();

  // Solid bright core
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2); ctx.fill();
}

// ── Sequential circuit cascade controller (Fix 2: staged 1.4s cascade) ─────────
// Stages with deliberate pauses:
// - Stage 1 (0.00s - 0.45s): Sensory neurons light up and hold (~450ms)
// - Stage 2 (0.45s - 0.90s): Active Sensory->P1 lines trace with traveling dots (~450ms) -> P1 lights up
// - Stage 3 (0.90s - 1.35s): Active P1->Motor lines trace with traveling dots (~450ms) -> Motor lights up
const CASCADE_DURATION = 1.35;
const T_SENSORY_HOLD = 0.45;
const T_P1_HOLD      = 0.90;
const T_MOTOR_BURST  = 1.35;

const cascade = {
  active: false,
  state: 'calm',
  startTime: 0,
  sensoryIds: [],
  p1Ids: [],
  motorIds: [],
  stage1Pairs: [], // [pre, post]
  stage2Pairs: [], // [pre, post]
};

function triggerCascade(st) {
  if (st === 'calm') {
    cascade.active = false;
    cascade.state = 'calm';
    return;
  }
  cascade.active = true;
  cascade.state = st;
  cascade.startTime = time;

  if (st === 'love') {
    cascade.sensoryIds = ['S1', 'S2'];
    cascade.p1Ids      = ['P1a', 'P1b', 'P1e'];
    cascade.motorIds   = ['M1', 'M2'];
    cascade.stage1Pairs = [['S1','P1b'], ['S2','P1a']];
    cascade.stage2Pairs = [['P1a','P1e'], ['P1b','P1e'], ['P1e','M1'], ['P1e','M2']];
  } else if (st === 'angry') {
    cascade.sensoryIds = ['S3', 'S4'];
    cascade.p1Ids      = ['P1c', 'P1d', 'P1e'];
    cascade.motorIds   = ['M3', 'M4'];
    cascade.stage1Pairs = [['S3','P1c'], ['S4','P1c']];
    cascade.stage2Pairs = [['P1c','P1d'], ['P1d','P1e'], ['P1e','M3'], ['P1c','M4']];
  } else if (st === 'happy') {
    cascade.sensoryIds = ['S1', 'S2'];
    cascade.p1Ids      = ['P1a', 'P1e'];
    cascade.motorIds   = ['M1', 'M3'];
    cascade.stage1Pairs = [['S2','P1a']];
    cascade.stage2Pairs = [['P1a','P1e'], ['P1e','M1'], ['P1e','M3']];
  } else if (st === 'sad') {
    cascade.sensoryIds = ['S3', 'S4'];
    cascade.p1Ids      = ['P1c', 'P1e'];
    cascade.motorIds   = ['M3', 'M4'];
    cascade.stage1Pairs = [['S3','P1c']];
    cascade.stage2Pairs = [['P1c','P1e'], ['P1e','M4']];
  } else if (st === 'chill') {
    cascade.sensoryIds = ['S4'];
    cascade.p1Ids      = ['P1d', 'P1c'];
    cascade.motorIds   = ['M4'];
    cascade.stage1Pairs = [['S4','P1d'], ['S4','P1c']];
    cascade.stage2Pairs = [['P1c','M4']];
  }
}

// ── Node-and-wire neuron graph ─────────────────────────────────────────────────
function drawNeuronGraph() {
  // Always update P1 activity summary text so it never lags or contradicts
  const p1pct = Math.round(player.brain.p1.rate * 100);
  const statusDesc = getLiveP1Status(player.state, p1pct);
  const nm = document.querySelector('#neuronMeaning');
  if (nm) nm.textContent = `P1 circuit is ${p1pct}% active \u2192 ${statusDesc}.`;

  buildNodePos();

  ng.clearRect(0,0,NGW,NGH);
  ng.fillStyle='#fff4ee'; ng.fillRect(0,0,NGW,NGH);

  // Fallback when data not loaded yet
  if (!nodePos || !circuitData) {
    ng.fillStyle='#c09890'; ng.font='11px Fredoka'; ng.textAlign='center';
    ng.fillText('Loading circuit map\u2026', NGW/2, NGH/2);
    return;
  }

  const curState = cascade.active ? cascade.state : player.state;
  const stColor  = C[curState] || C.calm;
  const t_e      = cascade.active ? (time - cascade.startTime) : 999;

  // Active edge lookups
  const isStage1 = (pre, post) => cascade.active && cascade.stage1Pairs.some(p => p[0]===pre && p[1]===post);
  const isStage2 = (pre, post) => cascade.active && cascade.stage2Pairs.some(p => p[0]===pre && p[1]===post);

  // Helper for Bézier control points
  function getEdgePts(syn) {
    const a = nodePos[syn.pre], b = nodePos[syn.post];
    if (!a || !b) return null;
    if (a.group === b.group) {
      const side = a.group==='p1' ? 36 : 28;
      return { p0: {x:a.x, y:a.y}, p1: {x:a.x+side, y:a.y}, p2: {x:b.x+side, y:b.y}, p3: {x:b.x, y:b.y} };
    } else {
      const cpx = (a.x + b.x) * 0.5;
      return { p0: {x:a.x, y:a.y}, p1: {x:cpx, y:a.y}, p2: {x:cpx, y:b.y}, p3: {x:b.x, y:b.y} };
    }
  }

  // ── PASS 1: Dim/fade ALL connection lines that are NOT active ────────────────
  // (Requirement 2: only active paths stand out)
  circuitData.synapses.forEach(syn => {
    if (isStage1(syn.pre, syn.post) || isStage2(syn.pre, syn.post)) return;
    const pts = getEdgePts(syn);
    if (!pts) return;
    ng.strokeStyle = 'rgba(215,188,178,0.14)';
    ng.lineWidth   = 0.75;
    ng.shadowBlur  = 0;
    ng.beginPath();
    ng.moveTo(pts.p0.x, pts.p0.y);
    ng.bezierCurveTo(pts.p1.x, pts.p1.y, pts.p2.x, pts.p2.y, pts.p3.x, pts.p3.y);
    ng.stroke();
  });

  // ── PASS 2: Animate ACTIVE Stage 1 lines (Sensory -> P1) ─────────────────────
  // (Requirement 1b: lines draw themselves over ~450ms with traveling signal dot)
  if (cascade.active) {
    let u = 0;
    if (t_e >= T_SENSORY_HOLD && t_e < T_P1_HOLD) {
      u = (t_e - T_SENSORY_HOLD) / (T_P1_HOLD - T_SENSORY_HOLD);
    } else if (t_e >= T_P1_HOLD) {
      u = 1.0;
    }

    if (u > 0) {
      circuitData.synapses.forEach(syn => {
        if (!isStage1(syn.pre, syn.post)) return;
        const pts = getEdgePts(syn);
        if (!pts) return;
        ng.strokeStyle = stColor;
        ng.lineWidth   = 2.8;
        ng.shadowColor = stColor;
        ng.shadowBlur  = 10;
        drawPartialCurve(ng, pts.p0, pts.p1, pts.p2, pts.p3, u);
        ng.shadowBlur  = 0;

        // Requirement 3: Moving signal dot traveling along the wire
        if (u < 1.0) {
          const dotPt = getBezierPoint(pts.p0, pts.p1, pts.p2, pts.p3, u);
          drawSignalDot(ng, dotPt, stColor);
        }
      });
    }

    // ── PASS 3: Animate ACTIVE Stage 2 lines (P1 internal & P1 -> Motor) ────────
    // (Requirement 1c: repeats draw-then-light pattern from P1 to motor over ~450ms)
    let v = 0;
    if (t_e >= T_P1_HOLD && t_e < T_MOTOR_BURST) {
      v = (t_e - T_P1_HOLD) / (T_MOTOR_BURST - T_P1_HOLD);
    } else if (t_e >= T_MOTOR_BURST) {
      v = 1.0;
    }

    if (v > 0) {
      circuitData.synapses.forEach(syn => {
        if (!isStage2(syn.pre, syn.post)) return;
        const pts = getEdgePts(syn);
        if (!pts) return;
        ng.strokeStyle = stColor;
        ng.lineWidth   = 2.8;
        ng.shadowColor = stColor;
        ng.shadowBlur  = 10;
        drawPartialCurve(ng, pts.p0, pts.p1, pts.p2, pts.p3, v);
        ng.shadowBlur  = 0;

        // Moving signal dot traveling along the P1 -> Motor wire
        if (v < 1.0) {
          const dotPt = getBezierPoint(pts.p0, pts.p1, pts.p2, pts.p3, v);
          drawSignalDot(ng, dotPt, stColor);
        }
      });
    }
  }

  // ── Column headers ──────────────────────────────────────────────────────────
  ng.fillStyle='#b08880'; ng.font='bold 7.5px DM Mono'; ng.textAlign='center';
  ng.fillText('SENSORY', 52,  11);
  ng.fillText('P1 CIRCUIT', 160, 11);
  ng.fillText('MOTOR',   268, 11);

  // ── Draw nodes with staged lighting ─────────────────────────────────────────
  const NODE_R = 8;
  circuitData.neurons.forEach(n => {
    const p = nodePos[n.id];
    if (!p) return;

    let glow = 0;
    if (cascade.active) {
      if (n.group === 'sensory' && cascade.sensoryIds.includes(n.id)) {
        if (t_e < T_SENSORY_HOLD) {
          glow = Math.min(1.0, t_e / 0.15); // ramp up and hold 450ms (Requirement 1a)
        } else if (t_e < T_P1_HOLD) {
          glow = 1.0;                       // hold while wire draws
        } else {
          glow = Math.max(0.25, 1.0 - (t_e - T_P1_HOLD) / 0.6); // gentle fade
        }
      } else if (n.group === 'p1' && cascade.p1Ids.includes(n.id)) {
        if (t_e < T_SENSORY_HOLD + 0.22) {
          glow = 0; // waiting for wire arrival
        } else if (t_e < T_P1_HOLD) {
          glow = (t_e - (T_SENSORY_HOLD + 0.22)) / (T_P1_HOLD - (T_SENSORY_HOLD + 0.22));
        } else if (t_e < T_MOTOR_BURST) {
          glow = 1.0; // hold while P1 -> Motor wire draws
        } else {
          glow = Math.max(0.3, 1.0 - (t_e - T_MOTOR_BURST) / 0.5);
        }
      } else if (n.group === 'motor' && cascade.motorIds.includes(n.id)) {
        if (t_e < T_P1_HOLD + 0.22) {
          glow = 0; // waiting for motor wire arrival
        } else if (t_e < T_MOTOR_BURST) {
          glow = (t_e - (T_P1_HOLD + 0.22)) / (T_MOTOR_BURST - (T_P1_HOLD + 0.22));
        } else {
          glow = Math.max(0.4, 1.0 - (t_e - T_MOTOR_BURST) / 0.4); // hold burst glow
        }
      }
    }

    const base = n.group==='sensory' ? '#e98971'
               : n.group==='p1'      ? '#ff5c9a'
               :                       '#7856cf';

    // Outer glow halo for active firing neurons
    if (glow > 0.05) {
      const haloR = NODE_R + 5 + glow * 7;
      const gr = ng.createRadialGradient(p.x, p.y, NODE_R * 0.5, p.x, p.y, haloR);
      gr.addColorStop(0, hexToRgba(stColor, glow * 0.7));
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      ng.beginPath(); ng.arc(p.x, p.y, haloR, 0, Math.PI * 2);
      ng.fillStyle = gr; ng.fill();
    }

    // Node body
    ng.beginPath(); ng.arc(p.x, p.y, NODE_R, 0, Math.PI*2);
    ng.fillStyle = glow > 0.05 ? blendHex(base, stColor, glow * 0.8) : base + '55';
    ng.fill();
    ng.strokeStyle = glow > 0.2 ? '#432c4a88' : '#432c4a22';
    ng.lineWidth = glow > 0.2 ? 1.5 : 1;
    ng.stroke();

    // Node label below
    ng.fillStyle  = glow > 0.2 ? '#432c4a' : '#b0948e';
    ng.font       = (glow > 0.2 ? 'bold ' : '') + '6.5px DM Mono';
    ng.textAlign  = 'center';
    ng.fillText(n.label, p.x, p.y + NODE_R + 8);
  });

}

// Live-sync trace panel border color and text every frame to match live state
function syncTraceColor() {
  const el = document.querySelector('#explanation');
  if (el && !replaying) {
    el.style.borderColor = C[player.state] || C.calm;
    const p1pct = Math.round(player.brain.p1.rate * 100);
    const statusDesc = getLiveP1Status(player.state, p1pct);
    const p = words(player.state);
    el.innerHTML = `
      <p><strong>FLY A \u00B7 ${player.state.toUpperCase()} \u00B7 LIVE</strong></p>
      <p>01 \u00B7 ${p[0]}</p>
      <p>02 \u00B7 ${p[1]} \u2192 <strong>${statusDesc}</strong></p>
      <p>03 \u00B7 Motor choice: <strong>${p[3]}</strong></p>`;
  }
}

// ── Spike-rate chart (P1 love / angry only) ────────────────────────────────────
function drawChart() {
  const w=chart.width, h=chart.height;
  cx.clearRect(0,0,w,h);
  for (let i=1;i<4;i++) {
    cx.strokeStyle='#efd8cc'; cx.beginPath();
    cx.moveTo(0,i*h/4); cx.lineTo(w,i*h/4); cx.stroke();
  }
  for (const [k,c] of [['love',C.love],['angry',C.angry]]) {
    cx.beginPath();
    samples.forEach((s,i) => i
      ? cx.lineTo(i*w/(samples.length-1||1), h-9-s[k]*(h-18))
      : cx.moveTo(i*w/(samples.length-1||1), h-9-s[k]*(h-18))
    );
    cx.strokeStyle=c; cx.lineWidth=2; cx.stroke();
  }
}

// ── Hover tip ─────────────────────────────────────────────────────────────────
function setTip(e) {
  const r=arena.getBoundingClientRect();
  const p={x:(e.clientX-r.left)*W/r.width, y:(e.clientY-r.top)*H/r.height};
  const all=[...flies,...foods,...bads];
  const hit=all.find(q => dist(p,q)<(q.r||25)+12);
  let t='Hover a character, snack, or drama zone';
  if (hit) t = hit.type==='player' ? 'This is you \u2014 move with WASD or arrow keys.'
             : hit.type==='lover'  ? 'Lover \uD83D\uDC98 \u2014 get close to trigger Love (P1 low/mid). Click to select.'
             : hit.type==='enemy'  ? 'Enemy \uD83D\uDE20 \u2014 get close to trigger Anger; it chases back. Click to select.'
             : hit.type==='friend' ? 'Friend \uD83D\uDE0A \u2014 gentle social presence, keeps P1 calm. Click to select.'
             : hit.type==='food'   ? 'Snack \uD83C\uDF53 \u2014 touch it! Reward signal fires P1 \u2192 calm/positive-leaning.'
             :                       'Drama zone \u2620 \u2014 enter it! Stress signal fires P1 \u2192 angry-leaning.';
  document.querySelector('#arenaTip').textContent = t;
  arena.style.cursor = (hit&&(hit.type==='lover'||hit.type==='enemy'||hit.type==='friend')) ? 'pointer'
                     : hit ? 'help' : 'crosshair';
}

// ── Event listeners ───────────────────────────────────────────────────────────
arena.addEventListener('pointermove', setTip);

ngCvs.addEventListener('pointermove', e => {
  if (!nodePos || !circuitData) return;
  const r = ngCvs.getBoundingClientRect();
  const mx = (e.clientX - r.left) * NGW / r.width;
  const my = (e.clientY - r.top) * NGH / r.height;
  const hit = circuitData.neurons.find(n => {
    const p = nodePos[n.id];
    return p && Math.hypot(mx - p.x, my - p.y) < 14;
  });
  if (hit) {
    ngCvs.title = `${hit.cell_type} (FlyWire Root: ${hit.root_id})\n${hit.desc}`;
  } else {
    ngCvs.title = 'FlyWire P1 Connectome Graph';
  }
});

arena.addEventListener('pointerdown', e => {
  const r=arena.getBoundingClientRect();
  const p={x:(e.clientX-r.left)*W/r.width, y:(e.clientY-r.top)*H/r.height};

  const hit = flies.find(f =>
    (f.type==='lover'||f.type==='enemy'||f.type==='friend') && dist(p,f)<f.r+14
  );
  if (hit) {
    selectedFly = (selectedFly===hit) ? null : hit;
    updateRemoveBtn(); e.preventDefault(); return;
  }
  selectedFly = null; updateRemoveBtn();

  const radius = mode === 'food' ? 31 : 48;
  const safe = getSafePosition(p.x, p.y, radius);
  if (mode==='food') foods.push({x:safe.x, y:safe.y, r:31, type:'food'});
  else               bads.push ({x:safe.x, y:safe.y, r:48, type:'drama'});
});

document.addEventListener('keydown', e => {
  if (['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) {
    keys[e.code]=true; e.preventDefault();
  }
  if ((e.key==='Delete'||e.key==='Backspace') && selectedFly) {
    removeFly(selectedFly); e.preventDefault();
  }
});
document.addEventListener('keyup', e => keys[e.code]=false);

// ── Clear board ───────────────────────────────────────────────────────────────
function clearBoard() {
  const npcCount = flies.filter(f => f.type!=='player').length;
  const itemCount = foods.length + bads.length;
  const total = npcCount + itemCount;
  // Confirm if more than 2 items placed (prevent accidental mid-demo wipe)
  if (total > 2) {
    const ok = confirm(
      `Clear board? This will remove ${npcCount > 0 ? npcCount + ' deployed fl' + (npcCount===1?'y':'ies') + (itemCount>0?' and ':'') : ''}` +
      `${itemCount > 0 ? itemCount + ' item' + (itemCount===1?'':'s') : ''} from the arena.`
    );
    if (!ok) return;
  }
  // Remove all non-player flies, all food, all drama zones
  flies  = [player];
  foods  = [];
  bads   = [];
  selectedFly = null;
  updateRemoveBtn();
  floaties = [];
  // Reset player brain and state to calm baseline
  player.brain  = new Brain();
  player.state  = 'calm';
  player.history= ['CALM'];
  player.last   = time;
  player.trail  = [];
  // Reset P1 node glow
  nodeGlow.sensory.fill(0);
  nodeGlow.p1.fill(0);
  nodeGlow.motor.fill(0);
  p1Flash = 0;
  // Show calm trace immediately
  trace({state:'calm', parts:words('calm')}, false);
}

// Buttons
document.querySelector('#lover').onclick       = () => spawn('lover');
document.querySelector('#enemy').onclick       = () => spawn('enemy');
document.querySelector('#friend').onclick      = () => spawn('friend');
document.querySelector('#removeFlyBtn').onclick= () => removeFly(selectedFly);
document.querySelector('#clearBoard').onclick  = clearBoard;
document.querySelector('#food').onclick        = () => mode='food';
document.querySelector('#bad').onclick         = () => mode='bad';

document.querySelector('#pause').onclick = e => {
  running=!running; e.target.textContent=running?'\u2161 Pause':'\u25B6 Resume';
};

document.querySelector('#replay').onclick = () => {
  if (!events.length) return;
  replaying=true; running=false; let i=0;
  const go=()=>{
    if(i>=events.length){
      replaying=false; running=true;
      if(lastLive) trace(lastLive);
      return;
    }
    const ev = events[i++];
    trace(ev, true);
    triggerCascade(ev.state);
    setTimeout(go, 1500);
  };
  go();
};

// ── Dedicated Per-Emotion Subcircuit Explorer ────────────────────────────────
const subCanvas = document.querySelector('#subcircuitCanvas');
const subCtx    = subCanvas ? subCanvas.getContext('2d') : null;
const SUB_W = 500, SUB_H = 320;

const subcircuitNodePos = {
  S1:  { x: 75,  y: 48,  group: 'sensory' },
  S2:  { x: 75,  y: 116, group: 'sensory' },
  S3:  { x: 75,  y: 184, group: 'sensory' },
  S4:  { x: 75,  y: 252, group: 'sensory' },
  P1a: { x: 250, y: 38,  group: 'p1' },
  P1b: { x: 250, y: 88,  group: 'p1' },
  P1c: { x: 250, y: 138, group: 'p1' },
  P1d: { x: 250, y: 188, group: 'p1' },
  P1e: { x: 250, y: 238, group: 'p1' },
  P1f: { x: 250, y: 288, group: 'p1' },
  M1:  { x: 425, y: 48,  group: 'motor' },
  M2:  { x: 425, y: 116, group: 'motor' },
  M3:  { x: 425, y: 184, group: 'motor' },
  M4:  { x: 425, y: 252, group: 'motor' },
};

const idToLabel = {
  S1: 'aIP1c-1', S2: 'aIP1b-1', S3: 'aIP1b-2', S4: 'aIP1b-3',
  P1a: 'aSP10a-1', P1b: 'aSP10b-1', P1c: 'aSP10a-2', P1d: 'aSP10a-3', P1e: 'aSP10a-4', P1f: 'aSP10a-5',
  M1: 'pIP14-1', M2: 'pIP14-2', M3: 'pIP14-3', M4: 'pIP14-4'
};

const idToDesc = {
  S1: 'Auditory relay interneuron (courtship pulse song)',
  S2: 'Mechanosensory relay interneuron (contact/tapping)',
  S3: 'Sensory integrator interneuron (visual/aversive cues)',
  S4: 'Antennal lobe relay interneuron (olfactory/proximity cue)',
  P1a: 'P1 hub cluster integrator (low/mid drive courtship)',
  P1b: 'P1 hub cluster integrator (recurrent integration)',
  P1c: 'P1 hub cluster integrator (high-drive aggression & stress)',
  P1d: 'P1 cluster sustainer (arousal maintenance & calm social)',
  P1e: 'P1 primary motor relay (routes P1 drive to motor commands)',
  P1f: 'P1 recurrent modulator (feedback circuit control)',
  M1: 'Descending courtship song command (wing vibration)',
  M2: 'Descending wing extension command (unilateral display)',
  M3: 'Descending steering & aggressive approach command',
  M4: 'Descending locomotor speed control (cruising & burst)'
};

const idToRoot = {
  S1: '720575940625082910', S2: '720575940628426946', S3: '720575940639325941', S4: '720575940637371992',
  P1a: '720575940613034602', P1b: '720575940625802329', P1c: '720575940636471408', P1d: '720575940627719294',
  P1e: '720575940637834301', P1f: '720575940619688688',
  M1: '720575940629514296', M2: '720575940628632057', M3: '720575940604160172', M4: '720575940620402712'
};

const SUBCIRCUITS = {
  love: {
    key: 'love',
    name: 'Love',
    emoji: '\uD83D\uDC98',
    tag: 'Courtship-leaning (low/mid P1 drive)',
    driveBadge: 'P1 drive ~35\u201348%',
    color: '#ff5c9a',
    sensoryNodes: ['S1', 'S2'],
    p1Nodes: ['P1a', 'P1b', 'P1e', 'P1f'],
    motorNodes: ['M1', 'M2'],
    stage1Edges: [['S1','P1b'], ['S2','P1a']],
    stage2Edges: [['P1a','P1b'], ['P1a','P1e'], ['P1b','P1e'], ['P1a','P1f'], ['P1e','M1'], ['P1e','M2'], ['P1a','M1'], ['P1a','M2']],
    pathSummary: 'aIP1c-1, aIP1b-1 \u2192 aSP10a-1, aSP10b-1, aSP10a-4 \u2192 pIP14-1, pIP14-2',
    behavior: 'Orient towards partner, unilateral wing extension song vibration, and focused courtship following.',
    bioBasis: 'Hoopfer et al. (2015) & Deutsch et al. (2020): Moderate P1 activation engages courtship command channels without crossing the high threshold needed for aggression.',
    verificationData: [
      { pre: 'aIP1c-1', post: 'aSP10b-1', preId: '720575940625082910', postId: '720575940625802329', synapses: 3, role: 'Song relay \u2192 P1 hub cluster' },
      { pre: 'aIP1b-1', post: 'aSP10a-1', preId: '720575940628426946', postId: '720575940613034602', synapses: 2, role: 'Mechanosensory tap \u2192 P1 hub' },
      { pre: 'aSP10a-1', post: 'aSP10b-1', preId: '720575940613034602', postId: '720575940625802329', synapses: 8, role: 'P1 recurrent hub integration' },
      { pre: 'aSP10a-1', post: 'aSP10a-4', preId: '720575940613034602', postId: '720575940637834301', synapses: 2, role: 'P1 hub \u2192 Motor command relay' },
      { pre: 'aSP10a-4', post: 'pIP14-1', preId: '720575940637834301', postId: '720575940629514296', synapses: 4, role: 'P1 relay \u2192 Courtship song command' },
      { pre: 'aSP10a-4', post: 'pIP14-2', preId: '720575940637834301', postId: '720575940628632057', synapses: 4, role: 'P1 relay \u2192 Wing extension command' },
      { pre: 'aSP10a-1', post: 'pIP14-1', preId: '720575940613034602', postId: '720575940629514296', synapses: 3, role: 'Direct P1 hub \u2192 Courtship song' }
    ]
  },
  angry: {
    key: 'angry',
    name: 'Angry',
    emoji: '\uD83E\uDD4A',
    tag: 'Aggression-leaning (high P1 drive + threat)',
    driveBadge: 'P1 drive >58%',
    color: '#ed4c4c',
    sensoryNodes: ['S3', 'S4'],
    p1Nodes: ['P1c', 'P1d', 'P1e'],
    motorNodes: ['M3', 'M4'],
    stage1Edges: [['S3','P1c'], ['S4','P1c'], ['S3','P1d']],
    stage2Edges: [['P1c','P1d'], ['P1d','P1e'], ['P1e','M3'], ['P1c','M4']],
    pathSummary: 'aIP1b-2, aIP1b-3 \u2192 aSP10a-2, aSP10a-3, aSP10a-4 \u2192 pIP14-3, pIP14-4',
    behavior: 'High-speed lunging, aggressive pursuit, turning to confront rival, evasive boxing posture.',
    bioBasis: 'Hoopfer et al. (2015): High-intensity P1 stimulation coupled with threat signals switches motor output from courtship to aggressive lunging and chasing.',
    verificationData: [
      { pre: 'aIP1b-2', post: 'aSP10a-2', preId: '720575940639325941', postId: '720575940636471408', synapses: 2, role: 'Visual threat cue \u2192 P1 hub cluster' },
      { pre: 'aIP1b-3', post: 'aSP10a-2', preId: '720575940637371992', postId: '720575940636471408', synapses: 1, role: 'Antennal contact cue \u2192 P1 hub' },
      { pre: 'aSP10a-2', post: 'aSP10a-3', preId: '720575940636471408', postId: '720575940627719294', synapses: 3, role: 'P1 hub \u2192 Arousal sustainer' },
      { pre: 'aSP10a-3', post: 'aSP10a-4', preId: '720575940627719294', postId: '720575940637834301', synapses: 3, role: 'P1 sustainer \u2192 Motor command relay' },
      { pre: 'aSP10a-4', post: 'pIP14-3', preId: '720575940637834301', postId: '720575940604160172', synapses: 3, role: 'P1 relay \u2192 Aggressive steering pursuit' },
      { pre: 'aSP10a-2', post: 'pIP14-4', preId: '720575940636471408', postId: '720575940620402712', synapses: 2, role: 'P1 hub \u2192 Fast locomotor burst speed' }
    ]
  },
  chill: {
    key: 'chill',
    name: 'Calm / Friend',
    emoji: '\uD83D\uDE0C',
    tag: 'Calm social presence (low/baseline P1 drive)',
    driveBadge: 'P1 drive ~20\u201325%',
    color: '#52b8a0',
    sensoryNodes: ['S4'],
    p1Nodes: ['P1c', 'P1d'],
    motorNodes: ['M4'],
    stage1Edges: [['S4','P1d'], ['S4','P1c']],
    stage2Edges: [['P1c','M4']],
    pathSummary: 'aIP1b-3 \u2192 aSP10a-3, aSP10a-2 \u2192 pIP14-4',
    behavior: 'Holding comfortable proximity, slow relaxed cruising, non-aggressive companion orbit.',
    bioBasis: 'Honest biological framing: No dedicated "friendship neuron" exists in Drosophila biology. Proximity provides a mild baseline drive to P1 without courtship or attack.',
    verificationData: [
      { pre: 'aIP1b-3', post: 'aSP10a-3', preId: '720575940637371992', postId: '720575940627719294', synapses: 1, role: 'Calm olfactory cue \u2192 P1 sustainer' },
      { pre: 'aIP1b-3', post: 'aSP10a-2', preId: '720575940637371992', postId: '720575940636471408', synapses: 1, role: 'Calm sensory cue \u2192 P1 hub' },
      { pre: 'aSP10a-2', post: 'pIP14-4', preId: '720575940636471408', postId: '720575940620402712', synapses: 2, role: 'P1 hub \u2192 Locomotor cruising pacing' }
    ]
  },
  happy: {
    key: 'happy',
    name: 'Happy (Snack)',
    emoji: '\uD83C\uDF89',
    tag: 'Reward-leaning sub-state of P1 (food contact)',
    driveBadge: 'P1 drive ~40\u201348%',
    color: '#40b981',
    sensoryNodes: ['S1', 'S2'],
    p1Nodes: ['P1a', 'P1e'],
    motorNodes: ['M1', 'M3'],
    stage1Edges: [['S2','P1a']],
    stage2Edges: [['P1a','P1e'], ['P1e','M1'], ['P1e','M3']],
    pathSummary: 'aIP1b-1 \u2192 aSP10a-1, aSP10a-4 \u2192 pIP14-1, pIP14-3',
    behavior: 'Linger and reinforce current location, appetitive wing flutter, calm feeding orientation.',
    bioBasis: 'Appetitive reward contact activates low/mid P1 drive without threat, reinforcing stationary feeding behaviors.',
    verificationData: [
      { pre: 'aIP1b-1', post: 'aSP10a-1', preId: '720575940628426946', postId: '720575940613034602', synapses: 2, role: 'Nutrient/touch sensor \u2192 P1 hub cluster' },
      { pre: 'aSP10a-1', post: 'aSP10a-4', preId: '720575940613034602', postId: '720575940637834301', synapses: 2, role: 'P1 hub \u2192 Motor command relay' },
      { pre: 'aSP10a-4', post: 'pIP14-1', preId: '720575940637834301', postId: '720575940629514296', synapses: 4, role: 'P1 relay \u2192 Appetitive flutter' },
      { pre: 'aSP10a-4', post: 'pIP14-3', preId: '720575940637834301', postId: '720575940604160172', synapses: 3, role: 'P1 relay \u2192 Approach maintenance' }
    ]
  },
  sad: {
    key: 'sad',
    name: 'Sad / Stressed',
    emoji: '\u2620',
    tag: 'Stress/arousal sub-state of P1 (drama zone)',
    driveBadge: 'P1 drive ~55\u201362%',
    color: '#e07a2a',
    sensoryNodes: ['S3', 'S4'],
    p1Nodes: ['P1c', 'P1e'],
    motorNodes: ['M3', 'M4'],
    stage1Edges: [['S3','P1c']],
    stage2Edges: [['P1c','P1e'], ['P1e','M3'], ['P1c','M4']],
    pathSummary: 'aIP1b-2 \u2192 aSP10a-2, aSP10a-4 \u2192 pIP14-3, pIP14-4',
    behavior: 'Aversive avoidance sprint, high-speed turning away from danger perimeter.',
    bioBasis: 'Aversive stress environment stimulates high P1 drive coupled with escape motor channels (pIP14-4 fast speed, pIP14-3 turning).',
    verificationData: [
      { pre: 'aIP1b-2', post: 'aSP10a-2', preId: '720575940639325941', postId: '720575940636471408', synapses: 2, role: 'Aversive stimulus sensor \u2192 P1 hub' },
      { pre: 'aSP10a-2', post: 'aSP10a-4', preId: '720575940636471408', postId: '720575940637834301', synapses: 1, role: 'P1 hub \u2192 Motor command relay' },
      { pre: 'aSP10a-4', post: 'pIP14-3', preId: '720575940637834301', postId: '720575940604160172', synapses: 3, role: 'P1 relay \u2192 Evasive steering turn' },
      { pre: 'aSP10a-2', post: 'pIP14-4', preId: '720575940636471408', postId: '720575940620402712', synapses: 2, role: 'P1 hub \u2192 Escape burst locomotion' }
    ]
  }
};

let selectedEmotion = 'love';
let subAnimStartTime = 0;
let subAnimActive = false;

function getSubEdgePts(preId, postId) {
  const a = subcircuitNodePos[preId], b = subcircuitNodePos[postId];
  if (!a || !b) return null;
  if (a.group === b.group) {
    const side = a.group==='p1' ? 44 : 32;
    return { p0: {x:a.x, y:a.y}, p1: {x:a.x+side, y:a.y}, p2: {x:b.x+side, y:b.y}, p3: {x:b.x, y:b.y} };
  } else {
    const cpx = (a.x + b.x) * 0.5;
    return { p0: {x:a.x, y:a.y}, p1: {x:cpx, y:a.y}, p2: {x:cpx, y:b.y}, p3: {x:b.x, y:b.y} };
  }
}

function drawSubcircuit() {
  if (!subCtx) return;
  const sc = SUBCIRCUITS[selectedEmotion];
  if (!sc) return;

  const isolateToggle = document.querySelector('#isolatePathToggle');
  const isolate = isolateToggle ? isolateToggle.checked : true;

  subCtx.clearRect(0, 0, SUB_W, SUB_H);
  subCtx.fillStyle = '#fff4ee';
  subCtx.fillRect(0, 0, SUB_W, SUB_H);

  // Column headers
  subCtx.fillStyle = '#b08880';
  subCtx.font = 'bold 8.5px DM Mono';
  subCtx.textAlign = 'center';
  subCtx.fillText('SENSORY (aIP1)', 75, 14);
  subCtx.fillText('CENTRAL P1 (aSP10)', 250, 14);
  subCtx.fillText('MOTOR COMMAND (pIP14)', 425, 14);

  const activeNodes = new Set([...sc.sensoryNodes, ...sc.p1Nodes, ...sc.motorNodes]);
  const activeStage1 = sc.stage1Edges;
  const activeStage2 = sc.stage2Edges;
  const isEdgeInSub = (pre, post) =>
    activeStage1.some(p => p[0]===pre && p[1]===post) ||
    activeStage2.some(p => p[0]===pre && p[1]===post);

  // Animation timing
  const now = performance.now();
  const elapsed = subAnimActive ? (now - subAnimStartTime) / 1000 : 999;
  const t1 = Math.min(1, Math.max(0, (elapsed - 0.25) / 0.45));
  const t2 = Math.min(1, Math.max(0, (elapsed - 0.70) / 0.45));

  // PASS 1: Non-active background wires
  if (circuitData && circuitData.synapses && !isolate) {
    circuitData.synapses.forEach(syn => {
      if (isEdgeInSub(syn.pre, syn.post)) return;
      const pts = getSubEdgePts(syn.pre, syn.post);
      if (!pts) return;
      subCtx.strokeStyle = 'rgba(215, 188, 178, 0.12)';
      subCtx.lineWidth = 0.8;
      subCtx.beginPath();
      subCtx.moveTo(pts.p0.x, pts.p0.y);
      subCtx.bezierCurveTo(pts.p1.x, pts.p1.y, pts.p2.x, pts.p2.y, pts.p3.x, pts.p3.y);
      subCtx.stroke();
    });
  }

  // PASS 2: Active Stage 1 lines (Sensory -> P1)
  activeStage1.forEach(([pre, post]) => {
    const pts = getSubEdgePts(pre, post);
    if (!pts) return;
    const progress = subAnimActive ? t1 : 1.0;
    subCtx.strokeStyle = sc.color;
    subCtx.lineWidth = 2.8;
    subCtx.shadowColor = sc.color;
    subCtx.shadowBlur = 8;
    if (progress > 0) {
      drawPartialCurve(subCtx, pts.p0, pts.p1, pts.p2, pts.p3, progress);
      if (subAnimActive && progress < 1.0) {
        const dotPt = getBezierPoint(pts.p0, pts.p1, pts.p2, pts.p3, progress);
        drawSignalDot(subCtx, dotPt, sc.color);
      }
    }
    subCtx.shadowBlur = 0;
  });

  // PASS 3: Active Stage 2 lines (P1 internal & P1 -> Motor)
  activeStage2.forEach(([pre, post]) => {
    const pts = getSubEdgePts(pre, post);
    if (!pts) return;
    const progress = subAnimActive ? t2 : 1.0;
    subCtx.strokeStyle = sc.color;
    subCtx.lineWidth = 2.8;
    subCtx.shadowColor = sc.color;
    subCtx.shadowBlur = 8;
    if (progress > 0) {
      drawPartialCurve(subCtx, pts.p0, pts.p1, pts.p2, pts.p3, progress);
      if (subAnimActive && progress < 1.0) {
        const dotPt = getBezierPoint(pts.p0, pts.p1, pts.p2, pts.p3, progress);
        drawSignalDot(subCtx, dotPt, sc.color);
      }
    }
    subCtx.shadowBlur = 0;
  });

  // PASS 4: Draw all 14 neurons
  const NODE_R = 9;
  Object.keys(subcircuitNodePos).forEach(id => {
    const p = subcircuitNodePos[id];
    const isActive = activeNodes.has(id);
    const label = idToLabel[id] || id;

    if (!isActive && isolate) {
      // Dimmed ghosted node for isolate mode
      subCtx.beginPath();
      subCtx.arc(p.x, p.y, NODE_R, 0, Math.PI * 2);
      subCtx.fillStyle = 'rgba(230, 215, 208, 0.22)';
      subCtx.fill();
      subCtx.strokeStyle = 'rgba(180, 150, 140, 0.25)';
      subCtx.lineWidth = 1;
      subCtx.setLineDash([2, 3]);
      subCtx.stroke();
      subCtx.setLineDash([]);

      subCtx.fillStyle = 'rgba(160, 135, 130, 0.35)';
      subCtx.font = '6.5px DM Mono';
      subCtx.textAlign = 'center';
      subCtx.fillText(label, p.x, p.y + NODE_R + 8);
      return;
    }

    let glow = 0;
    if (subAnimActive && isActive) {
      if (p.group === 'sensory') glow = Math.min(1, Math.max(0, elapsed / 0.3));
      else if (p.group === 'p1') glow = Math.min(1, Math.max(0, (elapsed - 0.45) / 0.3));
      else if (p.group === 'motor') glow = Math.min(1, Math.max(0, (elapsed - 0.90) / 0.3));
    } else if (isActive) {
      glow = 0.85;
    }

    const baseCol = p.group === 'sensory' ? '#e98971'
                  : p.group === 'p1'      ? '#ff5c9a'
                  :                         '#7856cf';

    // Glowing outer halo for active neurons
    if (glow > 0.05) {
      const haloR = NODE_R + 6 + glow * 5;
      const gr = subCtx.createRadialGradient(p.x, p.y, NODE_R * 0.4, p.x, p.y, haloR);
      gr.addColorStop(0, hexToRgba(sc.color, glow * 0.65));
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      subCtx.beginPath();
      subCtx.arc(p.x, p.y, haloR, 0, Math.PI * 2);
      subCtx.fillStyle = gr;
      subCtx.fill();
    }

    // Node body
    subCtx.beginPath();
    subCtx.arc(p.x, p.y, NODE_R, 0, Math.PI * 2);
    subCtx.fillStyle = isActive ? blendHex(baseCol, sc.color, glow * 0.75) : baseCol + '44';
    subCtx.fill();
    subCtx.strokeStyle = isActive ? '#432c4a' : '#432c4a33';
    subCtx.lineWidth = isActive ? 1.8 : 1;
    subCtx.stroke();

    // Node label below
    subCtx.fillStyle = isActive ? '#432c4a' : '#b0948e';
    subCtx.font = (isActive ? 'bold ' : '') + '7px DM Mono';
    subCtx.textAlign = 'center';
    subCtx.fillText(label, p.x, p.y + NODE_R + 9);
  });

  if (subAnimActive && elapsed < 1.45) {
    requestAnimationFrame(drawSubcircuit);
  } else {
    subAnimActive = false;
  }
}

function updateSubcircuitDetail(key) {
  const sc = SUBCIRCUITS[key];
  if (!sc) return;

  const totalActive = sc.sensoryNodes.length + sc.p1Nodes.length + sc.motorNodes.length;
  const countEl = document.querySelector('#activeNeuronCount');
  if (countEl) {
    countEl.textContent = `${totalActive} / 14 active (${sc.sensoryNodes.length} sensory \u00B7 ${sc.p1Nodes.length} P1 cluster \u00B7 ${sc.motorNodes.length} motor)`;
    countEl.style.color = sc.color;
  }

  const chipsEl = document.querySelector('#modeledCellTypes');
  if (chipsEl) {
    chipsEl.innerHTML = `
      <span class="chip"><strong>aIP1</strong> (${sc.sensoryNodes.map(id => idToLabel[id]).join(', ')})</span>
      <span class="chip"><strong>aSP10</strong> (${sc.p1Nodes.map(id => idToLabel[id]).join(', ')})</span>
      <span class="chip"><strong>pIP14</strong> (${sc.motorNodes.map(id => idToLabel[id]).join(', ')})</span>`;
  }

  const descEl = document.querySelector('#stateBehaviorDesc');
  if (descEl) {
    descEl.innerHTML = `<strong>Drive weighting:</strong> ${sc.driveBadge}.<br>${sc.behavior}<br><small style="color:#8a6460;display:block;margin-top:4px;"><em>Biological grounding:</em> ${sc.bioBasis}</small>`;
  }

  const dataListEl = document.querySelector('#supportingDataList');
  if (dataListEl) {
    dataListEl.innerHTML = sc.verificationData.map(v => `
      <div class="data-row">
        <div class="data-row-left">
          <b>${v.pre} \u2192 ${v.post}</b>
          <small>${v.role} &middot; Root: ${v.preId.slice(0,6)}...${v.preId.slice(-4)}</small>
        </div>
        <span class="data-row-synapses">${v.synapses} ${v.synapses===1?'synapse':'synapses'}</span>
      </div>`).join('');
  }
}

function selectSubcircuitEmotion(key) {
  selectedEmotion = key;
  const sc = SUBCIRCUITS[key];
  if (!sc) return;

  document.querySelectorAll('.emotion-btn').forEach(b => {
    const isAct = b.dataset.emotion === key;
    b.classList.toggle('active', isAct);
    if (isAct) {
      b.style.borderColor = sc.color;
      b.style.boxShadow = `0 3px 12px ${sc.color}44`;
    } else {
      b.style.borderColor = '';
      b.style.boxShadow = '';
    }
  });

  const titleEl = document.querySelector('#subcircuitTitle');
  if (titleEl) {
    titleEl.innerHTML = `<b style="color:${sc.color}">${sc.emoji} ${sc.name}</b> &middot; ${sc.tag}`;
  }
  const subEl = document.querySelector('#subcircuitPathSummary');
  if (subEl) subEl.textContent = sc.pathSummary;

  updateSubcircuitDetail(key);
  animateSubcircuit();
}

function animateSubcircuit() {
  subAnimStartTime = performance.now();
  subAnimActive = true;
  requestAnimationFrame(drawSubcircuit);
}

function initSubcircuitExplorer() {
  const container = document.querySelector('#emotionButtons');
  if (!container) return;

  container.innerHTML = Object.values(SUBCIRCUITS).map(sc => `
    <button class="emotion-btn ${sc.key===selectedEmotion?'active':''}" data-emotion="${sc.key}" role="tab" aria-selected="${sc.key===selectedEmotion}">
      <div class="emotion-btn-top">
        <span class="emotion-btn-title">${sc.emoji} ${sc.name}</span>
        <span class="emotion-btn-badge">${sc.driveBadge}</span>
      </div>
      <span class="emotion-btn-tag">${sc.tag}</span>
    </button>`).join('');

  container.querySelectorAll('.emotion-btn').forEach(btn => {
    btn.onclick = () => selectSubcircuitEmotion(btn.dataset.emotion);
  });

  const isolateToggle = document.querySelector('#isolatePathToggle');
  if (isolateToggle) isolateToggle.onchange = drawSubcircuit;

  const animBtn = document.querySelector('#animSubcircuitBtn');
  if (animBtn) animBtn.onclick = animateSubcircuit;

  // Tooltip handler on subcircuit canvas
  if (subCanvas) {
    const tip = document.querySelector('#subcircuitTip');
    subCanvas.addEventListener('pointermove', e => {
      const r = subCanvas.getBoundingClientRect();
      const mx = (e.clientX - r.left) * SUB_W / r.width;
      const my = (e.clientY - r.top) * SUB_H / r.height;
      const hitKey = Object.keys(subcircuitNodePos).find(id => {
        const p = subcircuitNodePos[id];
        return Math.hypot(mx - p.x, my - p.y) < 14;
      });
      if (hitKey && tip) {
        const sc = SUBCIRCUITS[selectedEmotion];
        const isActive = sc && (sc.sensoryNodes.includes(hitKey) || sc.p1Nodes.includes(hitKey) || sc.motorNodes.includes(hitKey));
        tip.style.display = 'block';
        tip.style.left = `${(e.clientX - r.left) + 12}px`;
        tip.style.top  = `${(e.clientY - r.top) + 12}px`;
        tip.innerHTML = `<strong>${idToLabel[hitKey]}</strong> (${subcircuitNodePos[hitKey].group.toUpperCase()})<br>` +
                        `FlyWire Root: <code>${idToRoot[hitKey]}</code><br>` +
                        `${idToDesc[hitKey]}<br>` +
                        `<span style="color:${isActive?sc.color:'#aaa'}">${isActive ? '\u2714 Active in '+sc.name+' path' : '\u2014 Inactive in '+sc.name+' path'}</span>`;
      } else if (tip) {
        tip.style.display = 'none';
      }
    });
    subCanvas.addEventListener('pointerleave', () => {
      const tip = document.querySelector('#subcircuitTip');
      if (tip) tip.style.display = 'none';
    });
  }

  selectSubcircuitEmotion('love');
}

// ── Unified View Navigation ──────────────────────────────────────────────────
function setView(v) {
  document.querySelectorAll('[data-view]').forEach(q => q.classList.toggle('active', q.dataset.view === v));
  const app = document.querySelector('#app');
  app.classList.remove('simple', 'circuit');
  if (v === 'simple') {
    app.classList.add('simple');
  } else if (v === 'circuit') {
    app.classList.add('circuit');
    drawSubcircuit();
  }
}

document.querySelectorAll('[data-view]').forEach(b => {
  b.onclick = () => setView(b.dataset.view);
});

const openCircuitBtn = document.querySelector('#openCircuitViewBtn');
if (openCircuitBtn) {
  openCircuitBtn.onclick = () => setView('circuit');
}

initSubcircuitExplorer();

// ── Onboarding ────────────────────────────────────────────────────────────────
const steps = [
  ['\u2328\uFE0F', 'WASD to move your fly',
   "You're Fly A. Steer in real time with WASD or the arrow keys."],
  ['\uD83D\uDC98', 'Deploy Lover, Enemy, or Friend',
   'Lover \u2192 Love (P1 low/mid). Enemy \u2192 Angry (P1 high, chases you). Friend \u2192 Chill (P1 stays calm \u2014 no friendship neuron in real fly research; this models neutral social presence). Click a fly to select it, then Delete to remove.'],
  ['\uD83E\uDDE0', 'Flip to BRAIN view',
   'See 14 individual LIF neurons light up in real time as spikes propagate: sensory \u2192 P1 \u2192 motor. Each dot glows when that neuron fired this tick.'],
];
let step=0;
function intro(){
  const q=steps[step];
  document.querySelector('#stepEmoji').textContent = q[0];
  document.querySelector('#stepCount').textContent = `${step+1} / 3`;
  document.querySelector('#stepTitle').textContent = q[1];
  document.querySelector('#stepText').textContent  = q[2];
  document.querySelector('#nextStep').textContent  = step===2 ? "Let's fly!" : 'Next \u2192';
}
document.querySelector('#nextStep').onclick=()=>{if(++step===3)document.querySelector('#onboarding').remove();else intro();};
document.querySelector('#skip').onclick=()=>document.querySelector('#onboarding').remove();
intro();

// ── Bootstrap ─────────────────────────────────────────────────────────────────
trace({state:'calm', parts:words('calm')}, false);
setInterval(tick, 1000/30);
render();

// ── Global export for inspection and testing ─────────────────────────────────
if (typeof window !== 'undefined') {
  window.FlyMind = { player, flies, foods, bads, keys, spawn, change, sense, tick, render, words, dominant, Brain };
}

})();

