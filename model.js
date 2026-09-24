// FlyMind neural model: one leaky integrate-and-fire (LIF) unit per FlyWire
// neuron in flywire_p1.json. Sensory units receive external drive from what
// the fly senses; every other unit is driven only by spikes arriving over the
// real synapses in the data file (weight derived from synapse count).
//
// Works in the browser (window.FlyModel) and in Node (module.exports) so the
// model can be unit-tested without a DOM.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FlyModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

// Tunable parameters (exported so tests and experiments can adjust them)
const PARAMS = {
  leak      : 0.78,  // membrane decay per tick
  synGain   : 0.70,  // voltage added per presynaptic spike, times edge weight w
  adapt     : 0.15,  // threshold increase per spike (spike-frequency adaptation)
  adaptDecay: 0.80,  // per-tick decay of the adaptation term
  rateTau   : 0.35,  // EMA factor for per-neuron firing rate
};
const THRESHOLD = { sensory: .74, p1: .83, motor: .80 };
const GROUPS    = ['sensory', 'p1', 'motor'];

// Which sensory neuron receives which stimulus. This mapping is a modelling
// choice based on each neuron's described role, not something in the data.
const STIMULUS_MAP = {
  lover : ['S1', 'S2'],        // song (auditory) + contact (mechanosensory)
  enemy : ['S3', 'S4'],        // aversive/visual integrator + proximity relay
  friend: ['S4'],              // mild proximity cue only
  food  : ['S2'],              // contact/taste touch
  drama : ['S3', 'S4'],        // aversive environment
};

// Transmitters treated as inhibitory when the data carries predictions.
const INHIBITORY_NT = new Set(['gaba']);

class Connectome {
  constructor(data) {
    this.neurons = data.neurons;
    this.index   = new Map(this.neurons.map((n, i) => [n.id, i]));
    this.edges   = data.synapses
      .filter(s => this.index.has(s.pre) && this.index.has(s.post))
      .map(s => ({
        ...s,
        from: this.index.get(s.pre),
        to  : this.index.get(s.post),
        sign: INHIBITORY_NT.has(s.nt) ? -1 : 1,
      }));
    this.byGroup = Object.fromEntries(GROUPS.map(g => [g, []]));
    this.neurons.forEach((n, i) => { if (this.byGroup[n.group]) this.byGroup[n.group].push(i); });
    this.inhibitoryCount = this.edges.filter(e => e.sign < 0).length;
    this.totalSynapses   = this.edges.reduce((a, e) => a + e.synapse_count, 0);
  }
}

class Brain {
  constructor(net) {
    this.net   = net;
    const N    = net.neurons.length;
    this.v     = new Float32Array(N);
    this.spike = new Uint8Array(N);
    this.rate  = new Float32Array(N);
    this.ext   = new Float32Array(N);
    this.input = new Float32Array(N);
    this.adapt = new Float32Array(N);
    this.thr   = Float32Array.from(net.neurons, n => THRESHOLD[n.group] ?? .8);
    // Small per-neuron gain spread so identically driven units desynchronise
    this.gain  = Float32Array.from(net.neurons, n => .8 + .03 * (net.byGroup[n.group] || []).indexOf(net.index.get(n.id)));
    this.p1Rate = 0;
    this.motorRate = 0;
    this.r = { love: 0, angry: 0, happy: 0, sad: 0, chill: 0 };
  }

  // Advance the network one tick given external drive per neuron.
  step(ext) {
    const { net, v, spike, rate, input, thr, gain, adapt } = this;
    const P = PARAMS;
    input.fill(0);
    for (const e of net.edges) if (spike[e.from]) input[e.to] += e.sign * e.w * P.synGain;
    for (let i = 0; i < v.length; i++) {
      v[i] = Math.max(-1, v[i] * P.leak + ext[i] * gain[i] + input[i]);
      adapt[i] *= P.adaptDecay;
      spike[i] = 0;
      if (v[i] > thr[i] + adapt[i]) { v[i] = 0; spike[i] = 1; adapt[i] += P.adapt; }
      rate[i] = rate[i] * (1 - P.rateTau) + spike[i] * P.rateTau;
    }
    this.p1Rate    = this.groupRate('p1');
    this.motorRate = this.groupRate('motor');
  }

  groupRate(g) {
    const ids = this.net.byGroup[g];
    if (!ids.length) return 0;
    let s = 0;
    for (const i of ids) s += this.rate[i];
    return s / ids.length;
  }

  // Build sensory drive from a sensed situation (see sense() in app.js).
  driveFor(s) {
    const ext = this.ext.fill(0);
    const add = (kind, val) => {
      for (const id of STIMULUS_MAP[kind]) {
        const i = this.net.index.get(id);
        if (i !== undefined) ext[i] = Math.max(ext[i], val);
      }
    };
    if (s.threat > 0)  add('enemy', s.social);
    if (s.isLover)     add('lover', s.social);
    if (s.friendNear)  add('friend', s.social);
    if (s.food)        add('food', 0.9);
    if (s.sad)         add('drama', 0.9);
    return ext;
  }

  // One simulation tick: sense -> network -> emotion readout.
  // All emotions are read out from the same P1 population rate plus context
  // (threat, food, drama, partner type); there are no per-emotion circuits.
  tick(s) {
    this.step(this.driveFor(s));
    const p1 = this.p1Rate;
    const r  = this.r;
    const threat = Math.max(s.threat, s.sad ? 0.55 : 0);
    r.love  = (s.isLover && !s.friendNear && threat < 0.20) ? clamp(p1 * 1.45, 0, 1) : 0;
    r.angry = (s.threat > 0 && p1 > 0.18) ? clamp(p1 * (0.4 + s.threat) * 1.6, 0.25, 1) : 0;
    r.happy = s.food ? clamp(p1 * 1.30, 0.25, 1) : 0;
    r.sad   = s.sad  ? clamp(p1 * 1.35, 0.30, 1) : 0;
    r.chill = s.friendNear ? clamp(p1 * 1.1, 0.18, 0.40) : 0;
    return r;
  }
}

// Dominant emotion: strongest readout above 0.2, else chill near a friend,
// else calm. Food and drama zones are not masked by a nearby friend.
function dominant(r, friendNear) {
  let k = 'calm', v = .2;
  for (const q of ['sad', 'happy', 'love', 'angry']) if (r[q] > v) { k = q; v = r[q]; }
  if (k === 'calm' && friendNear) k = 'chill';
  return k;
}

// Canonical sensed situation for each emotion, used by the circuit explorer.
const SCENARIOS = {
  love : { social: .8, threat: 0,  isLover: true,  friendNear: false, food: 0, sad: false },
  angry: { social: .8, threat: .8, isLover: false, friendNear: false, food: 0, sad: false },
  chill: { social: .27, threat: 0, isLover: false, friendNear: true,  food: 0, sad: false },
  happy: { social: 0,  threat: 0,  isLover: false, friendNear: false, food: 1, sad: false },
  sad  : { social: 0,  threat: 0,  isLover: false, friendNear: false, food: 0, sad: true  },
};

// Run the model on a fixed stimulus and report what actually carried signal:
// per-neuron spike counts and per-edge transmitted spikes.
function probe(net, scenario, ticks = 120, minRate = 0.04) {
  const b = new Brain(net);
  const spikes = new Float32Array(net.neurons.length);
  const edgeSpikes = new Float32Array(net.edges.length);
  let p1 = 0;
  for (let t = 0; t < ticks; t++) {
    b.tick(scenario);
    net.edges.forEach((e, k) => { if (b.spike[e.from]) edgeSpikes[k]++; });
    b.spike.forEach((s, i) => { spikes[i] += s; });
    p1 += b.p1Rate;
  }
  const active = new Set();
  net.neurons.forEach((n, i) => { if (spikes[i] / ticks >= minRate) active.add(n.id); });
  const edges = net.edges
    .map((e, k) => ({ ...e, transmitted: edgeSpikes[k] }))
    .filter(e => e.transmitted > 0 && active.has(e.pre) && active.has(e.post));
  return {
    active,
    edges,
    rates: Object.fromEntries(net.neurons.map((n, i) => [n.id, spikes[i] / ticks])),
    meanP1: p1 / ticks,
  };
}

return { PARAMS, clamp, Connectome, Brain, dominant, probe, SCENARIOS, STIMULUS_MAP, GROUPS };
});
