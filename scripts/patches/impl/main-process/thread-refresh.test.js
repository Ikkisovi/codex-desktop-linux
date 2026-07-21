"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const {
  applyLinuxThreadStateRefreshPatch,
} = require("./thread-refresh.js");

function fixture() {
  return [
    "class AppService{",
    "constructor(){this.appViewsByWebContentsId=new Map}",
    "broadcastQueryCacheInvalidation(queryKey){messages.push(queryKey)}",
    "async registerAppView(webContents,services){this.appViewsByWebContentsId.set(webContents.id,services)}",
    "}",
    "function buildMenu(){",
    "let view={label:`View`,id:commands.menu.view,submenu:[]},items=[];",
    "view.submenu=items;let debug=[],menus=[];",
    "return items",
    "}",
  ].join("");
}

test("refreshes thread queries from F5 without reloading a window", () => {
  const patched = applyLinuxThreadStateRefreshPatch(fixture());
  const messages = [];
  const context = {
    commands: { menu: { view: "view" } },
    messages,
    process: { env: { HOME: "/home/test" }, platform: "linux" },
    require(name) {
      if (name === "node:path") return { join: (...parts) => parts.join("/") };
      if (name === "node:fs") return { readdirSync: () => [] };
      throw new Error(`Unexpected require: ${name}`);
    },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(patched, context);
  const service = vm.runInNewContext("new AppService()", context);
  service.registerAppView({ id: 1 }, {});

  const menu = context.buildMenu();
  assert.equal(menu[0].label, "Refresh Threads");
  assert.equal(menu[0].accelerator, "F5");
  menu[0].click();

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    ["recent-conversations"],
    ["recent-conversations-meta"],
  ]);
  assert.doesNotMatch(patched, /\.reload\(/);
});

test("polls only Codex state database files and throttles refresh broadcasts", async () => {
  const patched = applyLinuxThreadStateRefreshPatch(fixture());
  const messages = [];
  const watchedPaths = [];
  const watchCallbacks = new Map();
  const context = {
    commands: { menu: { view: "view" } },
    messages,
    process: { env: { CODEX_HOME: "/custom/codex" }, platform: "linux" },
    require(name) {
      if (name === "node:path") return { join: (...parts) => parts.join("/") };
      if (name === "node:fs") {
        return {
          readdirSync(path) {
            assert.equal(path, "/custom/codex");
            return ["config.toml", "state_5.sqlite", "state_4.sqlite"];
          },
          watchFile(path, options, callback) {
            assert.equal(options.persistent, false);
            assert.equal(options.interval, 1000);
            watchedPaths.push(path);
            watchCallbacks.set(path, callback);
          },
        };
      }
      throw new Error(`Unexpected require: ${name}`);
    },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(patched, context);
  const service = vm.runInNewContext("new AppService()", context);
  service.registerAppView({ id: 1 }, {});

  assert.deepEqual(watchedPaths, [
    "/custom/codex/state_5.sqlite",
    "/custom/codex/state_5.sqlite-wal",
    "/custom/codex/state_5.sqlite-shm",
    "/custom/codex/state_4.sqlite",
    "/custom/codex/state_4.sqlite-wal",
    "/custom/codex/state_4.sqlite-shm",
  ]);
  watchCallbacks.get("/custom/codex/state_5.sqlite-wal")(
    { ino: 2, mtimeMs: 20, size: 200 },
    { ino: 2, mtimeMs: 10, size: 100 },
  );
  watchCallbacks.get("/custom/codex/state_5.sqlite-shm")(
    { ino: 2, mtimeMs: 20, size: 200 },
    { ino: 2, mtimeMs: 10, size: 100 },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(
    JSON.parse(JSON.stringify(messages)),
    [["recent-conversations"], ["recent-conversations-meta"]],
  );
});

test("is idempotent and fails soft when current upstream anchors drift", () => {
  const once = applyLinuxThreadStateRefreshPatch(fixture());
  assert.equal(applyLinuxThreadStateRefreshPatch(once), once);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(applyLinuxThreadStateRefreshPatch("let source=`drifted`;"), "let source=`drifted`;");
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, [
    "WARN: Could not find thread state refresh anchors - skipping Linux thread refresh patch",
  ]);
});
