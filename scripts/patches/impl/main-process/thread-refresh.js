"use strict";

const { recordStrategy } = require("../../strategy-telemetry.js");

const IDENTIFIER = "[A-Za-z_$][\\w$]*";
const PATCH_MARKER = "codexLinuxInstallThreadStateWatcher";
const QUERY_KEYS = ["recent-conversations", "recent-conversations-meta"];

function refreshSource(serviceAlias) {
  return QUERY_KEYS
    .map((key) => `${serviceAlias}.broadcastQueryCacheInvalidation([${JSON.stringify(key)}])`)
    .join(",");
}

function findAppViewRegistrationAnchor(source) {
  const pattern = new RegExp(
    `async registerAppView\\((${IDENTIFIER}),(${IDENTIFIER})\\)\\{`,
    "g",
  );
  const matches = [...source.matchAll(pattern)].filter((match) => {
    const classRegion = source.slice(
      Math.max(0, match.index - 16000),
      match.index + 16000,
    );
    return classRegion.includes("broadcastQueryCacheInvalidation(") &&
      classRegion.includes("appViewsByWebContentsId");
  });
  return matches.length === 1 ? matches[0] : null;
}

function watcherSource() {
  // Polling is intentional: large workspaces can exhaust Linux inotify before
  // Desktop starts, while watchFile still provides bounded state refreshes.
  return `function codexLinuxInstallThreadStateWatcher(__codexRefresh){globalThis.codexLinuxRefreshThreads=__codexRefresh;if(codexLinuxInstallThreadStateWatcher.installed||process.platform!=="linux"||process.env.CODEX_LINUX_DISABLE_THREAD_STATE_WATCHER==="1")return;codexLinuxInstallThreadStateWatcher.installed=!0;let __codexPath=require("node:path"),__codexFs=require("node:fs"),__codexHome=process.env.CODEX_HOME||(process.env.HOME?__codexPath.join(process.env.HOME,".codex"):null);if(__codexHome==null)return;let __codexTimer=null,__codexPending=!1,__codexLastRefresh=0,__codexBroadcast=()=>{__codexPending=!1,__codexLastRefresh=Date.now(),__codexRefresh()},__codexSchedule=()=>{__codexPending=!0;if(__codexTimer!=null)return;let __codexDelay=Math.max(0,500-(Date.now()-__codexLastRefresh));__codexTimer=setTimeout(()=>{__codexTimer=null,__codexPending&&__codexBroadcast()},__codexDelay),__codexTimer.unref?.()};try{let __codexStateFiles=__codexFs.readdirSync(__codexHome).filter(__codexName=>/^state_\\d+\\.sqlite$/.test(__codexName)).flatMap(__codexName=>[__codexName,__codexName+"-wal",__codexName+"-shm"]);for(let __codexName of __codexStateFiles)__codexFs.watchFile(__codexPath.join(__codexHome,__codexName),{persistent:!1,interval:1e3},(__codexCurrent,__codexPrevious)=>{(__codexCurrent.mtimeMs!==__codexPrevious.mtimeMs||__codexCurrent.size!==__codexPrevious.size||__codexCurrent.ino!==__codexPrevious.ino)&&__codexSchedule()})}catch{}}`;
}

function findViewMenuTarget(source) {
  const assignmentPattern = new RegExp(
    `(${IDENTIFIER})\\.submenu=(${IDENTIFIER});let (${IDENTIFIER})=\\[\\],`,
    "g",
  );
  const candidates = [];
  for (const match of source.matchAll(assignmentPattern)) {
    const [text, menuAlias, itemsAlias] = match;
    const prefix = source.slice(Math.max(0, match.index - 12000), match.index);
    const viewDeclaration = new RegExp(
      `${menuAlias}=\\{label:\\x60View\\x60,id:${IDENTIFIER}\\.${IDENTIFIER}\\.view,submenu:\\[\\]\\}`,
    );
    if (!viewDeclaration.test(prefix)) {
      continue;
    }
    candidates.push({
      start: match.index,
      end: match.index + text.length,
      text,
      itemsAlias,
    });
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function applyLinuxThreadStateRefreshPatch(currentSource) {
  if (currentSource.includes(PATCH_MARKER)) {
    return currentSource;
  }

  const appViewAnchor = findAppViewRegistrationAnchor(currentSource);
  const viewMenu = findViewMenuTarget(currentSource);
  if (appViewAnchor == null || viewMenu == null) {
    console.warn(
      "WARN: Could not find thread state refresh anchors - skipping Linux thread refresh patch",
    );
    recordStrategy("thread-state-refresh", "none");
    return currentSource;
  }

  const appViewReplacement =
    appViewAnchor[0] +
    `codexLinuxInstallThreadStateWatcher(()=>{${refreshSource("this")}}),`;
  let patchedSource =
    currentSource.slice(0, appViewAnchor.index) +
    appViewReplacement +
    currentSource.slice(appViewAnchor.index + appViewAnchor[0].length);

  const menuShift = appViewReplacement.length - appViewAnchor[0].length;
  const menuStart = viewMenu.start + (appViewAnchor.index < viewMenu.start ? menuShift : 0);
  const menuEnd = viewMenu.end + (appViewAnchor.index < viewMenu.end ? menuShift : 0);
  const refreshAction = `{label:"Refresh Threads",accelerator:"F5",click:()=>{globalThis.codexLinuxRefreshThreads?.()}}`;
  const menuReplacement =
    `${viewMenu.itemsAlias}.unshift(${refreshAction},{type:"separator"}),` +
    viewMenu.text;
  patchedSource =
    patchedSource.slice(0, menuStart) +
    menuReplacement +
    patchedSource.slice(menuEnd);

  patchedSource += watcherSource();
  recordStrategy("thread-state-refresh", "upstream");
  return patchedSource;
}

module.exports = {
  applyLinuxThreadStateRefreshPatch,
};
