import assert from "node:assert/strict";
import { test } from "node:test";

const { ApiClientError, requestApi } = await import("../../lib/client/procurement-api.ts");
const { RequestScope } = await import("../../lib/client/request-scope.ts");

const origin = "https://app.example";
const decodeObject = (value) => {
  if (!value || typeof value !== "object" || typeof value.id !== "string") throw new Error("schema");
  return { id: value.id };
};
const ok = (data) => Response.json({ data });
const failure = (status, code = "SOME_CODE", requestId = "req-123") =>
  Response.json({ error: { code, message: "<script>secret stack</script>", requestId, details: { stack: "secret" } } }, { status });
const base = { method: "GET", path: "/api/projects", decode: decodeObject };

async function caught(promise) {
  try { await promise; assert.fail("expected rejection"); }
  catch (error) { assert.ok(error instanceof ApiClientError); return error; }
}

test("same-origin JSON transport decodes only data and encodes query safely", async () => {
  let calls = 0;
  const result = await requestApi({ ...base, query: { q: "А Б&В", limit: 50, omitted: null } }, {
    origin,
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, "https://app.example/api/projects?q=%D0%90+%D0%91%26%D0%92&limit=50");
      assert.equal(init.method, "GET");
      assert.equal(init.credentials, "same-origin");
      assert.equal(init.redirect, "error");
      assert.equal(init.cache, "no-store");
      assert.equal(init.headers.Accept, "application/json");
      assert.equal(init.body, undefined);
      return ok({ id: "p1" });
    },
  });
  assert.deepEqual(result, { id: "p1" });
  assert.equal(calls, 1);
});

test("typed status errors preserve only safe code and requestId, never server text", async () => {
  for (const [status, kind] of [[401, "unauthenticated"], [403, "forbidden"], [404, "not_found"],
    [409, "conflict"], [422, "invalid_input"], [503, "unavailable"]]) {
    const error = await caught(requestApi(base, { origin, fetchImpl: async () => failure(status) }));
    assert.equal(error.kind, kind);
    assert.equal(error.status, status);
    assert.equal(error.code, "SOME_CODE");
    assert.equal(error.requestId, "req-123");
    assert.equal(error.message.includes("secret"), false);
    assert.equal(JSON.stringify(error).includes("stack"), false);
  }
  const malformed = await caught(requestApi(base, { origin, fetchImpl: async () =>
    new Response("<html>secret</html>", { status: 409, headers: { "Content-Type": "text/html" } }) }));
  assert.equal(malformed.kind, "conflict");
  assert.equal(malformed.code, null);
  const poisoned = await caught(requestApi(base, { origin, fetchImpl: async () => failure(409, "<BAD>", "../secret") }));
  assert.equal(poisoned.kind, "conflict");
  assert.equal(poisoned.code, null);
  assert.equal(poisoned.requestId, null);
});

test("malformed success, decoder rejection, and oversized body fail closed", async () => {
  const cases = [
    Response.json({ items: [] }),
    Response.json({ data: { id: "p1" }, extra: true }),
    Response.json({ data: { wrong: true } }),
    new Response("<html>secret</html>", { headers: { "Content-Type": "text/html" } }),
    new Response("x".repeat(524_289), { headers: { "Content-Type": "application/json" } }),
  ];
  for (const response of cases) {
    const error = await caught(requestApi(base, { origin, fetchImpl: async () => response }));
    assert.equal(error.kind, "invalid_response");
    assert.equal(error.message.includes("secret"), false);
  }
  const streamed = await caught(requestApi(base, { origin, fetchImpl: async () =>
    new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array(524_289)); stream.close(); } }),
      { headers: { "Content-Type": "application/json" } }) }));
  assert.equal(streamed.kind, "invalid_response");
});

test("timeout and external cancellation settle even if fetch or body ignores abort, with no retry", async () => {
  let calls = 0;
  let signal;
  const never = (_url, init) => { calls++; signal = init.signal; return new Promise(() => {}); };
  const timeout = await caught(requestApi({ ...base, timeoutMs: 5 }, { origin, fetchImpl: never }));
  assert.equal(timeout.kind, "timeout");
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);

  const external = new AbortController();
  const promise = requestApi({ ...base, signal: external.signal }, { origin, fetchImpl: never });
  external.abort();
  const canceled = await caught(promise);
  assert.equal(canceled.kind, "cancelled");
  assert.equal(calls, 2);

  let bodyCanceled = false;
  const bodyTimeout = await caught(requestApi({ ...base, timeoutMs: 5 }, { origin, fetchImpl: async () =>
    new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode("{")); },
      cancel() { bodyCanceled = true; },
    }),
      { headers: { "Content-Type": "application/json" } }) }));
  assert.equal(bodyTimeout.kind, "timeout");
  assert.equal(bodyCanceled, true);

  let resolveFetch;
  let lateCanceled = false;
  const late = requestApi({ ...base, timeoutMs: 5 }, { origin,
    fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }),
  });
  assert.equal((await caught(late)).kind, "timeout");
  resolveFetch(new Response(new ReadableStream({ cancel() { lateCanceled = true; } }),
    { headers: { "Content-Type": "application/json" } }));
  await Promise.resolve();
  assert.equal(lateCanceled, true);
});

test("untrusted paths, redirects, queries and bodies are rejected before fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return ok({ id: "p1" }); };
  for (const path of ["https://evil.example/api/projects", "//evil.example/api/projects", "/api/../admin", "/api/projects?next=https://evil.example", "/api/projects\\evil", "/auth/sign-in"]) {
    const error = await caught(requestApi({ ...base, path }, { origin, fetchImpl }));
    assert.equal(error.kind, "invalid_request");
  }
  for (const query of [{ "bad.key": "x" }, { q: "x".repeat(513) }, { limit: Number.NaN }]) {
    const error = await caught(requestApi({ ...base, query }, { origin, fetchImpl }));
    assert.equal(error.kind, "invalid_request");
  }
  const getBody = await caught(requestApi({ ...base, body: { x: 1 } }, { origin, fetchImpl }));
  assert.equal(getBody.kind, "invalid_request");
  const huge = await caught(requestApi({ ...base, method: "POST", body: { value: "x".repeat(70_000) } }, { origin, fetchImpl }));
  assert.equal(huge.kind, "invalid_request");
  assert.equal(calls, 0);
  const redirect = await caught(requestApi(base, { origin, fetchImpl: async () =>
    new Response(null, { status: 302, headers: { Location: "https://evil.example" } }) }));
  assert.equal(redirect.kind, "invalid_response");
});

test("mutations send one JSON request and do not automatically retry 409 or network errors", async () => {
  let calls = 0;
  const mutation = { method: "PATCH", path: "/api/projects/p1", body: { name: "Проект" }, decode: decodeObject };
  const conflict = await caught(requestApi(mutation, { origin, fetchImpl: async (_url, init) => {
    calls++;
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(init.body), { name: "Проект" });
    return failure(409);
  } }));
  assert.equal(conflict.kind, "conflict");
  assert.equal(calls, 1);
  const network = await caught(requestApi(mutation, { origin, fetchImpl: async () => { calls++; throw new Error("secret host"); } }));
  assert.equal(network.kind, "network");
  assert.equal(network.message.includes("secret"), false);
  assert.equal(calls, 2);
});

test("scope switch, logout and dispose abort old work; late success/error cannot commit", async () => {
  const scope = new RequestScope();
  scope.setScope("project-a", "run-1");
  let resolveOld;
  let rejectOld;
  let oldSignal;
  const commits = [];
  const errors = [];
  const handlers = { onSuccess(value) { commits.push(value); }, onError(error) { errors.push(error); } };
  const pending = scope.run((signal) => { oldSignal = signal; return new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }); }, handlers);
  await Promise.resolve();
  scope.setScope("project-b", "run-2");
  assert.equal(oldSignal.aborted, true);
  assert.equal(await pending, "stale");
  resolveOld("old success");
  await Promise.resolve();
  assert.deepEqual(commits, []);
  const fresh = await scope.run(async () => "new success", handlers);
  assert.equal(fresh, "applied");
  assert.deepEqual(commits, ["new success"]);
  const lateError = scope.run(() => new Promise((_, reject) => { rejectOld = reject; }), handlers);
  await Promise.resolve();
  scope.logout();
  assert.equal(await lateError, "stale");
  rejectOld(new Error("old secret"));
  await Promise.resolve();
  assert.deepEqual(errors, []);
  assert.equal(await scope.run(async () => "cannot run", handlers), "stale");
  scope.setScope("project-c", null);
  scope.dispose();
  assert.equal(await scope.run(async () => "cannot run", handlers), "stale");
});

test("same scope keeps current requests; immediate switch prevents an unstarted operation", async () => {
  const scope = new RequestScope();
  scope.setScope("p1", "r1");
  let resolve;
  const commits = [];
  const handlers = { onSuccess(value) { commits.push(value); }, onError() { assert.fail("unexpected error"); } };
  const pending = scope.run(() => new Promise((yes) => { resolve = yes; }), handlers);
  await Promise.resolve();
  scope.setScope("p1", "r1");
  resolve("kept");
  assert.equal(await pending, "applied");
  let calls = 0;
  const unstarted = scope.run(() => { calls++; return Promise.resolve("bad"); }, handlers);
  scope.setScope("p2", "r2");
  assert.equal(await unstarted, "stale");
  assert.equal(calls, 0);
  assert.deepEqual(commits, ["kept"]);
  scope.dispose();
});
