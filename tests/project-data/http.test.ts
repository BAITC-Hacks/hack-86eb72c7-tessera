import assert from "node:assert/strict";
import test from "node:test";
import { createProjectDataHandlers } from "../../lib/server/project-data-http";
import { UnauthenticatedError, requireSameOrigin } from "../../lib/server/auth-policy";

const endpoint = "http://localhost/api/projects";

test("HTTP: без сессии возвращается 401 до доступа к сервисам", async () => {
  let called = false;
  const handlers = createProjectDataHandlers({
    requireUserId: async () => { throw new UnauthenticatedError(); },
    requireSameOrigin,
    getServices: () => { called = true; throw new Error("Сервисы не должны вызываться"); },
  });
  const response = await handlers.listProjects(new Request(endpoint));
  assert.equal(response.status, 401);
  assert.ok((await response.json()).error);
  assert.equal(called, false);
});

test("HTTP: чужой Origin блокируется до чтения тела и сервисов", async () => {
  let called = false;
  const handlers = createProjectDataHandlers({
    requireUserId: async () => "owner-a",
    requireSameOrigin,
    getServices: () => { called = true; throw new Error("Сервисы не должны вызываться"); },
  });
  const response = await handlers.createProject(new Request(endpoint, {
    method: "POST", headers: { Origin: "https://foreign.invalid", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Проект" }),
  }));
  assert.equal(response.status, 403);
  assert.equal(called, false);
});

test("HTTP: некорректный JSON не раскрывает внутреннюю ошибку", async () => {
  const handlers = createProjectDataHandlers({
    requireUserId: async () => "owner-a",
    requireSameOrigin,
    getServices: () => { throw new Error("private-database-password"); },
  });
  const response = await handlers.createProject(new Request(endpoint, {
    method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json" }, body: "{",
  }));
  assert.equal(response.status, 400);
  assert.ok(!(await response.text()).includes("private-database-password"));
});

test("HTTP: лимит страницы и неверный UUID отклоняются до сервисов", async () => {
  const handlers = createProjectDataHandlers({
    requireUserId: async () => "owner-a", requireSameOrigin,
    getServices: () => { throw new Error("Сервисы не должны вызываться"); },
  });
  assert.equal((await handlers.listProjects(new Request(endpoint + "?limit=101"))).status, 422);
  assert.equal((await handlers.getProject(new Request(endpoint + "/invalid"), {
    params: Promise.resolve({ projectId: "invalid" }),
  })).status, 422);
});
