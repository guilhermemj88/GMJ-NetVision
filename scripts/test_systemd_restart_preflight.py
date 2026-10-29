import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('preflight', Path(__file__).with_name('systemd-restart-preflight.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DependencyGate(unittest.TestCase):
    def test_requires_reverse_is_sufficient_to_block_api_only(self):
        graph = {'api': {}, 'mcp': {'Requires': 'api', 'After': 'api'}}
        self.assertEqual(module.analyze(graph, 'api')['unauthorized'], ['mcp'])

    def test_effective_required_by_even_without_forward_capture(self):
        self.assertFalse(module.analyze({'api': {'RequiredBy': 'mcp'}}, 'api')['go'])

    def test_transitive_partof_bindsto_and_stop_propagation(self):
        graph = {'api': {}, 'mcp': {'Requires': 'api'}, 'worker': {'PartOf': 'mcp'},
                 'child': {'BindsTo': 'worker'}, 'extra': {'StopPropagatedFrom': 'child'}}
        self.assertEqual(module.analyze(graph, 'api')['affected'], ['api', 'child', 'extra', 'mcp', 'worker'])

    def test_wants_after_and_requisite_are_not_restart_edges(self):
        graph = {'api': {}, 'mcp': {'Wants': 'api', 'After': 'api', 'Requisite': 'api'}}
        self.assertTrue(module.analyze(graph, 'api')['go'])

    def test_joint_authorization_still_requires_all_units_and_hooks(self):
        graph = {'api': {}, 'mcp': {'Requires': 'api', 'ExecStartPost': 'external-script'}}
        self.assertFalse(module.analyze(graph, 'api', ['mcp'])['go'])
        graph['mcp'].pop('ExecStartPost')
        self.assertTrue(module.analyze(graph, 'api', ['mcp'])['go'])

    def test_absent_target_is_no_go(self):
        self.assertFalse(module.analyze({}, 'api')['go'])


if __name__ == '__main__':
    unittest.main()
