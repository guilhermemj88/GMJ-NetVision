import test from "node:test";
import assert from "node:assert/strict";

process.env.MCP_SKIP_LISTEN = "1";

const {
  bgpListQuery,
  flattenBgpDashboardPeers,
  compactBgpPeer,
  compactBgpHistory,
  createNetVisionMcpServer,
} = await import("./server.js");

test("list_bgp_peers default scope is MONITORED", () => {
  assert.equal(bgpListQuery("MONITORED"), "scope=monitored");
});

test("scope ALL maps to scope=all", () => {
  assert.equal(bgpListQuery("ALL"), "scope=all");
});

test("deviceId filter is forwarded", () => {
  assert.equal(
    bgpListQuery("MONITORED", undefined, undefined, "ne8000-1"),
    "scope=monitored&deviceId=ne8000-1",
  );
});

test("state UP/DOWN filters are forwarded", () => {
  assert.equal(bgpListQuery("ALL", "UP"), "scope=all&state=up");
  assert.equal(bgpListQuery("ALL", "DOWN"), "scope=all&state=down");
});

test("flattenBgpDashboardPeers extracts peers from grouped devices", () => {
  const body = {
    summary: { peers: 2 },
    devices: [
      { id: "a", peers: [{ id: "p1" }, { id: "p2" }] },
      { id: "b", peers: [{ id: "p3" }] },
    ],
  };
  assert.deepEqual(flattenBgpDashboardPeers(body).map((p) => p.id), ["p1", "p2", "p3"]);
  assert.deepEqual(flattenBgpDashboardPeers(null), []);
});

test("compactBgpPeer flattens the interface and never leaks credentials", () => {
  const peer = {
    id: "p1",
    deviceId: "d1",
    deviceHostname: "NE8000-1",
    deviceDisplayName: "NE-8K POP CENTRO",
    peerAddress: "200.150.1.193",
    displayName: "TRANSITO XYZ",
    remoteAs: "12345",
    state: "ESTABLISHED",
    stateCode: 6,
    established: true,
    receivedPrefixes: 1099912,
    establishedSince: "2026-09-01T00:00:00.000Z",
    lastPollingAt: "2026-09-19T11:00:00.000Z",
    interface: { id: "if-1", name: "100GE1/0/3", alias: "TRANSITO XYZ", description: null, rxBps: 4800000000, txBps: 2100000000 },
  };
  const compact = compactBgpPeer(peer);
  assert.equal(compact.interfaceId, "if-1");
  assert.equal(compact.interfaceName, "100GE1/0/3");
  assert.equal(compact.rxBps, 4800000000);
  assert.equal(compact.remoteAs, "12345");
  const serialized = JSON.stringify(compact);
  assert.doesNotMatch(serialized, /password|community|token|secret/i);
});

test("compactBgpPeer serializes to JSON without BigInt", () => {
  const compact = compactBgpPeer({
    receivedPrefixes: 1099912,
    remoteAs: "12345",
  });
  assert.doesNotThrow(() => JSON.stringify(compact));
});

test("compactBgpHistory maps samples and events compactly", () => {
  const history = compactBgpHistory({
    peerId: "p1",
    samples: [
      { timestamp: "t1", state: "ESTABLISHED", established: true, receivedPrefixes: 100 },
      { timestamp: "t2", state: "ACTIVE", established: false, receivedPrefixes: null },
    ],
    events: [
      { previousState: "ESTABLISHED", currentState: "ACTIVE", occurredAt: "t2", previousStateCode: 6, currentStateCode: 3 },
    ],
  });
  assert.deepEqual(history.samples, [
    { timestamp: "t1", state: "ESTABLISHED", established: true, receivedPrefixes: 100 },
    { timestamp: "t2", state: "ACTIVE", established: false, receivedPrefixes: null },
  ]);
  assert.deepEqual(history.events, [
    { previousState: "ESTABLISHED", currentState: "ACTIVE", occurredAt: "t2" },
  ]);
});

test("BGP MCP tools are registered without api_ aliases", () => {
  const server = createNetVisionMcpServer();
  const registered = server as unknown as { _registeredTools: Record<string, unknown> };
  const names = Object.keys(registered._registeredTools);
  for (const name of ["list_bgp_peers", "get_bgp_peer", "get_bgp_peer_history", "discover_bgp", "set_bgp_monitoring"]) {
    assert.ok(names.includes(name), `missing tool ${name}`);
  }
  for (const alias of ["api_list_bgp_peers", "api_get_bgp_peer", "api_get_bgp_peer_history", "api_discover_bgp", "api_set_bgp_monitoring"]) {
    assert.ok(!names.includes(alias), `found legacy alias ${alias}`);
  }
  for (const existing of ["list_hosts", "get_host", "list_interfaces", "get_interface", "get_interface_metrics", "test_host_snmp", "discover_interfaces", "poll_host"]) {
    assert.ok(names.includes(existing), `existing tool removed: ${existing}`);
  }
});
