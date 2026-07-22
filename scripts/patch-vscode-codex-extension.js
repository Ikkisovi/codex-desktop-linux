#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  PATCH_MARKER,
  patchWorkerSource,
} = require("../linux-features/shallow-repository-watches/patch.js");

const EXTENSION_ID = "openai.chatgpt";
const BACKUP_SUFFIX = ".codex-linux-original";
const REPORT_NAME = ".codex-linux-shallow-watch.json";

function sha256(source) {
  return crypto.createHash("sha256").update(source).digest("hex");
}

function parseArgs(argv) {
  const options = {
    apply: false,
    extensionDir: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      options.apply = true;
      continue;
    }
    if (argument === "--extension-dir") {
      options.extensionDir = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function compareExtensionDirectories(left, right) {
  const leftStat = fs.statSync(left);
  const rightStat = fs.statSync(right);
  return rightStat.mtimeMs - leftStat.mtimeMs || right.localeCompare(left);
}

function discoverExtensionDir(homeDir = os.homedir()) {
  const roots = [
    path.join(homeDir, ".vscode", "extensions"),
    path.join(homeDir, ".vscode-oss", "extensions"),
  ];
  const candidates = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        entry.name.startsWith(`${EXTENSION_ID}-`) &&
        !entry.name.endsWith(".obsolete")
      ) {
        candidates.push(path.join(root, entry.name));
      }
    }
  }
  candidates.sort(compareExtensionDirectories);
  return candidates[0] ?? null;
}

function readExtensionMetadata(extensionDir) {
  const packagePath = path.join(extensionDir, "package.json");
  const metadata = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  if (metadata.publisher !== "openai" || metadata.name !== "chatgpt") {
    throw new Error(
      `Refusing to patch ${extensionDir}: expected ${EXTENSION_ID}, found ` +
      `${metadata.publisher ?? "unknown"}.${metadata.name ?? "unknown"}`,
    );
  }
  if (metadata.main !== "./out/extension.js") {
    throw new Error(
      `Refusing to patch ${extensionDir}: unsupported extension entrypoint ${metadata.main}`,
    );
  }
  return metadata;
}

function inspectExtension(extensionDir) {
  const metadata = readExtensionMetadata(extensionDir);
  const bundlePath = path.join(extensionDir, "out", "extension.js");
  const source = fs.readFileSync(bundlePath, "utf8");
  const result = patchWorkerSource(source);
  if (result.matched !== 1) {
    throw new Error(
      `Could not identify exactly one local startFileWatch implementation: ${result.reason}`,
    );
  }
  // Parse without executing the extension bundle.
  new Function(result.source);
  return {
    bundlePath,
    extensionDir,
    markerCount: result.source.split(PATCH_MARKER).length - 1,
    metadata,
    originalSha256: sha256(source),
    patchedSha256: sha256(result.source),
    result,
    source,
  };
}

function writeFileAtomically(targetPath, content, mode) {
  const tempPath = `${targetPath}.codex-linux-tmp-${process.pid}`;
  const descriptor = fs.openSync(tempPath, "wx", mode);
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(tempPath, targetPath);
}

function applyExtensionPatch(inspection) {
  const {
    bundlePath,
    extensionDir,
    metadata,
    result,
    source,
  } = inspection;
  const backupPath = `${bundlePath}${BACKUP_SUFFIX}`;
  const reportPath = path.join(extensionDir, REPORT_NAME);

  if (result.changed === 0) {
    return {
      ...inspection,
      backupPath: fs.existsSync(backupPath) ? backupPath : null,
      reportPath: fs.existsSync(reportPath) ? reportPath : null,
      status: "already-applied",
    };
  }

  const stat = fs.statSync(bundlePath);
  const backupDescriptor = fs.openSync(backupPath, "wx", stat.mode);
  try {
    fs.writeFileSync(backupDescriptor, source);
    fs.fsyncSync(backupDescriptor);
  } finally {
    fs.closeSync(backupDescriptor);
  }

  writeFileAtomically(bundlePath, result.source, stat.mode);
  const installedSource = fs.readFileSync(bundlePath, "utf8");
  if (
    installedSource.split(PATCH_MARKER).length - 1 !== 1 ||
    sha256(installedSource) !== inspection.patchedSha256
  ) {
    throw new Error(`Patched extension verification failed for ${bundlePath}`);
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    extensionId: EXTENSION_ID,
    extensionVersion: metadata.version,
    bundlePath,
    backupPath,
    patch: "shallow-repository-watches",
    marker: PATCH_MARKER,
    originalSha256: inspection.originalSha256,
    patchedSha256: inspection.patchedSha256,
    activation: "next-extension-host-start",
  };
  writeFileAtomically(reportPath, `${JSON.stringify(report, null, 2)}\n`, 0o600);
  return {
    ...inspection,
    backupPath,
    reportPath,
    status: "applied",
  };
}

function printableResult(result) {
  return {
    status: result.status ?? (result.result.changed === 1 ? "patchable" : "already-applied"),
    extensionDir: result.extensionDir,
    extensionVersion: result.metadata.version,
    bundlePath: result.bundlePath,
    markerCount: result.markerCount,
    originalSha256: result.originalSha256,
    patchedSha256: result.patchedSha256,
    backupPath: result.backupPath ?? null,
    reportPath: result.reportPath ?? null,
    activation: "next-extension-host-start",
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/patch-vscode-codex-extension.js " +
      "[--extension-dir PATH] [--apply]\n",
    );
    return;
  }
  const extensionDir = options.extensionDir == null
    ? discoverExtensionDir()
    : path.resolve(options.extensionDir);
  if (extensionDir == null) {
    throw new Error(`No installed ${EXTENSION_ID} extension was found`);
  }
  const inspection = inspectExtension(extensionDir);
  const result = options.apply ? applyExtensionPatch(inspection) : inspection;
  process.stdout.write(`${JSON.stringify(printableResult(result), null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  BACKUP_SUFFIX,
  EXTENSION_ID,
  REPORT_NAME,
  applyExtensionPatch,
  discoverExtensionDir,
  inspectExtension,
  main,
  parseArgs,
  printableResult,
  sha256,
};
