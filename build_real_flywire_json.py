import json
import os
from caveclient import CAVEclient

# Pin the materialization so root IDs and synapse counts are reproducible.
# Root IDs change between FlyWire releases; v783 is the public FAFB release
# these IDs were taken from.
MATERIALIZATION_VERSION = 783

TOKEN = os.environ.get('CAVE_TOKEN', '')
client = CAVEclient('flywire_fafb_public', auth_token=TOKEN) if TOKEN else CAVEclient('flywire_fafb_public')

# Selected real FlyWire neurons
selected_neurons = [
    # Sensory: aIP1 (Auditory/Mechanosensory courtship relay to P1)
    {"id": "S1", "group": "sensory", "label": "aIP1c-1", "root_id": "720575940625082910", "cell_type": "aIP1c", "desc": "Auditory relay interneuron (aIP1c)"},
    {"id": "S2", "group": "sensory", "label": "aIP1b-1", "root_id": "720575940628426946", "cell_type": "aIP1b", "desc": "Mechanosensory relay interneuron (aIP1b)"},
    {"id": "S3", "group": "sensory", "label": "aIP1b-2", "root_id": "720575940639325941", "cell_type": "aIP1b", "desc": "Sensory integrator interneuron (aIP1b)"},
    {"id": "S4", "group": "sensory", "label": "aIP1b-3", "root_id": "720575940637371992", "cell_type": "aIP1b", "desc": "Antennal lobe relay interneuron (aIP1b)"},
    
    # P1 / pC1 Cluster: aSP10 (Central courtship / aggression integration hub)
    {"id": "P1a", "group": "p1", "label": "aSP10a-1", "root_id": "720575940613034602", "cell_type": "aSP10a", "desc": "P1 hub cluster integrator (aSP10a)"},
    {"id": "P1b", "group": "p1", "label": "aSP10b-1", "root_id": "720575940625802329", "cell_type": "aSP10b", "desc": "P1 hub cluster integrator (aSP10b)"},
    {"id": "P1c", "group": "p1", "label": "aSP10a-2", "root_id": "720575940636471408", "cell_type": "aSP10a", "desc": "P1 hub cluster integrator (aSP10a)"},
    {"id": "P1d", "group": "p1", "label": "aSP10a-3", "root_id": "720575940627719294", "cell_type": "aSP10a", "desc": "P1 cluster sustainer (aSP10a)"},
    {"id": "P1e", "group": "p1", "label": "aSP10a-4", "root_id": "720575940637834301", "cell_type": "aSP10a", "desc": "P1 primary motor relay (aSP10a)"},
    {"id": "P1f", "group": "p1", "label": "aSP10a-5", "root_id": "720575940619688688", "cell_type": "aSP10a", "desc": "P1 recurrent modulator (aSP10a)"},
    
    # Motor: pIP14 (Descending command interneurons for courtship / aggressive actions)
    {"id": "M1", "group": "motor", "label": "pIP14-1", "root_id": "720575940629514296", "cell_type": "pIP14", "desc": "Descending courtship song command (pIP14)"},
    {"id": "M2", "group": "motor", "label": "pIP14-2", "root_id": "720575940628632057", "cell_type": "pIP14", "desc": "Descending wing extension command (pIP14)"},
    {"id": "M3", "group": "motor", "label": "pIP14-3", "root_id": "720575940604160172", "cell_type": "pIP14", "desc": "Descending steering / approach command (pIP14)"},
    {"id": "M4", "group": "motor", "label": "pIP14-4", "root_id": "720575940620402712", "cell_type": "pIP14", "desc": "Descending locomotor speed control (pIP14)"}
]

root_to_id = {int(n["root_id"]): n["id"] for n in selected_neurons}
all_roots = list(root_to_id)

print(f"Querying synapses among {len(all_roots)} neurons (materialization v{MATERIALIZATION_VERSION})...")
df_syn = client.materialize.query_table(
    'synapses_nt_v1',
    materialization_version=MATERIALIZATION_VERSION,
    filter_in_dict={'pre_pt_root_id': all_roots, 'post_pt_root_id': all_roots}
)
print(f"Found {len(df_syn)} synapses.")

# Drop autapses (self-connections); they are not drawn in the 3-column graph
df_syn = df_syn[df_syn['pre_pt_root_id'] != df_syn['post_pt_root_id']]

# Per-synapse neurotransmitter predictions (Eckstein et al. 2024), if present
NT_COLS = [c for c in ('gaba', 'ach', 'glut', 'oct', 'ser', 'da') if c in df_syn.columns]

grouped = df_syn.groupby(['pre_pt_root_id', 'post_pt_root_id'])
synapses = []
for (pre_root, post_root), g in grouped:
    cnt = len(g)
    # Visual/simulation weight: 1 synapse -> 0.41, saturates at 1.0 for >= 10
    w = round(min(1.0, 0.35 + (cnt / 10.0) * 0.65), 2)
    syn = {
        "pre": root_to_id[int(pre_root)],
        "post": root_to_id[int(post_root)],
        "w": w,
        "synapse_count": cnt,
        "pre_root_id": str(pre_root),
        "post_root_id": str(post_root),
    }
    if NT_COLS:
        # Edge transmitter = most likely transmitter averaged over its synapses
        syn["nt"] = max(NT_COLS, key=lambda c: g[c].mean())
    synapses.append(syn)

# No synthetic edges are added: every edge below comes from synapses_nt_v1.
print(f"Constructed {len(synapses)} edges ({sum(s['synapse_count'] for s in synapses)} synapses).")

out_data = {
    "_source": f"FlyWire FAFB public connectome (materialization v{MATERIALIZATION_VERSION})",
    "_note": "Generated via FlyWire CAVE API (datastack: flywire_fafb_public), table synapses_nt_v1. "
             "Every edge is a real pre->post synapse group among the 14 selected neurons; autapses removed. "
             "FAFB is a female brain. Root IDs are strings because they exceed JavaScript's safe integer range.",
    "_label": "FlyWire FAFB connectome - 14 neurons, real synapses",
    "neurons": selected_neurons,
    "synapses": synapses,
}

with open('flywire_p1.json', 'w', encoding='utf-8') as f:
    json.dump(out_data, f, indent=2)

print("Saved flywire_p1.json")
