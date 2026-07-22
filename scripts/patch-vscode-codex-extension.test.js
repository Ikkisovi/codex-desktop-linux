#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  BACKUP_SUFFIX,
  REPORT_NAME,
  applyExtensionPatch,
  discoverExtensionDir,
  inspectExtension,
} = require("./patch-vscode-codex-extension.js");
const {
  PATCH_MARKER,
} = require("../linux-features/shallow-repository-watches/patch.js");

function extensionBundleSource() {
  return [
    "var LocalHost=class{",
    "async platformPath(){return E.default.posix}",
    "async startFileWatch(e){let t=jH(),n=!1,r=await this.platformPath(),",
    "i=(0,w.watch)(this.getFileSystemPath(e.path),{recursive:e.recursive},()=>{});",
    "return{coverage:{recursive:e.recursive},path:e.path,closed:t.promise}}",
    "};",
  ].join("");
}

function createExtension(root, version = "26.715.61943") {
  const extensionDir = path.join(
    root,
    ".vscode",
    "extensions",
    `openai.chatgpt-${version}-linux-x64`,
  );
  fs.mkdirSync(path.join(extensionDir, "out"), { recursive: true });
  fs.writeFileSync(
    path.join(extensionDir, "package.json"),
    JSON.stringify({
      name: "chatgpt",
      publisher: "openai",
      version,
      main: "./out/extension.js",
    }),
  );
  fs.writeFileSync(path.join(extensionDir, "out", "extension.js"), extensionBundleSource());
  return extensionDir;
}

test("discovers and safely patches the newest installed Codex extension", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-vscode-extension-"));
  try {
    createExtension(root, "26.700.1");
    const extensionDir = createExtension(root, "26.715.61943");
    const now = new Date();
    fs.utimesSync(extensionDir, now, new Date(now.getTime() + 1000));

    assert.equal(discoverExtensionDir(root), extensionDir);
    const inspection = inspectExtension(extensionDir);
    assert.equal(inspection.result.changed, 1);
    assert.equal(inspection.markerCount, 1);

    const applied = applyExtensionPatch(inspection);
    assert.equal(applied.status, "applied");
    const bundlePath = path.join(extensionDir, "out", "extension.js");
    const backupPath = `${bundlePath}${BACKUP_SUFFIX}`;
    assert.equal(fs.readFileSync(backupPath, "utf8"), extensionBundleSource());
    assert.equal(
      fs.readFileSync(bundlePath, "utf8").split(PATCH_MARKER).length - 1,
      1,
    );
    const report = JSON.parse(
      fs.readFileSync(path.join(extensionDir, REPORT_NAME), "utf8"),
    );
    assert.equal(report.extensionVersion, "26.715.61943");
    assert.equal(report.activation, "next-extension-host-start");

    const second = applyExtensionPatch(inspectExtension(extensionDir));
    assert.equal(second.status, "already-applied");
    assert.equal(fs.readFileSync(backupPath, "utf8"), extensionBundleSource());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unrelated extensions and drifted bundles without writing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-vscode-extension-drift-"));
  try {
    const extensionDir = createExtension(root);
    const packagePath = path.join(extensionDir, "package.json");
    fs.writeFileSync(
      packagePath,
      JSON.stringify({
        name: "chatgpt",
        publisher: "someone-else",
        version: "1.0.0",
        main: "./out/extension.js",
      }),
    );
    assert.throws(() => inspectExtension(extensionDir), /expected openai\.chatgpt/);

    fs.writeFileSync(
      packagePath,
      JSON.stringify({
        name: "chatgpt",
        publisher: "openai",
        version: "1.0.0",
        main: "./out/extension.js",
      }),
    );
    const bundlePath = path.join(extensionDir, "out", "extension.js");
    fs.writeFileSync(bundlePath, "var unrelated=true;");
    assert.throws(
      () => inspectExtension(extensionDir),
      /exactly one local startFileWatch implementation/,
    );
    assert.equal(fs.existsSync(`${bundlePath}${BACKUP_SUFFIX}`), false);
    assert.equal(fs.existsSync(path.join(extensionDir, REPORT_NAME)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
