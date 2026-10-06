import test from "node:test";
import assert from "node:assert/strict";
import {
  ZABBIX_LIMIT_MAX,
  ZABBIX_READ_ONLY_METHODS,
  ZabbixError,
  clampZabbixLimit,
  normalizeZabbixHost,
  resolveZabbixConfig,
  zabbixCall,
  zabbixGetItemHistory,
  zabbixListHosts,
  zabbixListItems,
  zabbixStatus,
  type ZabbixConfig,
} from "./zabbix.js";

const TOKEN = "token-super-secreto-123";
const BASE: ZabbixConfig = {
  url: "http://zabbix.local",
  token: TOKEN,
  authMode: "AUTH_FIELD",
  timeoutMs: 5_000,
};

interface Call {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function mockFetch(responses: Array<{ status?: number; body: string }>): { calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), body, headers });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return new Response(response.body, { status: response.status ?? 200 });
  }) as typeof fetch;
  return { calls };
}

const rpc = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });

test("AUTH_FIELD envia o token no campo auth do JSON-RPC e nao no header", async () => {
  const { calls } = mockFetch([{ body: rpc([{ hostid: "1" }]) }]);
  await zabbixCall(BASE, "host.get", {});
  assert.equal(calls[0]!.body.auth, TOKEN);
  assert.equal(calls[0]!.headers.authorization, undefined);
});

test("BEARER envia o token somente no header Authorization", async () => {
  const { calls } = mockFetch([{ body: rpc([]) }]);
  await zabbixCall({ ...BASE, authMode: "BEARER" }, "host.get", {});
  assert.equal(calls[0]!.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0]!.body.auth, undefined);
});

test("apiinfo.version e chamado sem autenticacao", async () => {
  const { calls } = mockFetch([{ body: rpc("7.0.0") }]);
  const version = await zabbixCall(BASE, "apiinfo.version", {}, { authenticated: false });
  assert.equal(version, "7.0.0");
  assert.equal(calls[0]!.body.auth, undefined);
  assert.equal(calls[0]!.headers.authorization, undefined);
});

test("erro HTTP vira ZabbixError e nao vaza o token", async () => {
  mockFetch([{ status: 500, body: `falha com ${TOKEN} no corpo` }]);
  await assert.rejects(
    () => zabbixCall(BASE, "host.get", {}),
    (error: unknown) => {
      assert.ok(error instanceof ZabbixError);
      assert.ok(!error.message.includes(TOKEN), "token vazou na mensagem");
      assert.ok(error.message.includes("[REDACTED]"));
      return true;
    },
  );
});

test("erro JSON-RPC vira ZabbixError e nao vaza o token", async () => {
  mockFetch([
    { body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: `invalid params ${TOKEN}` } }) },
  ]);
  await assert.rejects(
    () => zabbixCall(BASE, "item.get", {}),
    (error: unknown) => {
      assert.ok(error instanceof ZabbixError);
      assert.ok(!error.message.includes(TOKEN));
      return true;
    },
  );
});

test("zabbix_status valida versao (sem auth) e token (com auth)", async () => {
  const { calls } = mockFetch([{ body: rpc("6.4.10") }, { body: rpc("42") }]);
  const status = await zabbixStatus(BASE);
  assert.deepEqual(status, {
    connected: true,
    version: "6.4.10",
    authenticated: true,
    authMode: "AUTH_FIELD",
    visibleHosts: 42,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.body.method, "apiinfo.version");
  assert.equal(calls[0]!.body.auth, undefined);
  assert.equal(calls[1]!.body.method, "host.get");
  assert.equal(calls[1]!.body.auth, TOKEN);
});

test("list_hosts normaliza a resposta do Zabbix", async () => {
  mockFetch([
    {
      body: rpc([
        {
          hostid: "10084",
          host: "core-01",
          name: "CORE 01",
          status: "0",
          interfaces: [
            { interfaceid: "1", ip: "10.0.0.1", type: "1", main: "1" },
            { interfaceid: "2", ip: "10.0.0.2", type: "2", main: "0" },
          ],
          inventory: { vendor: "Huawei", model: "S6730" },
        },
      ]),
    },
  ]);
  const hosts = await zabbixListHosts(BASE, {});
  assert.deepEqual(hosts[0], {
    hostId: "10084",
    hostname: "core-01",
    displayName: "CORE 01",
    status: "MONITORED",
    managementIp: "10.0.0.1",
    interfaceId: "1",
    interfaceType: "1",
    vendor: "Huawei",
    model: "S6730",
  });
});

test("list_items respeita o limite pedido", async () => {
  const { calls } = mockFetch([{ body: rpc([]) }]);
  await zabbixListItems(BASE, { hostId: "10084", limit: 7 });
  assert.equal(calls[0]!.body.params && (calls[0]!.body.params as Record<string, unknown>).limit, 7);
});

test("limite maximo e protegido", async () => {
  assert.equal(clampZabbixLimit(9999), ZABBIX_LIMIT_MAX);
  assert.equal(clampZabbixLimit(0), 1);
  assert.equal(clampZabbixLimit(undefined), 50);
  const { calls } = mockFetch([{ body: rpc([]) }]);
  await zabbixListHosts(BASE, { limit: 9999 });
  assert.equal((calls[0]!.body.params as Record<string, unknown>).limit, ZABBIX_LIMIT_MAX);
});

test("history escolhe o tipo correto pelo value_type (nao assume 3)", async () => {
  const { calls } = mockFetch([
    { body: rpc([{ itemid: "9", value_type: "0", name: "temp" }]) },
    { body: rpc([{ clock: "1700000000", value: "21.5" }]) },
  ]);
  const history = await zabbixGetItemHistory(BASE, { itemId: "9", period: "1h" });
  assert.equal(history.historyType, 0);
  assert.equal((calls[1]!.body.params as Record<string, unknown>).history, 0);
  assert.deepEqual(history.samples, [{ timestamp: "1700000000", value: "21.5" }]);
});

test("nenhuma escrita e permitida: allowlist so de leitura e chamada de escrita recusada", async () => {
  for (const method of ZABBIX_READ_ONLY_METHODS) {
    assert.ok(!/\.(create|update|delete|execute)$/.test(method), `metodo de escrita na allowlist: ${method}`);
  }
  for (const forbidden of ["host.create", "item.update", "trigger.delete", "script.execute", "maintenance.create", "user.get", "token.create"]) {
    await assert.rejects(
      () => zabbixCall(BASE, forbidden, {}),
      (error: unknown) => {
        assert.ok(error instanceof ZabbixError);
        assert.match(error.message, /somente leitura/);
        return true;
      },
    );
  }
});

test("resolveZabbixConfig usa AUTH_FIELD por default e BEARER quando pedido", () => {
  assert.equal(resolveZabbixConfig({ ZABBIX_URL: "http://z/", ZABBIX_TOKEN: "t" })?.authMode, "AUTH_FIELD");
  assert.equal(
    resolveZabbixConfig({ ZABBIX_URL: "http://z", ZABBIX_TOKEN: "t", ZABBIX_AUTH_MODE: "bearer" })?.authMode,
    "BEARER",
  );
  assert.equal(resolveZabbixConfig({ ZABBIX_URL: "http://z" }), null);
  assert.equal(resolveZabbixConfig({ ZABBIX_TOKEN: "t" }), null);
});

test("normalizeZabbixHost nao expoe campos desconhecidos", () => {
  const normalized = normalizeZabbixHost({
    hostid: "1",
    host: "h",
    name: "H",
    status: "1",
    interfaces: [],
    inventory: {},
    secretField: TOKEN,
  });
  assert.equal(JSON.stringify(normalized).includes(TOKEN), false);
  assert.equal(normalized.status, "UNMONITORED");
});
