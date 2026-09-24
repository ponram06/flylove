const test = require('node:test');
const assert = require('node:assert');
const M = require('../model.js');
const data = require('../flywire_p1.json');

const net = new M.Connectome(data);
const NONE = { social: 0, threat: 0, isLover: false, friendNear: false, food: 0, sad: false };

function run(scenario, ticks = 90) {
  const b = new M.Brain(net);
  let r;
  for (let i = 0; i < ticks; i++) r = b.tick(scenario);
  return { b, r };
}

test('data: every edge references known neurons and carries real root IDs', () => {
  const ids = new Map(data.neurons.map(n => [n.id, n.root_id]));
  for (const s of data.synapses) {
    assert.ok(ids.has(s.pre) && ids.has(s.post), `unknown neuron in ${s.pre}->${s.post}`);
    assert.strictEqual(s.pre_root_id, ids.get(s.pre));
    assert.strictEqual(s.post_root_id, ids.get(s.post));
    assert.ok(Number.isInteger(s.synapse_count) && s.synapse_count > 0);
  }
});

test('data: root IDs are strings so JS does not round them', () => {
  for (const n of data.neurons) assert.match(n.root_id, /^\d{18}$/);
});

test('silent input leaves the network silent', () => {
  const { b } = run(NONE);
  assert.strictEqual(b.p1Rate, 0);
  assert.strictEqual(b.motorRate, 0);
});

test('activity dies out after the stimulus is removed', () => {
  for (const k of ['love', 'angry', 'sad', 'happy']) {
    const { b } = run(M.SCENARIOS[k], 60);
    for (let i = 0; i < 60; i++) b.tick(NONE);
    assert.ok(b.p1Rate < 0.02, `${k} kept P1 at ${b.p1Rate}`);
  }
});

test('P1 is reached only through synapses, not external drive', () => {
  const b = new M.Brain(net);
  const ext = b.driveFor(M.SCENARIOS.angry);
  for (const i of net.byGroup.p1) assert.strictEqual(ext[i], 0);
  for (const i of net.byGroup.motor) assert.strictEqual(ext[i], 0);
});

test('removing all synapses cuts P1 off from the senses', () => {
  const cut = new M.Connectome({ ...data, synapses: [] });
  const b = new M.Brain(cut);
  for (let i = 0; i < 90; i++) b.tick(M.SCENARIOS.love);
  assert.strictEqual(b.p1Rate, 0);
});

test('each canonical scenario produces its emotion', () => {
  for (const [k, sc] of Object.entries(M.SCENARIOS)) {
    const { r } = run(sc);
    assert.strictEqual(M.dominant(r, sc.friendNear), k);
  }
});

test('a far-away lover does not trigger love', () => {
  const { r } = run({ ...M.SCENARIOS.love, social: 0.1 });
  assert.strictEqual(M.dominant(r, false), 'calm');
});

test('a nearby friend does not mask snack or drama zone', () => {
  const { r: rFood } = run({ ...M.SCENARIOS.happy, friendNear: true, social: .27 });
  assert.strictEqual(M.dominant(rFood, true), 'happy');
  const { r: rDrama } = run({ ...M.SCENARIOS.sad, friendNear: true, social: .27 });
  assert.strictEqual(M.dominant(rDrama, true), 'sad');
});

test('inhibitory edges subtract instead of add', () => {
  const syn = data.synapses.map(s => ({ ...s, nt: 'gaba' }));
  const inh = new M.Connectome({ ...data, synapses: syn });
  assert.strictEqual(inh.inhibitoryCount, syn.length);
  const b = new M.Brain(inh);
  for (let i = 0; i < 90; i++) b.tick(M.SCENARIOS.angry);
  assert.strictEqual(b.p1Rate, 0);
});

test('probe reports only edges that exist in the data', () => {
  const keys = new Set(data.synapses.map(s => s.pre + '>' + s.post));
  for (const sc of Object.values(M.SCENARIOS)) {
    for (const e of M.probe(net, sc).edges) assert.ok(keys.has(e.pre + '>' + e.post));
  }
});
