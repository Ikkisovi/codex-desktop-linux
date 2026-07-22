# Shallow Linux Repository Watches

This opt-in feature makes Codex Desktop's local recursive `fs.watch` requests
non-recursive on Linux.

Sidebar task previews create short-lived watches for the task's working tree
and Git metadata. Node implements `recursive: true` on Linux by synchronously
walking the watched tree and opening one watch per directory. A repository with
many worktrees, generated directories, or namespaced refs can therefore stall
Electron's main thread simply when its task row is hovered.

The patch changes only Linux recursive requests. Existing non-recursive watches
and other platforms are untouched. It also reports `recursive: false` through
the existing coverage result so Codex's focus-recovery path remains available.

Enable it in `linux-features/features.json` and rebuild:

```json
{
  "enabled": [
    "shallow-repository-watches"
  ]
}
```

NixOS and Home Manager users can add the feature ID to `linuxFeatures`:

```nix
programs.codexDesktopLinux.linuxFeatures = [
  "shallow-repository-watches"
];
```

## Tradeoffs

- Deep filesystem or Git-ref changes may refresh when Codex regains focus
  instead of immediately while the window remains focused.
- The feature intentionally favors bounded UI latency over continuous recursive
  coverage. It is disabled by default.
- It conflicts with `directory-only-working-tree-watch`; select one strategy.
- This is an upstream-bundle patch. Drift in the enabled feature rejects a
  rebuild candidate rather than silently restoring recursive watches.

Run its tests with:

```bash
node --test linux-features/shallow-repository-watches/test.js
```

## VS Code Codex extension

The OpenAI Codex VS Code extension carries the same local `startFileWatch`
implementation, but it runs in VS Code's extension host and is not changed by
rebuilding Desktop. On Linux, inspect the newest installed extension and apply
the same bounded-watch transform with:

```bash
node scripts/patch-vscode-codex-extension.js
node scripts/patch-vscode-codex-extension.js --apply
```

The installer validates the extension identity and bundle shape, syntax-checks
the transformed bundle, keeps one adjacent original-file backup, and writes a
small patch report. A running extension host continues using its already-loaded
bundle; the patch activates on the next normal extension-host start.
