# FlyMind

A playful *Drosophila* "dating & drama" simulator whose brain is a 14-neuron
subgraph of the [FlyWire](https://flywire.ai) FAFB connectome.

Steer Fly A around an arena, deploy a Lover, Enemy or Friend, drop snacks and
drama zones, and watch the neurons fire in real time.

## Run it

```sh
npm start          # serves on http://127.0.0.1:8080
```

Open that URL. Opening `index.html` directly (`file://`) won't work, because
browsers block the page from loading `flywire_p1.json`.

## Views

- **Simple**: the arena plus a one-line summary of Fly A's state.
- **Brain**: live firing of all 14 neurons, a causal trace, telemetry and a
  30-second chart of the love and anger readouts.
- **Circuits**: for each situation (lover, enemy, friend, snack, drama zone)
  the model is run offline. The view shows which neurons fire, in what
  order, and which real edges recruited them, with synapse counts and root
  IDs read from the data file.

## How the model works

`model.js` has one leaky integrate-and-fire unit per neuron in
`flywire_p1.json`, split into 4 sensory (aIP1), 6 P1-cluster (aSP10) and
4 motor (pIP14) neurons.

- Arena events drive **only the sensory neurons**. For example, a nearby
  lover drives S1 and S2, and an enemy drives S3 and S4.
- P1 and motor neurons are driven **only by spikes arriving over the real
  synapses**. Each spike adds `weight × gain` to the target neuron, where
  the weight comes from the edge's synapse count.
- Spike-frequency adaptation keeps the densely recurrent P1 cluster from
  running away, so activity dies out when input stops.
- Emotions are readouts of the same P1 population rate plus context
  (threat, food, drama, partner type). There are no separate per-emotion
  circuits.

### Limitations

This is a toy model. Please don't read it as a biological prediction.

- The stimulus-to-sensory-neuron mapping, neuron dynamics and emotion
  readouts are modelling choices.
- The current data snapshot has no neurotransmitter predictions, so every
  edge is excitatory. The build script records per-edge transmitter
  predictions when available, and GABAergic edges are then modelled as
  inhibitory.
- FAFB is a female brain, while P1 courtship neurons are male-specific (the
  female counterpart is pC1). The cell-type labels are taken as given in
  the data file and are worth double-checking against FlyWire's official
  annotations.
- `flywire_p1.json` was generated before the build script pinned a
  materialization version. Re-running the script pins v783, and counts may
  change if the snapshot came from a different release.

## Regenerating the data

```sh
pip install -r requirements.txt
CAVE_TOKEN=... python build_real_flywire_json.py
```

This queries `synapses_nt_v1` for all synapses among the 14 neurons, drops
autapses (self-connections), and writes `flywire_p1.json`. Every edge in the
output comes from the query; nothing is added by hand.

## Tests

```sh
npm test
```

The unit tests in `test/` cover the data invariants (known neurons, string
root IDs, root IDs matching their edges) and the model: silence without
input, activity dying out, P1 reachable only through synapses, each
scenario producing its emotion, and inhibition.

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | UI, arena, graphs |
| `model.js` | Connectome-driven LIF model (browser + Node) |
| `flywire_p1.json` | 14 neurons and their real synapses |
| `build_real_flywire_json.py` | Regenerates the JSON from FlyWire |
| `serve.js` | Minimal static server (localhost only, no traversal) |

References: Hoopfer et al. 2015 (*eLife*); Deutsch et al. 2020 (*Neuron*);
Dorkenwald et al. 2024 and Schlegel et al. 2024 (*Nature*, FlyWire).
