import assert from "node:assert/strict";
import { test } from "node:test";
import "./load-typescript.mjs";

const { createLiveblocksAuthHandler } = await import("../../lib/realtime/auth-route.ts");
const { createRunOwnershipLookup } = await import("../../lib/realtime/ownership.ts");
const { UnauthenticatedError, requireSameOrigin } = await import("../../lib/server/auth-policy.ts");

const projectId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const room = `project:${projectId}:run:${runId}`;
const request = (origin = "https://example.test", body = { room }) =>
  new Request("https://example.test/api/liveblocks-auth", {
    method: "POST", headers: { Origin: origin }, body: JSON.stringify(body),
  });

function fakeLiveblocks(calls) {
  return {
    async getOrCreateRoom(id, options) {
      calls.push("room");
      assert.equal(id, room);
      assert.deepEqual(options, { defaultAccesses: [] });
      return { id, defaultAccesses: [], usersAccesses: {}, groupsAccesses: {} };
    },
    prepareSession(userId) {
      calls.push("session");
      assert.equal(userId, "owner");
      return { allow(id, permissions) {
        assert.equal(id, room);
        assert.deepEqual(permissions, ["*:read"]);
        return { async authorize() { return { status: 200, body: JSON.stringify({ token: "test-only" }) }; } };
      } };
    },
  };
}

test("ownership query checks run, project, active owner with bound parameters", async () => {
  const queries = [];
  const lookup = createRunOwnershipLookup({ async query(sql, values) {
    queries.push([sql, values]);
    return { rowCount: 1 };
  } });
  assert.equal(await lookup("owner", projectId, runId), true);
  assert.equal(queries.length, 1);
  assert.match(queries[0][0], /project\.archived_at IS NULL/);
  assert.match(queries[0][0], /run\.project_id = \$2::uuid/);
  assert.deepEqual(queries[0][1], [runId, projectId, "owner"]);
  assert.equal(await lookup("owner", "bad", runId), false);
  assert.equal(queries.length, 1);
});

test("session and same origin precede body, ownership and token issuance", async () => {
  const calls = [];
  const handler = createLiveblocksAuthHandler({
    async requireUserId() { calls.push("user"); return "owner"; },
    requireSameOrigin(value) { calls.push("origin"); requireSameOrigin(value); },
    async lookup() { calls.push("lookup"); return true; },
    getLiveblocks() { calls.push("provider"); return fakeLiveblocks(calls); },
  });
  const success = await handler(request());
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { token: "test-only" });
  assert.deepEqual(calls, ["user", "origin", "provider", "lookup", "room", "session"]);
  calls.length = 0;
  const foreignOrigin = await handler(request("https://foreign.test"));
  assert.equal(foreignOrigin.status, 403);
  assert.deepEqual(calls, ["user", "origin"]);
});

test("missing session, foreign run and missing configuration issue no token", async () => {
  let providerCalls = 0;
  const unauth = createLiveblocksAuthHandler({
    async requireUserId() { throw new UnauthenticatedError(); },
    requireSameOrigin,
    async lookup() { throw new Error("must not query"); },
    getLiveblocks() { providerCalls++; return fakeLiveblocks([]); },
  });
  assert.equal((await unauth(request())).status, 401);
  assert.equal(providerCalls, 0);
  const foreign = createLiveblocksAuthHandler({
    async requireUserId() { return "owner"; },
    requireSameOrigin,
    async lookup() { return false; },
    getLiveblocks() { providerCalls++; return fakeLiveblocks([]); },
  });
  assert.equal((await foreign(request())).status, 404);
  const missing = createLiveblocksAuthHandler({
    async requireUserId() { return "owner"; },
    requireSameOrigin,
    async lookup() { return true; },
    getLiveblocks() { return null; },
  });
  const unavailable = await missing(request());
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "REALTIME_UNAVAILABLE");
});
