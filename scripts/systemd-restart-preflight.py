"""Read-only dependency gate. Input: reviewed systemctl-show JSON; never runs systemctl."""
import argparse
import json

PROPAGATING = ('RequiredBy', 'BoundBy', 'ConsistsOf', 'PropagatesStopTo')
INVERSE = {'Requires': 'RequiredBy', 'BindsTo': 'BoundBy', 'PartOf': 'ConsistsOf',
           'StopPropagatedFrom': 'PropagatesStopTo'}


def analyze(graph, target, authorized=()):
    nodes = {name: dict(row.get('properties', row)) for name, row in graph.items()}
    if target not in nodes:
        return {'go': False, 'reason': 'TARGET_NOT_CAPTURED', 'affected': [], 'edges': []}
    edges = set()
    for name, props in nodes.items():
        for relation in PROPAGATING:
            for other in props.get(relation, '').split():
                edges.add((name, other, relation))
        for relation, reverse in INVERSE.items():
            for other in props.get(relation, '').split():
                edges.add((other, name, reverse))
    seen, pending = {target}, [target]
    while pending:
        current = pending.pop()
        for source, dest, _ in edges:
            if source == current and dest not in seen:
                seen.add(dest)
                pending.append(dest)
    missing = sorted(seen - nodes.keys())
    unauthorized = sorted(seen - {target, *authorized})
    # Hooks may call service managers or arbitrary scripts; graph alone cannot prove them safe.
    hooks = {name: {key: value for key, value in nodes.get(name, {}).items()
                   if key in ('ExecStartPre', 'ExecStartPost', 'ExecStop', 'ExecStopPost', 'ExecReload', 'OnFailure', 'OnSuccess') and value}
             for name in seen}
    hooks = {name: value for name, value in hooks.items() if value}
    return {'go': not unauthorized and not missing and not hooks,
            'reason': 'PROPAGATION_OR_HOOKS_REQUIRE_REVIEW' if unauthorized or missing or hooks else 'GRAPH_GATE_PASSED_ONLY',
            'affected': sorted(seen), 'unauthorized': unauthorized, 'missingUnits': missing,
            'hooksRequireReview': hooks, 'edges': sorted(edge for edge in edges if edge[0] in seen)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('snapshot')
    parser.add_argument('--target', default='netvision-api.service')
    parser.add_argument('--authorized-service', action='append', default=[])
    args = parser.parse_args()
    with open(args.snapshot, encoding='utf8') as source:
        snapshot = json.load(source)
    result = analyze(snapshot.get('graph', snapshot), args.target, args.authorized_service)
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result['go'] else 2)
