import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function importOutsideServer(path: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "--eval", `import(${JSON.stringify(path)})`], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_OPTIONS: "" },
    encoding: "utf8",
    timeout: 15_000,
  });
}

test("серверные модули запрещены без условия react-server", () => {
  for (const path of ["./lib/server/storage.ts", "./lib/server/db/index.ts", "./lib/server/db/migrate.ts"]) {
    const result = importOutsideServer(path);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, path);
    assert.match(result.stderr, /cannot be imported from a Client Component/, path);
  }
});

test("контракты импортируются без серверных зависимостей", () => {
  for (const name of ["projects", "datasets", "runs", "recommendations"]) {
    const result = importOutsideServer(`./lib/contracts/${name}.ts`);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  }
});
