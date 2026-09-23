import assert from "node:assert/strict";
import { test } from "node:test";
import { apiData, apiError } from "../../lib/contracts/api.ts";
import {
  AuthConfigurationError,
  InvalidOriginError,
  UnauthenticatedError,
  hasClerkKeys,
  requireSameOrigin,
  userIdFromSession,
} from "../../lib/server/auth-policy.ts";

test("Clerk identity is required and missing configuration cannot authenticate", () => {
  assert.equal(hasClerkKeys("pk_test_example", "sk_test_example"), true);
  assert.equal(hasClerkKeys("pk_test_example", ""), false);
  assert.equal(hasClerkKeys(" ", "sk_test_example"), false);
  assert.throws(() => userIdFromSession(null), UnauthenticatedError);
  assert.throws(() => userIdFromSession(undefined), UnauthenticatedError);
  assert.equal(userIdFromSession("user_verified_by_clerk"), "user_verified_by_clerk");
  assert.equal(new AuthConfigurationError().message, "Авторизация временно недоступна.");
});

test("cookie-backed mutations require the exact same origin", () => {
  const request = (origin) =>
    new Request("https://tessera.example/api/projects", {
      method: "POST",
      ...(origin === undefined ? {} : { headers: { Origin: origin } }),
    });

  assert.doesNotThrow(() => requireSameOrigin(request("https://tessera.example")));
  for (const origin of [undefined, "null", "https://foreign.example", "http://tessera.example"]) {
    assert.throws(() => requireSameOrigin(request(origin)), InvalidOriginError);
  }
});

test("API responses keep the canonical envelope and disable caching", async () => {
  const success = apiData({ ok: true });
  assert.deepEqual(await success.json(), { data: { ok: true } });
  assert.equal(success.headers.get("Cache-Control"), "no-store");

  const failure = apiError(401, "UNAUTHENTICATED", "Требуется вход в систему.", "request-1");
  assert.equal(failure.status, 401);
  assert.equal(failure.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await failure.json(), {
    error: {
      code: "UNAUTHENTICATED",
      message: "Требуется вход в систему.",
      requestId: "request-1",
    },
  });
});
