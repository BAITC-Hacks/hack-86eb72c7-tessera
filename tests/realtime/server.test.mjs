import assert from "node:assert/strict";
import { test } from "node:test";
import "./load-typescript.mjs";

const { authorizeRunRoom } = await import("../../lib/realtime/authorize.ts");
const { publishCommittedRunStatus } = await import("../../lib/realtime/publish-run-status.ts");
const { ensurePrivateRunRoom } = await import("../../lib/realtime/server.ts");
const { parseRoom, roomId, validEvent } = await import("../../lib/realtime/contracts.ts");

const room = "project:p1:run:r1";
const snapshot = Object.freeze({ projectId: "p1", runId: "r1", stateVersion: 3, status: "running", stage: "forecast" });
const privateData = { id: room, defaultAccesses: [], usersAccesses: {}, groupsAccesses: {} };
const request = (body) => new Request("https://example.test/api/liveblocks-auth", { method: "POST", body: JSON.stringify(body) });
function liveblocksPort(overrides = {}) {
  return {
    async getOrCreateRoom(id, options) { assert.equal(id, room); assert.deepEqual(options, { defaultAccesses: [] }); return privateData; },
    prepareSession(userId) { assert.equal(userId, "clerk-user"); return { allow(id, permissions) {
      assert.equal(id, room); assert.deepEqual(permissions, ["*:read"]);
      return { async authorize() { return { status: 200, body: JSON.stringify({ token: "synthetic-token" }) }; } };
    } }; },
    ...overrides,
  };
}

test("room syntax is exact and auth ignores client-supplied identity", async () => {
  assert.equal(roomId("p1", "r1"), room);
  assert.deepEqual(parseRoom(room), { projectId: "p1", runId: "r1", room });
  for (const invalid of ["project:p1:run:r1:*", "project:p1:run:r1:extra", "project:p*:run:r1", "project:p1:run:../r1", "project:p1:run:"]) {
    assert.equal(parseRoom(invalid), null);
  }
  let lookups = 0;
  const lookup = async (userId, projectId, runId) => {
    lookups++;
    assert.deepEqual([userId, projectId, runId], ["clerk-user", "p1", "r1"]);
    return true;
  };
  const success = await authorizeRunRoom(request({ room }), "clerk-user", lookup, liveblocksPort(), "req-1");
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { token: "synthetic-token" });
  assert.equal(success.headers.get("Cache-Control"), "no-store");
  assert.equal(lookups, 1);
  const extraIdentity = await authorizeRunRoom(request({ room, userId: "victim" }), "clerk-user", lookup, liveblocksPort(), "req-2");
  assert.equal(extraIdentity.status, 422);
});

test("auth fails with canonical 401, 404, 422, 503 and no unauthorized token call", async () => {
  let tokenCalls = 0;
  const port = liveblocksPort({ prepareSession() { tokenCalls++; throw new Error("must not be called"); } });
  const unauth = await authorizeRunRoom(request({ room }), null, async () => true, port, "req-1");
  assert.equal(unauth.status, 401);
  assert.equal((await unauth.json()).error.code, "UNAUTHENTICATED");
  const foreign = await authorizeRunRoom(request({ room }), "clerk-user", async () => false, port, "req-2");
  assert.equal(foreign.status, 404);
  const malformed = await authorizeRunRoom(request({ room: "project:p1:run:r1:*" }), "clerk-user", async () => true, port, "req-3");
  assert.equal(malformed.status, 422);
  const huge = await authorizeRunRoom(new Request("https://example.test/api/liveblocks-auth", { method: "POST", body: "x".repeat(600) }), "clerk-user", async () => true, port, "req-4");
  assert.equal(huge.status, 422);
  const unavailable = await authorizeRunRoom(request({ room }), "clerk-user", async () => true, null, "req-5");
  assert.equal(unavailable.status, 503);
  assert.equal(tokenCalls, 0);
});

test("existing public room is rejected before token issuance", async () => {
  let tokenCalls = 0;
  const port = liveblocksPort({
    async getOrCreateRoom() { return { ...privateData, defaultAccesses: ["*:read"] }; },
    prepareSession() { tokenCalls++; throw new Error("unsafe"); },
  });
  const response = await authorizeRunRoom(request({ room }), "clerk-user", async () => true, port, "req-public");
  assert.equal(response.status, 503);
  assert.equal(tokenCalls, 0);
});

test("publisher emits only allowlisted status and finite presence after private provisioning", async () => {
  const calls = [];
  const port = {
    async getOrCreateRoom(id, options, requestOptions) { calls.push(["room", id, options, Boolean(requestOptions.signal)]); return privateData; },
    async broadcastEvent(id, event, options) { calls.push(["event", id, event, Boolean(options.signal)]); },
    async setPresence(id, presence, options) { calls.push(["presence", id, presence, Boolean(options.signal)]); },
  };
  const result = await publishCommittedRunStatus(snapshot, port, { now: new Date("2026-09-23T10:00:00.000Z") });
  assert.deepEqual(result, { published: true, presence: true });
  assert.equal(calls[0][0], "room");
  assert.deepEqual(calls[0][2], { defaultAccesses: [] });
  assert.equal(calls[1][1], room);
  assert.deepEqual(Object.keys(calls[1][2]).sort(), ["emittedAt", "projectId", "runId", "stage", "stateVersion", "status", "type"]);
  assert.equal(validEvent(calls[1][2]), true);
  assert.equal(calls[2][2].ttl, 60);
  assert.equal(calls[2][2].userId, "agent:r1:forecast");
  assert.deepEqual(calls[2][2].data, { runId: "r1", stage: "forecast", status: "running" });
  assert.equal(calls[2][2].userInfo.name, "Прогноз спроса");
  assert.deepEqual(calls.map((call) => call[3]), [true, true, true]);
});

test("publisher failure never mutates run; terminal state does not refresh presence", async () => {
  const before = structuredClone(snapshot);
  const port = { async getOrCreateRoom() { return privateData; },
    async broadcastEvent() { throw new Error("secret transport body"); },
    async setPresence() { throw new Error("must not be called"); } };
  const failed = await publishCommittedRunStatus(snapshot, port);
  assert.deepEqual(failed, { published: false, presence: false, errorCode: "REALTIME_UNAVAILABLE" });
  assert.deepEqual(snapshot, before);
  const terminal = await publishCommittedRunStatus({ ...snapshot, status: "succeeded", stage: "explain" }, {
    ...port, async broadcastEvent() {},
  });
  assert.deepEqual(terminal, { published: true, presence: false });
  const publicPort = { async getOrCreateRoom() { return { ...privateData, usersAccesses: { victim: ["*:read"] } }; } };
  await assert.rejects(() => ensurePrivateRunRoom(publicPort, "p1", "r1"), /ROOM_NOT_PRIVATE/);
});
