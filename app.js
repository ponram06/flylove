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
let replaying = false, lastLive = null;
let selectedFly = null;
const DEBUG = new URLSearchParams(location.search).has('debug');

// ── Connectome + model (loaded from flywire_p1.json, see bootstrap) ──────────
const { Connectome, Brain, dominant, probe, SCENARIOS, clamp } = window.FlyModel;
let net      = null;  // Connectome built from flywire_p1.json
let nodePos  = null;  // live-graph layout, keyed by neuron id
let nodeGlow = null;  // per-neuron afterglow of real spikes (1 on spike, decays)
const GLOW_DECAY = 0.80; // per tick at 30Hz -> half gone in ~3 ticks

// ── Helpers ───────────────────────────────────────────────────────────────────
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

// ── Fly factory ───────────────────────────────────────────────────────────────
let nextId = 1;
const mk = (type, px, py) => ({
  id    : type==='player' ? 'A' : String(nextId++),
  type, x:px, y:py,
  r     : type==='player' ? 24 : 22,
  vx:0, vy:0, h:0,
  brain : null,
  state : 'calm',
  history : ['CALM'],
  last: 0, search: 0, trail: []
});

const player = mk('player', 385, 255);
let flies  = [player];
let foods  = [{x:150,y:110,r:31,type:'food'},{x:670,y:375,r:31,type:'food'}];
let bads   = [{x:650,y:115,r:48,type:'drama'}];

// ── Safe placement helper (keeps new items apart) ─────────────────────────────
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
    threat     : enemyNear ? clamp((150-de)/115, 0.05, 1) : 0,
    food       : foods.some(q => dist(f,q)<70) ? 1 : 0,
    sad        : inDrama,
    friendNear,
    isLover,
    nearL, nearE, nearFr,
    dl, de, dFr
  };
}

// ── Copy text per state ───────────────────────────────────────────────────────
function words(s) {
  // [headline, what the senses picked up, motor choice]
  return {
    calm  : ['Fly A is just chilling ✨',            'Nothing in sensory range',                        'explore the arena'],
    love  : ['Fly A is currently smitten 💘',        'Lover in range: song + touch sensory neurons fire', 'orient and flutter closer'],
    angry : ['Fly A is throwing hands 🥊',           'Enemy in range: threat sensory neurons fire',       'brace and evade the lunge'],
    chill : ['Fly A is vibing with Friend 😌',       'Friend in range: mild proximity cue',               'hold comfortable proximity'],
    happy : ['Fly A found a snack! 🎉',              'Snack contact: touch sensory neuron fires',         'linger and reinforce this spot'],
    sad   : ['Fly A is stressed out 😬',             'Drama zone: aversive sensory neurons fire',         'escape and avoid this area'],
  }[s];
}

// ── State change ──────────────────────────────────────────────────────────────
function change(s) {
  player.state = s;
  player.history.unshift(s.toUpperCase());
  player.history = player.history.slice(0,3);
  player.last = time;

  const floatie = { love:'💘', angry:'💢', chill:'😌', happy:'🎉', sad:'😬' }[s];
  if (floatie) spawnFloatie(floatie, player.x, player.y);

  // Snapshot what the network was doing so replay can show it
  const p1pct = Math.round(player.brain.p1Rate * 100);
  const e = { state:s, parts:words(s), status:getLiveP1Status(s, p1pct), rates:Float32Array.from(player.brain.rate) };
  events.push(e);
  if (events.length > MAX_EVENTS) events.shift();
  lastLive = e;
}
const MAX_EVENTS = 60;

// ── Causal trace panel (live, or the event being replayed) ───────────────────
let replayEvent = null;
function renderTrace() {
  if (!player.brain) return;
  const live = !replayEvent;
  const e = replayEvent || {
    state : player.state,
    parts : words(player.state),
    status: getLiveP1Status(player.state, Math.round(player.brain.p1Rate * 100)),
  };
  setText('#traceMode', live ? 'LIVE' : 'REPLAY');
  const el = document.querySelector('#explanation');
  el.style.borderColor = C[e.state] || C.calm;
  setHTML(el, `
    <p><strong>FLY A · ${e.state.toUpperCase()} · ${live ? 'LIVE' : 'REPLAY'}</strong></p>
    <p>01 · ${e.parts[0]}</p>
    <p>02 · ${e.parts[1]} → <strong>${e.status}</strong></p>
    <p>03 · Motor choice: <strong>${e.parts[2]}</strong></p>`);
}

// Only touch the DOM when content actually changes (render runs every frame)
const domCache = new WeakMap();
function setHTML(el, html) {
  if (typeof el === 'string') el = document.querySelector(el);
  if (el && domCache.get(el) !== html) { el.innerHTML = html; domCache.set(el, html); }
}
function setText(el, text) {
  if (typeof el === 'string') el = document.querySelector(el);
  if (el && el.textContent !== text) el.textContent = text;
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

// ── Per-neuron afterglow of real spikes (call AFTER brain.tick) ──────────────
function updateNodeGlow() {
  const sp = player.brain.spike;
  for (let i = 0; i < nodeGlow.length; i++) nodeGlow[i] = sp[i] ? 1 : nodeGlow[i] * GLOW_DECAY;
}

// ── Simulation step (fixed 30Hz) ──────────────────────────────────────────────
const SAMPLE_EVERY = 0.25, MAX_SAMPLES = 120; // chart keeps 30s of history
let nextSampleAt = 0;

function step() {
  time += dt;
  movePlayer();
  flies.slice(1).forEach(moveNPC);
  separate(); separateVisual();

  const s  = sense(player);
  const r  = player.brain.tick(s);
  updateNodeGlow(); // reads spikes immediately after brain tick
  const st = dominant(r, s.friendNear);
  if (DEBUG && Math.floor(time) !== Math.floor(time - dt)) debugLog(s, r, st);

  // Leave anger right away once the enemy is out of range
  const leaveAngry = player.state === 'angry' && s.threat === 0;
  if (st !== player.state && (time-player.last > .35 || leaveAngry)) change(st);

  flies.forEach(f => {
    f.trail.push({x:f.x, y:f.y});
    if (f.trail.length > 16) f.trail.shift();
  });

  floaties.forEach(fl => {
    fl.y    += fl.vy * dt;
    fl.life -= dt;
    fl.alpha = Math.max(0, fl.life/1.6);
  });
  floaties = floaties.filter(fl => fl.life>0);

  if (time >= nextSampleAt) {
    samples.push({love:r.love, angry:r.angry});
    if (samples.length > MAX_SAMPLES) samples.shift();
    nextSampleAt += SAMPLE_EVERY;
  }
}

// Once-a-second state dump, enabled with ?debug in the URL
function debugLog(s, r, st) {
  const entities = [
    ...flies.slice(1).map(f => `${f.type}#${f.id} d=${dist(player,f).toFixed(0)}`),
    ...foods.map((fd, i) => `snack#${i+1} d=${dist(player,fd).toFixed(0)}`),
    ...bads.map((bd, i) => `drama#${i+1} d=${dist(player,bd).toFixed(0)}`),
  ];
  console.log(`[FlyMind] P1 ${Math.round(player.brain.p1Rate*100)}% | ${player.state} -> ${st} | ` +
    Object.entries(r).map(([k,v]) => `${k}:${v.toFixed(2)}`).join(' ') + ` | ${entities.join(', ') || 'none'}`);
}

// ── Main loop: fixed-step simulation, render every animation frame ───────────
let lastFrame = null, acc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (lastFrame !== null && running && !replaying && player.brain) {
    acc = Math.min(acc + (now - lastFrame) / 1000, 0.25); // cap catch-up after tab switches
    while (acc >= dt) { step(); acc -= dt; }
  }
  lastFrame = now;
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
  renderTrace();
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
  sad   : 'linear-gradient(105deg,#8a4512,#e07a2a)',
};
const CALLOUT_AVATAR = {
  calm:'🪰', love:'💘', angry:'🥊', chill:'😌', happy:'🎉', sad:'😬'
};

// ── One description of P1 activity, shared by callout, graph caption, trace ──
// Every emotion is read out from the same P1 population plus context, so the
// text names the context instead of implying a separate circuit per emotion.
function getLiveP1Status(state, p1pct) {
  const ctx = {
    angry: 'enemy threat → aggression readout',
    love : 'lover, no threat → courtship readout',
    chill: 'friend nearby → calm readout',
    happy: 'snack contact → reward readout',
    sad  : 'drama zone → stress readout',
  }[state];
  if (ctx) return `P1 ${p1pct}% active, ${ctx}`;
  return p1pct < 5 ? `P1 at rest (${p1pct}%)` : `P1 ${p1pct}% active, no dominant readout`;
}

function callout() {
  if (!player.brain) return;
  const p = words(player.state);
  const statusDesc = getLiveP1Status(player.state, Math.round(player.brain.p1Rate * 100));
  document.querySelector('#callout').style.background = CALLOUT_BG[player.state] || CALLOUT_BG.calm;
  setText('.avatar', CALLOUT_AVATAR[player.state]);
  setText('#calloutTitle', p[0]);
  setText('#calloutSub', 'Circuit: '+statusDesc+'. Motor: '+p[2]+'.');
}

// ── Telemetry ─────────────────────────────────────────────────────────────────
function telemetry() {
  if (!player.brain) return;
  const col = C[player.state] || C.calm;
  setHTML('#telemetry', `
    <div class="metric"><small>DOMINANT</small><b style="color:${col}">${player.state.toUpperCase()}</b></div>
    <div class="metric"><small>HISTORY</small><b>${player.history.join(' → ')}</b></div>
    <div class="metric"><small>P1 RATE</small><b>${player.brain.p1Rate.toFixed(2)}</b></div>
    <div class="metric"><small>MOTOR RATE</small><b>${player.brain.motorRate.toFixed(2)}</b></div>`);
}

// ── Graph layout & edge geometry (shared by live graph and explorer) ─────────
function layoutColumns(neurons, groupX, top, bottom) {
  const pos = {};
  for (const g of Object.keys(groupX)) {
    const ns = neurons.filter(n => n.group === g);
    ns.forEach((n, i) => {
      pos[n.id] = { x: groupX[g], y: top + i * (bottom - top) / (ns.length - 1 || 1), group: g };
    });
  }
  return pos;
}

// Cubic Bézier for an edge; same-column edges bow out to the right
function edgeCurve(pos, pre, post, bow) {
  const a = pos[pre], b = pos[post];
  if (!a || !b) return null;
  if (a.group === b.group) {
    const side = a.group === 'p1' ? bow * 1.3 : bow;
    return { p0:{x:a.x,y:a.y}, p1:{x:a.x+side,y:a.y}, p2:{x:b.x+side,y:b.y}, p3:{x:b.x,y:b.y} };
  }
  const cpx = (a.x + b.x) * 0.5;
  return { p0:{x:a.x,y:a.y}, p1:{x:cpx,y:a.y}, p2:{x:cpx,y:b.y}, p3:{x:b.x,y:b.y} };
}

function strokeCurve(ctx, c) {
  ctx.beginPath();
  ctx.moveTo(c.p0.x, c.p0.y);
  ctx.bezierCurveTo(c.p1.x, c.p1.y, c.p2.x, c.p2.y, c.p3.x, c.p3.y);
  ctx.stroke();
}

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
  const gr = ctx.createRadialGradient(pt.x, pt.y, 1, pt.x, pt.y, 7.5);
  gr.addColorStop(0, '#ffffff');
  gr.addColorStop(0.35, color);
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gr;
  ctx.beginPath(); ctx.arc(pt.x, pt.y, 7.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2); ctx.fill();
}

const GROUP_COL    = { sensory:'#e98971', p1:'#ff5c9a', motor:'#7856cf' };
const LIVE_GROUP_X = { sensory:52, p1:160, motor:268 };

function meanOf(arr, idx) {
  let s = 0;
  for (const i of idx) s += arr[i];
  return idx.length ? s / idx.length : 0;
}

// ── Live node-and-wire graph: every glow is a real spike from the model ──────
let loadError = null;
function drawNeuronGraph() {
  ng.clearRect(0,0,NGW,NGH);
  ng.fillStyle='#fff4ee'; ng.fillRect(0,0,NGW,NGH);

  if (!net) {
    ng.fillStyle='#c09890'; ng.font='11px Fredoka'; ng.textAlign='center';
    ng.fillText(loadError ? 'Could not load flywire_p1.json' : 'Loading circuit map…', NGW/2, NGH/2);
    return;
  }

  const ev = replayEvent;
  const p1pct = Math.round((ev ? meanOf(ev.rates, net.byGroup.p1) : player.brain.p1Rate) * 100);
  setText('#neuronMeaning', (ev ? 'Replay: ' : 'Live: ') + getLiveP1Status(ev ? ev.state : player.state, p1pct) + '.');

  // Live: afterglow of this tick's spikes. Replay: firing-rate snapshot.
  const glowOf = ev ? (i => Math.min(1, ev.rates[i] * 2)) : (i => nodeGlow[i]);
  const color  = C[ev ? ev.state : player.state] || C.calm;

  // Every real edge; thickness = synapse-count weight
  ng.strokeStyle = 'rgba(200,170,160,0.35)';
  for (const e of net.edges) {
    const c = edgeCurve(nodePos, e.pre, e.post, 28);
    if (!c) continue;
    ng.lineWidth = 0.4 + e.w * 1.4;
    strokeCurve(ng, c);
  }

  // Edges whose presynaptic neuron just fired carry signal
  for (const e of net.edges) {
    const g = glowOf(e.from);
    if (g < 0.08) continue;
    const c = edgeCurve(nodePos, e.pre, e.post, 28);
    if (!c) continue;
    ng.strokeStyle = hexToRgba(color, 0.2 + g * 0.7);
    ng.lineWidth = 0.8 + e.w * 2;
    strokeCurve(ng, c);
    if (!ev && g > 0.15 && g < 1) drawSignalDot(ng, getBezierPoint(c.p0, c.p1, c.p2, c.p3, 1 - g), color);
  }

  ng.fillStyle='#b08880'; ng.font='bold 7.5px DM Mono'; ng.textAlign='center';
  ng.fillText('SENSORY', LIVE_GROUP_X.sensory, 11);
  ng.fillText('P1 CLUSTER', LIVE_GROUP_X.p1, 11);
  ng.fillText('MOTOR', LIVE_GROUP_X.motor, 11);

  const NODE_R = 8;
  net.neurons.forEach((n, i) => {
    const p = nodePos[n.id];
    if (!p) return;
    const glow = glowOf(i);
    const base = GROUP_COL[n.group] || GROUP_COL.p1;

    if (glow > 0.05) {
      const haloR = NODE_R + 5 + glow * 7;
      const gr = ng.createRadialGradient(p.x, p.y, NODE_R * 0.5, p.x, p.y, haloR);
      gr.addColorStop(0, hexToRgba(color, glow * 0.7));
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      ng.beginPath(); ng.arc(p.x, p.y, haloR, 0, Math.PI * 2);
      ng.fillStyle = gr; ng.fill();
    }

    ng.beginPath(); ng.arc(p.x, p.y, NODE_R, 0, Math.PI*2);
    ng.fillStyle = glow > 0.05 ? blendHex(base, color, glow * 0.8) : base + '55';
    ng.fill();
    ng.strokeStyle = glow > 0.2 ? '#432c4a88' : '#432c4a22';
    ng.lineWidth = glow > 0.2 ? 1.5 : 1;
    ng.stroke();

    ng.fillStyle  = glow > 0.2 ? '#432c4a' : '#b0948e';
    ng.font       = (glow > 0.2 ? 'bold ' : '') + '6.5px DM Mono';
    ng.textAlign  = 'center';
    ng.fillText(n.label, p.x, p.y + NODE_R + 8);
  });
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
function arenaPoint(e) {
  const r = arena.getBoundingClientRect();
  return { x:(e.clientX-r.left)*W/r.width, y:(e.clientY-r.top)*H/r.height };
}

const TIPS = {
  player: 'This is you — move with WASD, arrow keys, or the on-screen pad.',
  lover : 'Lover 💘 — get close: song + touch sensory neurons drive P1 → Love. Click to select.',
  enemy : 'Enemy 😠 — get close: threat sensory neurons drive P1 → Anger. It chases back. Click to select.',
  friend: 'Friend 😊 — a mild proximity cue, too weak to recruit P1, so Fly A stays chill. Click to select.',
  food  : 'Snack 🍓 — touch it! The contact sensory neuron drives P1 → Happy.',
  drama : 'Drama zone ☠ — enter it! Aversive sensory neurons drive P1 → Stressed.',
};
const DEFAULT_TIP = 'Hover a character, snack, or drama zone';

function setTip(e) {
  const p = arenaPoint(e);
  const hit = [...flies,...foods,...bads].find(q => dist(p,q) < (q.r||25)+12);
  setText('#arenaTip', hit ? TIPS[hit.type] : DEFAULT_TIP);
  const isNpc = hit && hit.type in FLY_COL && hit.type !== 'player';
  arena.style.cursor = isNpc ? 'pointer' : hit ? 'help' : 'crosshair';
}

// ── Event listeners ───────────────────────────────────────────────────────────
arena.addEventListener('pointermove', setTip);

ngCvs.addEventListener('pointermove', e => {
  if (!net) return;
  const r = ngCvs.getBoundingClientRect();
  const mx = (e.clientX - r.left) * NGW / r.width;
  const my = (e.clientY - r.top) * NGH / r.height;
  const hit = net.neurons.find(n => {
    const p = nodePos[n.id];
    return p && Math.hypot(mx - p.x, my - p.y) < 14;
  });
  ngCvs.title = hit ? `${hit.label} · ${hit.cell_type} (FlyWire root ${hit.root_id})\n${hit.desc}`
                    : 'FlyWire connectome subgraph (live)';
});

const npcs = () => flies.filter(f => f.type !== 'player');

function selectFly(f) {
  selectedFly = f;
  updateRemoveBtn();
}

arena.addEventListener('pointerdown', e => {
  const p = arenaPoint(e);
  const hit = npcs().find(f => dist(p,f) < f.r+14);
  if (hit) {
    selectFly(selectedFly === hit ? null : hit);
    e.preventDefault();
    return;
  }
  // With a fly selected, a click on empty space only deselects it
  if (selectedFly) { selectFly(null); return; }

  const radius = mode === 'food' ? 31 : 48;
  const safe = getSafePosition(p.x, p.y, radius);
  if (mode === 'food') foods.push({x:safe.x, y:safe.y, r:31, type:'food'});
  else                 bads.push ({x:safe.x, y:safe.y, r:48, type:'drama'});
});

const MOVE_KEYS = ['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'];
document.addEventListener('keydown', e => {
  if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (MOVE_KEYS.includes(e.code)) {
    keys[e.code] = true; e.preventDefault();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedFly) {
    removeFly(selectedFly); e.preventDefault();
  } else if (e.code === 'KeyN') {
    // Keyboard alternative to clicking: cycle through deployed flies
    const list = npcs();
    if (list.length) selectFly(list[(list.indexOf(selectedFly) + 1) % list.length]);
  } else if (e.key === 'Escape' && selectedFly) {
    selectFly(null);
  }
});
document.addEventListener('keyup', e => { keys[e.code] = false; });

// Releasing a key while the window is unfocused never fires keyup
const releaseKeys = () => { for (const k in keys) keys[k] = false; };
window.addEventListener('blur', releaseKeys);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseKeys(); });

// On-screen movement pad (shown on touch devices)
document.querySelectorAll('[data-key]').forEach(btn => {
  const k = btn.dataset.key;
  btn.addEventListener('pointerdown', e => {
    keys[k] = true; e.preventDefault();
    if (btn.setPointerCapture) btn.setPointerCapture(e.pointerId);
  });
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(t, () => { keys[k] = false; });
});

// ── Clear board ───────────────────────────────────────────────────────────────
function clearBoard() {
  const npcCount = npcs().length;
  const itemCount = foods.length + bads.length;
  // Confirm if more than 2 things are placed (prevent accidental mid-demo wipe)
  if (npcCount + itemCount > 2) {
    const ok = confirm(
      `Clear board? This will remove ${npcCount > 0 ? npcCount + ' deployed fl' + (npcCount===1?'y':'ies') + (itemCount>0?' and ':'') : ''}` +
      `${itemCount > 0 ? itemCount + ' item' + (itemCount===1?'':'s') : ''} from the arena.`
    );
    if (!ok) return;
  }
  stopReplay();
  flies  = [player];
  foods  = [];
  bads   = [];
  selectFly(null);
  floaties = [];
  // Reset Fly A's brain, state and history to a calm baseline
  if (net) {
    player.brain = new Brain(net);
    nodeGlow.fill(0);
  }
  player.state   = 'calm';
  player.history = ['CALM'];
  player.last    = time;
  player.trail   = [];
  events.length  = 0;
  samples.length = 0;
  nextSampleAt   = time;
  lastLive       = null;
}

// ── Buttons ───────────────────────────────────────────────────────────────────
document.querySelector('#lover').onclick        = () => spawn('lover');
document.querySelector('#enemy').onclick        = () => spawn('enemy');
document.querySelector('#friend').onclick       = () => spawn('friend');
document.querySelector('#removeFlyBtn').onclick = () => removeFly(selectedFly);
document.querySelector('#clearBoard').onclick   = clearBoard;

// Placement mode: which item a click on empty arena space drops
function setMode(m) {
  mode = m;
  for (const [id, v] of [['#food','food'], ['#bad','bad']]) {
    const b = document.querySelector(id);
    b.classList.toggle('active', mode === v);
    b.setAttribute('aria-pressed', String(mode === v));
  }
}
document.querySelector('#food').onclick = () => setMode('food');
document.querySelector('#bad').onclick  = () => setMode('bad');
setMode(mode);

const pauseBtn = document.querySelector('#pause');
pauseBtn.onclick = () => {
  running = !running;
  pauseBtn.textContent = running ? 'Ⅱ Pause' : '▶ Resume';
};

// Replay steps through recorded state changes; the simulation is frozen
// meanwhile and resumes afterwards only if it was not paused.
const replayBtn = document.querySelector('#replay');
let replayTimer = null;
function stopReplay() {
  clearTimeout(replayTimer);
  replayTimer = null;
  replaying = false;
  replayEvent = null;
  replayBtn.textContent = '▶ Replay drama';
}
replayBtn.onclick = () => {
  if (replaying) return stopReplay();
  if (!events.length) return;
  const list = events.slice();
  let i = 0;
  replaying = true;
  replayBtn.textContent = '■ Stop replay';
  const go = () => {
    if (i >= list.length) return stopReplay();
    replayEvent = list[i++];
    replayTimer = setTimeout(go, 1500);
  };
  go();
};

// ── Circuit explorer: what the model actually does for each situation ────────
// For each emotion the model is run offline on a canonical stimulus
// (FlyModel.SCENARIOS). Nodes are neurons that fired; highlighted wires are
// real edges whose presynaptic neuron fired before the postsynaptic neuron's
// first spike, i.e. edges that could have recruited it. The animation replays
// that recruitment order.
const subCanvas = document.querySelector('#subcircuitCanvas');
const subCtx    = subCanvas.getContext('2d');
const SUB_W = 500, SUB_H = 320;
const SUB_GROUP_X = { sensory:75, p1:250, motor:425 };
const ANIM_TICK_S = 0.12; // animation seconds per model tick
let subPos = null;

const EMOTIONS = {
  love : { name:'Love',           emoji:'💘', color:C.love,  stimulus:'lover',
           input:'Lover nearby, no threat',
           behavior:'Orient towards partner, wing-extension song, focused courtship following.' },
  angry: { name:'Angry',          emoji:'🥊', color:C.angry, stimulus:'enemy',
           input:'Enemy within range',
           behavior:'Fast pursuit, turning to confront the rival, lunging.' },
  chill: { name:'Calm / Friend',  emoji:'😌', color:C.chill, stimulus:'friend',
           input:'Friend nearby',
           behavior:'Hold comfortable proximity, slow relaxed cruising. There is no known "friendship neuron" in flies; this is a weak proximity cue.' },
  happy: { name:'Happy (Snack)',  emoji:'🎉', color:C.happy, stimulus:'food',
           input:'Touching a snack',
           behavior:'Linger and reinforce the current spot, calm feeding orientation.' },
  sad  : { name:'Sad / Stressed', emoji:'😬', color:C.sad,   stimulus:'drama',
           input:'Inside a drama zone',
           behavior:'Aversive avoidance, fast turning away from the zone.' },
};

const explorerData = {};
let selectedEmotion = 'love';
let subAnimStart = 0, subAnimActive = false;

const labelOf = id => net.neurons[net.index.get(id)].label;
const byFirstSpike = (p, ids) => [...ids].sort((a, b) => p.firstSpike[a] - p.firstSpike[b]);

function buildExplorerData() {
  for (const key of Object.keys(EMOTIONS)) {
    const p = probe(net, SCENARIOS[key]);
    const fs = p.firstSpike;
    const causal = p.edges.filter(e => fs[e.pre] >= 0 && fs[e.post] > fs[e.pre]);
    const lastT = Math.max(0, ...[...p.active].map(id => fs[id]));
    const inGroup = g => byFirstSpike(p, [...p.active].filter(id => net.neurons[net.index.get(id)].group === g));
    const motors = inGroup('motor');
    explorerData[key] = {
      ...p, causal, lastT,
      entry  : FlyModel.STIMULUS_MAP[EMOTIONS[key].stimulus].filter(id => p.active.has(id)),
      groups : { sensory: inGroup('sensory'), p1: inGroup('p1'), motor: motors },
      firstMotorTick: motors.length ? fs[motors[0]] : -1,
    };
  }
}

function drawSubcircuit() {
  if (!net) return;
  const em = EMOTIONS[selectedEmotion], d = explorerData[selectedEmotion];
  const isolate = document.querySelector('#isolatePathToggle').checked;
  const elapsed = subAnimActive ? (performance.now() - subAnimStart) / 1000 : Infinity;
  const tOf = id => d.firstSpike[id] * ANIM_TICK_S;

  subCtx.clearRect(0, 0, SUB_W, SUB_H);
  subCtx.fillStyle = '#fff4ee';
  subCtx.fillRect(0, 0, SUB_W, SUB_H);

  subCtx.fillStyle = '#b08880';
  subCtx.font = 'bold 8.5px DM Mono';
  subCtx.textAlign = 'center';
  subCtx.fillText('SENSORY (aIP1)', SUB_GROUP_X.sensory, 14);
  subCtx.fillText('P1 CLUSTER (aSP10)', SUB_GROUP_X.p1, 14);
  subCtx.fillText('MOTOR (pIP14)', SUB_GROUP_X.motor, 14);

  // Background: every other real edge (hidden when isolating)
  const causalSet = new Set(d.causal);
  if (!isolate) {
    subCtx.strokeStyle = 'rgba(200,170,160,0.30)';
    for (const e of net.edges) {
      if (causalSet.has(e)) continue;
      const c = edgeCurve(subPos, e.pre, e.post, 34);
      if (!c) continue;
      subCtx.lineWidth = 0.4 + e.w * 1.2;
      strokeCurve(subCtx, c);
    }
  }

  // Recruiting edges draw from the presynaptic spike to the postsynaptic one
  for (const e of causalSet) {
    const c = edgeCurve(subPos, e.pre, e.post, 34);
    if (!c) continue;
    const t0 = tOf(e.pre), t1 = tOf(e.post);
    const u = Math.min(1, Math.max(0, (elapsed - t0) / Math.max(t1 - t0, ANIM_TICK_S)));
    if (u <= 0) continue;
    subCtx.strokeStyle = em.color;
    subCtx.lineWidth = 0.8 + e.w * 2.4;
    drawPartialCurve(subCtx, c.p0, c.p1, c.p2, c.p3, u);
    if (u < 1) drawSignalDot(subCtx, getBezierPoint(c.p0, c.p1, c.p2, c.p3, u), em.color);
  }

  const NODE_R = 9;
  for (const n of net.neurons) {
    const p = subPos[n.id];
    const isActive = d.active.has(n.id);
    if (!isActive && isolate) {
      subCtx.beginPath();
      subCtx.arc(p.x, p.y, NODE_R, 0, Math.PI * 2);
      subCtx.fillStyle = 'rgba(230, 215, 208, 0.22)';
      subCtx.fill();
      subCtx.strokeStyle = 'rgba(180, 150, 140, 0.25)';
      subCtx.lineWidth = 1;
      subCtx.setLineDash([2, 3]);
      subCtx.stroke();
      subCtx.setLineDash([]);
      subCtx.fillStyle = 'rgba(160, 135, 130, 0.5)';
      subCtx.font = '6.5px DM Mono';
      subCtx.textAlign = 'center';
      subCtx.fillText(n.label, p.x, p.y + NODE_R + 8);
      continue;
    }

    const glow = isActive ? Math.min(1, Math.max(0, (elapsed - tOf(n.id)) / 0.25)) * 0.85 : 0;
    const baseCol = GROUP_COL[n.group] || GROUP_COL.p1;
    if (glow > 0.05) {
      const haloR = NODE_R + 6 + glow * 5;
      const gr = subCtx.createRadialGradient(p.x, p.y, NODE_R * 0.4, p.x, p.y, haloR);
      gr.addColorStop(0, hexToRgba(em.color, glow * 0.65));
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      subCtx.beginPath();
      subCtx.arc(p.x, p.y, haloR, 0, Math.PI * 2);
      subCtx.fillStyle = gr;
      subCtx.fill();
    }
    subCtx.beginPath();
    subCtx.arc(p.x, p.y, NODE_R, 0, Math.PI * 2);
    subCtx.fillStyle = glow > 0.05 ? blendHex(baseCol, em.color, glow * 0.75) : baseCol + '44';
    subCtx.fill();
    subCtx.strokeStyle = isActive ? '#432c4a' : '#432c4a33';
    subCtx.lineWidth = isActive ? 1.8 : 1;
    subCtx.stroke();
    subCtx.fillStyle = isActive ? '#432c4a' : '#b0948e';
    subCtx.font = (isActive ? 'bold ' : '') + '7px DM Mono';
    subCtx.textAlign = 'center';
    subCtx.fillText(n.label, p.x, p.y + NODE_R + 9);
  }

  if (subAnimActive && elapsed < (d.lastT + 3) * ANIM_TICK_S) requestAnimationFrame(drawSubcircuit);
  else subAnimActive = false;
}

function pathSummary(d) {
  const part = ids => ids.length ? ids.map(labelOf).join(', ') : '—';
  return `${part(d.entry)} → ${part(d.groups.p1.slice(0, 3))}${d.groups.p1.length > 3 ? '…' : ''} → ${part(d.groups.motor.slice(0, 2))}${d.groups.motor.length > 2 ? '…' : ''}`;
}

function updateSubcircuitDetail(key) {
  const em = EMOTIONS[key], d = explorerData[key];
  const { sensory, p1, motor } = d.groups;

  const countEl = document.querySelector('#activeNeuronCount');
  countEl.textContent = `${d.active.size} / ${net.neurons.length} fire (${sensory.length} sensory · ${p1.length} P1 · ${motor.length} motor)` +
    (d.firstMotorTick >= 0 ? `; first motor spike after ${d.firstMotorTick + 1} ticks (~${Math.round((d.firstMotorTick + 1) * 1000 / 30)} ms)` : '; no motor output');
  countEl.style.color = em.color;

  const chip = (type, ids) => `<span class="chip"><strong>${type}</strong> (${ids.length ? ids.map(labelOf).join(', ') : 'none'})</span>`;
  setHTML('#modeledCellTypes', chip('aIP1', sensory) + chip('aSP10', p1) + chip('pIP14', motor));

  setHTML('#stateBehaviorDesc',
    `<strong>Input:</strong> ${em.input} → drives ${d.entry.map(labelOf).join(', ') || 'no sensory neuron'}.<br>` +
    `<strong>Model P1 rate:</strong> ${Math.round(d.meanP1 * 100)}%.<br>${em.behavior}`);

  setHTML('#supportingDataList', d.causal.length
    ? [...d.causal].sort((a, b) => b.synapse_count - a.synapse_count).map(e => `
      <div class="data-row">
        <div class="data-row-left">
          <b>${labelOf(e.pre)} → ${labelOf(e.post)}</b>
          <small>root ${e.pre_root_id} → ${e.post_root_id}</small>
        </div>
        <span class="data-row-synapses">${e.synapse_count} ${e.synapse_count === 1 ? 'synapse' : 'synapses'}</span>
      </div>`).join('')
    : '<p class="data-disclaimer">No edge carried signal: this input is too weak to recruit anything past the sensory layer.</p>');
}

function selectSubcircuitEmotion(key) {
  selectedEmotion = key;
  const em = EMOTIONS[key];
  document.querySelectorAll('.emotion-btn').forEach(b => {
    const on = b.dataset.emotion === key;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    b.style.borderColor = on ? em.color : '';
    b.style.boxShadow   = on ? `0 3px 12px ${em.color}44` : '';
  });
  setHTML('#subcircuitTitle', `<b style="color:${em.color}">${em.emoji} ${em.name}</b> · ${em.input}`);
  setText('#subcircuitPathSummary', pathSummary(explorerData[key]));
  updateSubcircuitDetail(key);
  animateSubcircuit();
}

function animateSubcircuit() {
  subAnimStart = performance.now();
  if (!subAnimActive) { subAnimActive = true; requestAnimationFrame(drawSubcircuit); }
}

function initSubcircuitExplorer() {
  buildExplorerData();
  const container = document.querySelector('#emotionButtons');
  container.innerHTML = Object.entries(EMOTIONS).map(([key, em]) => `
    <button class="emotion-btn" id="tab-${key}" data-emotion="${key}" role="tab" aria-selected="false" aria-controls="subcircuitCanvas" tabindex="-1">
      <div class="emotion-btn-top">
        <span class="emotion-btn-title">${em.emoji} ${em.name}</span>
        <span class="emotion-btn-badge">P1 ≈ ${Math.round(explorerData[key].meanP1 * 100)}%</span>
      </div>
      <span class="emotion-btn-tag">${em.input}</span>
    </button>`).join('');

  const tabs = [...container.querySelectorAll('.emotion-btn')];
  tabs.forEach((btn, i) => {
    btn.onclick = () => selectSubcircuitEmotion(btn.dataset.emotion);
    // Arrow keys move between tabs (WAI-ARIA tabs pattern)
    btn.onkeydown = e => {
      const dir = { ArrowDown:1, ArrowRight:1, ArrowUp:-1, ArrowLeft:-1 }[e.key];
      if (!dir) return;
      e.preventDefault(); e.stopPropagation();
      const next = tabs[(i + dir + tabs.length) % tabs.length];
      next.focus();
      selectSubcircuitEmotion(next.dataset.emotion);
    };
  });

  document.querySelector('#isolatePathToggle').onchange = () => { if (!subAnimActive) drawSubcircuit(); };
  document.querySelector('#animSubcircuitBtn').onclick = animateSubcircuit;

  const tip = document.querySelector('#subcircuitTip');
  subCanvas.addEventListener('pointermove', e => {
    const r = subCanvas.getBoundingClientRect();
    const mx = (e.clientX - r.left) * SUB_W / r.width;
    const my = (e.clientY - r.top) * SUB_H / r.height;
    const n = net.neurons.find(n => Math.hypot(mx - subPos[n.id].x, my - subPos[n.id].y) < 14);
    if (!n) { tip.style.display = 'none'; return; }
    const em = EMOTIONS[selectedEmotion], d = explorerData[selectedEmotion];
    const active = d.active.has(n.id);
    tip.style.display = 'block';
    tip.style.left = `${(e.clientX - r.left) + 12}px`;
    tip.style.top  = `${(e.clientY - r.top) + 12}px`;
    tip.innerHTML = `<strong>${n.label}</strong> (${n.group.toUpperCase()})<br>` +
                    `FlyWire root: <code>${n.root_id}</code><br>${n.desc}<br>` +
                    `<span style="color:${active ? em.color : '#aaa'}">${active
                      ? `✔ Fires ${Math.round(d.rates[n.id] * 100)}% of ticks, first at tick ${d.firstSpike[n.id] + 1}`
                      : '— Silent for this input'}</span>`;
  });
  subCanvas.addEventListener('pointerleave', () => { tip.style.display = 'none'; });

  selectSubcircuitEmotion(selectedEmotion);
}

// ── View navigation ───────────────────────────────────────────────────────────
function setView(v) {
  document.querySelectorAll('[data-view]').forEach(q => {
    q.classList.toggle('active', q.dataset.view === v);
    q.setAttribute('aria-pressed', String(q.dataset.view === v));
  });
  const app = document.querySelector('#app');
  app.classList.remove('simple', 'circuit');
  if (v === 'simple') app.classList.add('simple');
  else if (v === 'circuit') { app.classList.add('circuit'); if (net) animateSubcircuit(); }
}

document.querySelectorAll('[data-view]').forEach(b => { b.onclick = () => setView(b.dataset.view); });
document.querySelector('#openCircuitViewBtn').onclick = () => setView('circuit');

// ── Onboarding ────────────────────────────────────────────────────────────────
const steps = [
  ['⌨️', 'WASD to move your fly',
   "You're Fly A. Steer with WASD, the arrow keys, or the on-screen pad on touch screens."],
  ['💘', 'Deploy Lover, Enemy, or Friend',
   'Get close to trigger Love, Anger, or Chill. Click a fly (or press N) to select it, then Delete to remove it. Clicking empty space drops the selected item: a snack or a drama zone.'],
  ['🧠', 'Flip to BRAIN view',
   '14 real FlyWire neurons fire in real time. Only the 4 sensory neurons get input from the arena; P1 and motor neurons are driven purely through the real synapses between them.'],
];
let stepIdx = 0;
function intro() {
  const q = steps[stepIdx];
  setText('#stepEmoji', q[0]);
  setText('#stepCount', `${stepIdx+1} / ${steps.length}`);
  setText('#stepTitle', q[1]);
  setText('#stepText',  q[2]);
  setText('#nextStep',  stepIdx === steps.length-1 ? "Let's fly!" : 'Next →');
}
const closeIntro = () => document.querySelector('#onboarding').remove();
document.querySelector('#nextStep').onclick = () => { if (++stepIdx === steps.length) closeIntro(); else intro(); };
document.querySelector('#skip').onclick = closeIntro;
intro();

// ── Bootstrap ─────────────────────────────────────────────────────────────────
// Fill any [data-fact] element with numbers computed from the loaded data
function fillDataFacts() {
  const inh = net.inhibitoryCount;
  const facts = {
    neurons : String(net.neurons.length),
    edges   : String(net.edges.length),
    synapses: String(net.totalSynapses),
    sign    : inh
      ? `${inh} edges predicted GABAergic are modelled as inhibitory; the rest as excitatory.`
      : 'This data snapshot has no neurotransmitter predictions, so every edge is modelled as excitatory.',
  };
  document.querySelectorAll('[data-fact]').forEach(el => { el.textContent = facts[el.dataset.fact] ?? el.textContent; });
}

function start(data) {
  net      = new Connectome(data);
  nodeGlow = new Float32Array(net.neurons.length);
  nodePos  = layoutColumns(net.neurons, LIVE_GROUP_X, 24, NGH - 24);
  subPos   = layoutColumns(net.neurons, SUB_GROUP_X, 38, SUB_H - 32);
  player.brain = new Brain(net);
  fillDataFacts();
  initSubcircuitExplorer();
}

fetch('flywire_p1.json')
  .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
  .then(start)
  .catch(err => {
    loadError = err;
    console.error('FlyMind: could not load flywire_p1.json', err);
    setText('#calloutTitle', 'Could not load the connectome data');
    setText('#calloutSub', location.protocol === 'file:'
      ? 'Browsers block data loading on file:// pages. Run "node serve.js" and open http://127.0.0.1:8080.'
      : `flywire_p1.json failed to load (${err.message}).`);
  });

requestAnimationFrame(frame);

// ── Global export for inspection and testing ─────────────────────────────────
window.FlyMind = {
  get player() { return player; }, get flies() { return flies; },
  get foods()  { return foods;  }, get bads()  { return bads;  },
  get net()    { return net;    },
  keys, spawn, change, sense, step, render, words, dominant, Brain,
};

})();
