# AGENTS.md — how the Hardware Hacker extension works

> **This file is the contract other agents rely on to work in this repo correctly.**
>
> ## ⚠️ Golden rule: keep this file in sync with the code
>
> **Whenever you add, remove, or modify a feature, update this file in the same
> change.** A "feature" here means anything an agent needs to know to use the code
> correctly: a new command, a new configuration setting, a new module, a changed
> data model, a new external-tool dependency, or a changed control-flow pattern.
>
> Concretely, if your change touches any of the following, update the matching
> section below **before** you consider the work done:
>
> | If you change… | Update section |
> |----------------|----------------|
> | `contributes.commands` in `package.json` | [Command reference](#command-reference) |
> | `contributes.configuration` in `package.json` | [Configuration reference](#configuration-reference) |
> | A file under `src/` (new/removed/re-scoped) | [Module map](#module-map) |
> | `DetectedDevice` / `DeviceIdentity` / other shared types | [Data model](#data-model) |
> | A new external CLI dependency (like `esptool`/`mpremote`) | [External tool dependencies](#external-tool-dependencies) |
> | An activation event, view, or menu contribution | [Activation & UI surface](#activation--ui-surface) |
>
> Treat an out-of-date `AGENTS.md` as a bug. It is the first thing another agent
> reads, and stale guidance here causes wrong implementations everywhere else.
> The [Adding a feature — checklist](#adding-a-feature--checklist) at the bottom
> walks through this end to end.

---

## What this extension is

**Hardware Hacker** (`package.json` → `name: hardware-hacker`, publisher `local`)
is a VS Code extension that detects serial/USB devices, identifies whether they
look like an **ESP32-family** board and how they're connected, and provides an
interactive **serial monitor**, **firmware flashing** (via Espressif `esptool`),
a guided **MicroPython install**, a **REPL**, and **deploy** to the board (via
`mpremote`) — either from a firmware repo's build-produced **deploy manifest**
(exact, verbatim) or, when no manifest exists, a **guided deploy** of a Python
file plus its local imports.

It is a learning-oriented project: source files are heavily commented and favor
clarity over cleverness. Match that style — comments explain *why*, not *what*.

---

## Architecture overview

The code is organized in layers. Dependencies point **downward**; lower layers
never import from higher ones.

```
                    ┌────────────────────────────┐
   activation  →    │  src/extension.ts          │  registers commands, owns
                    │  (composition root)        │  the singletons, routes
                    └──────────────┬─────────────┘  command → subsystem
                                   │
     ┌───────────────┬────────────┼───────────────┬──────────────┐
     ▼               ▼            ▼                ▼              ▼
 ui/            devices/      serial/           flash/         deploy/
 tree view      scan +        monitor +         esptool +      mpremote +
 (read-only)    identify      connection        micropython    manifest /
                                                               import scan
     │               │            │                │              │
     └───────────────┴────────────┴────────┬───────┴──────────────┘
                                            ▼
                               native `serialport` module
                               (lazy-loaded, may fail softly)
```

**Key architectural rules:**

1. **`extension.ts` is the only composition root.** It constructs the
   singletons (`DeviceScanner`, `DeviceTreeProvider`, `SerialMonitorManager`,
   `Flasher`, `Deployer`), registers every command, and pushes everything to
   `context.subscriptions`. New commands are wired here.
2. **The detection layer (`devices/`) never imports `vscode`.** `types.ts` and
   `chipDatabase.ts` are pure data/logic so they stay testable and UI-agnostic.
   Keep it that way — if you need VS Code APIs, do it in a higher layer.
3. **`serialport` is native and loaded lazily** through
   [`serial/serialportLoader.ts`](src/serial/serialportLoader.ts). Never
   `import "serialport"` at module top level; always go through the loader so a
   failed native binding degrades to a friendly error instead of crashing
   activation. It is marked `external` in [`esbuild.js`](esbuild.js) and ships
   in `node_modules` rather than being bundled.
4. **External CLIs (`esptool`, `mpremote`) run in a `ProcessPseudoterminal`,**
   not via captured `exec`. This is deliberate — see
   [External tool dependencies](#external-tool-dependencies).
5. **Exclusive port access.** `esptool`/`mpremote` need the serial port to
   themselves, so any operation that spawns them first calls `freePort()` to
   close an open monitor and waits ~400ms for the OS to release the port.

---

## Module map

Every file under `src/`, its responsibility, and the exports other modules use.

### `src/extension.ts`
Composition root. `activate()` builds the singletons, registers all
`hardwareHacker.*` commands, and starts the scanner. `resolveTargetPath()`
picks the device to act on (tree selection → else a quick pick of detected
devices). `formatDeviceInfo()` builds the clipboard text for Copy Device Info.
**Add new commands here.**

### `src/devices/` — detection layer (no `vscode` imports)

| File | Responsibility | Key exports |
|------|----------------|-------------|
| [`types.ts`](src/devices/types.ts) | Shared data model | `DetectedDevice`, `DeviceIdentity`, `ConnectionKind`, `deviceKey()` |
| [`deviceScanner.ts`](src/devices/deviceScanner.ts) | Polls `SerialPort.list()` every 2s, normalizes to `DetectedDevice[]`, fires `onDidChangeDevices` only when the set changes | `DeviceScanner` (`start`, `refresh`, `getDevices`, `getLoadError`, `onDidChangeDevices`) |
| [`chipDatabase.ts`](src/devices/chipDatabase.ts) | Maps USB VID/PID → `DeviceIdentity` | `identifyDevice(vendorId?, productId?)` |

**Honesty caveat baked into `chipDatabase.ts`:** a USB-to-UART *bridge* chip
(CP210x, CH340, FTDI, PL2303) is generic — you can name the bridge but **cannot**
know the target MCU behind it from USB IDs. Only Espressif's own VID `0x303A`
means the SoC itself speaks USB. Preserve this honesty in labels/detail text.
To teach the extension a new board, add a VID/PID entry here.

### `src/serial/` — live connection + monitor

| File | Responsibility | Key exports |
|------|----------------|-------------|
| [`serialportLoader.ts`](src/serial/serialportLoader.ts) | Single lazy `import("serialport")`, cached (incl. failure); rebuild hint text | `loadSerialport()`, `serialportRebuildHint()` |
| [`serialConnection.ts`](src/serial/serialConnection.ts) | Promise wrapper over one open port: `onData`, `onClose`, `write`, `setBaudRate`, `close` | `SerialConnection` |
| [`serialMonitor.ts`](src/serial/serialMonitor.ts) | `Pseudoterminal` backed by a `SerialConnection`; a manager keeps ≤1 session per port path | `SerialPseudoterminal`, `SerialMonitorManager`, `MonitorOptions`, `MonitorOverrides` |

The monitor is a real VS Code terminal (Pseudoterminal), not a webview — so ANSI
colors, scrollback, and find work for free. `SerialMonitorManager.open(path,
overrides?)` reuses an existing session or creates one; `MonitorOverrides` lets a
caller force baud/echo/line-ending/label (the REPL uses this: 115200, echo off,
bare `\r`).

### `src/flash/` — esptool operations

| File | Responsibility | Key exports |
|------|----------------|-------------|
| [`esptool.ts`](src/flash/esptool.ts) | Locate esptool by probing `<cmd> --help` (exit 0); caches result | `locateEsptool()`, `esptoolInstallHint()`, `resetEsptoolCache()`, `EsptoolInvocation` |
| [`micropython.ts`](src/flash/micropython.ts) | Scrape `micropython.org/download/<board>/` for `.bin` links, download with progress, compute flash offset | `fetchFirmwareList()`, `downloadFirmware()`, `offsetForBoard()`, `looksLikeEsp32Board()`, `FirmwareEntry` |
| [`processTerminal.ts`](src/flash/processTerminal.ts) | `Pseudoterminal` that runs a sequence of child-process steps, streaming output; stops the chain on non-zero exit; stays open when done. A step may set `cwd` (used by manifest-mode builds); otherwise the extension host's cwd is inherited, so pass absolute paths | `ProcessPseudoterminal`, `CommandStep` |
| [`flasher.ts`](src/flash/flasher.ts) | Orchestrates read chip info / flash firmware / erase / guided MicroPython; owns the confirm prompts and `freePort()` | `Flasher` (`readChipInfo`, `flashFirmware`, `eraseFlash`, `flashMicroPython`) |

`ProcessPseudoterminal` is shared by both `flash/` and `deploy/`. It renders
esptool's bare-`\r` progress lines as one updating line (an OutputChannel would
spam hundreds), and is **left open** after completion so the user can read output;
a completion callback handles cleanup (e.g. deleting a downloaded temp image).

### `src/deploy/` — deploy to the board via mpremote (manifest or import scan)

| File | Responsibility | Key exports |
|------|----------------|-------------|
| [`mpremote.ts`](src/deploy/mpremote.ts) | Locate mpremote (mirrors `esptool.ts` exactly); also locate a Python interpreter for manifest-mode rebuilds | `locateMpremote()`, `locatePython()`, `mpremoteInstallHint()`, `resetMpremoteCache()`, `MpremoteInvocation` |
| [`manifest.ts`](src/deploy/manifest.ts) | Find/parse/validate a build-produced `build/deploy.manifest.json` (schemaVersion 1): upward search, schema + sha256/byte verification of the staged bundle, staleness check, build-script discovery. Pure Node (`fs`/`path`/`crypto`, no `vscode`) | `findManifest()`, `loadManifest()`, `verifyStagedFiles()`, `checkStaleness()`, `findBuildScript()`, `ManifestError`, `DeployManifest`, `ManifestFile`, `LoadedManifest`, `StagedFileIssue`, `StalenessResult`, `BuildScript` |
| [`importResolver.ts`](src/deploy/importResolver.ts) | Static scan of `import`/`from … import` to find transitive **local** `.py` deps under a source root; reports unresolved (assumed builtin/frozen) | `resolveDeployment()`, `DeployFile`, `Deployment` |
| [`deployer.ts`](src/deploy/deployer.ts) | Orchestrates deploy: detect a manifest (→ manifest mode) or resolve entry file + scan imports (→ scan mode); owns all prompts, staging, and mpremote steps | `Deployer` (`deploy`) |

#### Manifest mode (preferred when available)

Firmware repos that follow the deployment contract (schemaVersion 1; the format
spec is `docs/DEPLOY-FORMAT.md` in the reference `ha-connector` repo) run their
own build (`python tools/build.py build` / `make build`), which stages the
exact on-device file set under `build/fs/` and emits `build/deploy.manifest.json`:

```jsonc
{
  "schemaVersion": 1,
  "name": "ha-connector",
  "builtAt": "2026-08-07T00:00:00+00:00",   // ISO-8601 UTC
  "mode": "install",                        // "install" today; "run" reserved
  "resetAfter": true,
  "mipPackages": [ "umqtt.robust" ],
  "files": [
    { "dest": ":main.py",      "staged": "fs/main.py",      "bytes": 1546,
      "sha256": "…", "secret": false },
    { "dest": ":secrets.json", "staged": "fs/secrets.json", "bytes": 267,
      "sha256": "…", "secret": true }
  ]
}
```

`staged` paths are relative to the `build/` dir containing the manifest; `dest`
uses mpremote's remote marker (`:main.py` → `/main.py` on the board).

The manifest exists because the import scan is structurally blind to runtime
data files read via `open()` (`secrets.json`), on-device packages installed via
`mip` (`umqtt.robust`), and files nothing imports (`boot.py`). So the manifest
is treated as **the complete and exact deployment**:

- **Detection.** `deployToDevice` looks for `build/deploy.manifest.json` by
  walking up from the entry file (nearest wins), bounded by the file's
  workspace folder (or the volume root for files outside the workspace). When
  the command is invoked with no entry file in play (device tree, no active
  `.py` editor), workspace-folder roots are checked directly instead of forcing
  a pointless file dialog. No manifest → scan mode, unchanged.
- **Validation before board contact.** `schemaVersion === 1`, shape checks,
  `staged` paths must stay inside `build/` (a manifest is repo-provided data —
  don't let it exfiltrate arbitrary host files to the board), and every staged
  file must match its manifest `bytes` + `sha256`. Any mismatch aborts with a
  "re-run the build" message before the port is touched.
- **Staleness guard.** If repo sources are newer than `builtAt`, a modal warns
  and offers Deploy Anyway / cancel — plus Run Build First when
  `tools/build.py` (preferred) or a `Makefile` exists. The build runs in its
  own `ProcessPseudoterminal` (never automatically), and on exit 0 the pipeline
  re-enters from scratch: fresh manifest re-read and re-verified.
- **Confirmation.** A modal summarizes the exact plan: every dest with byte
  count, mip packages, reset yes/no. `secret: true` files show **dest + size
  only — never log, preview, or echo their contents** anywhere.
- **Steps** (contract-mandated order): one `mip install <pkg>` per package,
  then one `fs cp <abs staged> <dest>` per file, then `reset` iff the
  *manifest's* `resetAfter` (the user setting applies to scan mode only). The
  import scanner never runs; nothing is added or omitted. Files ship straight
  from `build/fs/` — no temp staging dir.
- `mode: "run"` is reserved and politely refused.

#### Import-scan mode (fallback)

Two sub-modes: **install** (copy entry → `main.py` + deps, then `reset`) and
**run** (ship deps, then `mpremote run <entry>` to stream output without
persisting the entry). Import resolution is deliberately shallow (no dynamic
imports, naive comment/string handling) and degrades safely — a missed dep is
simply not copied.

### `src/ui/deviceTreeProvider.ts`
Read-only `TreeDataProvider` for the Activity Bar "Devices" view. `TreeNode` is a
union of `device` / `detail` / `message`. Renders the empty state and the
serialport load-error state. Sets `contextValue = "hardwareDevice"` on device
rows — the `view/item/context` menu `when` clauses depend on that string.

---

## Data model

Defined in [`src/devices/types.ts`](src/devices/types.ts). This is the common
currency between layers.

- **`DetectedDevice`** — one port: `path`, optional numeric `vendorId`/`productId`
  (serialport reports hex strings; the scanner parses them to numbers),
  `manufacturer`, `serialNumber`, `pnpId`, and `identity`.
- **`DeviceIdentity`** — best-effort interpretation: `label`, `kind`
  (`"native" | "bridge" | "unknown"`), optional `bridgeChip`, `chipHint`,
  `detail`.
- **`deviceKey(d)`** — stable identity string (`path|vid|pid`) used for
  change detection so the tree doesn't flicker every poll.

If you extend this model, update dependent renderers (`deviceTreeProvider.ts`,
`extension.ts` `formatDeviceInfo`) and this section.

---

## Command reference

Commands are declared in [`package.json`](package.json)
(`contributes.commands`) and registered in
[`src/extension.ts`](src/extension.ts). All ids are prefixed `hardwareHacker.`
and categorized "Hardware Hacker".

| Command id | Title | Handler routes to |
|------------|-------|-------------------|
| `refreshDevices` | Refresh Devices | `scanner.refresh()` |
| `copyDeviceInfo` | Copy Device Info | `formatDeviceInfo()` → clipboard |
| `connect` | Open Serial Monitor | `monitors.open(path)` |
| `disconnect` | Disconnect Serial Monitor | `monitors.close(path)` |
| `setBaudRate` | Set Baud Rate | `session.pty.setBaudRate()` |
| `sendText` | Send Text to Device | `session.pty.sendLine()` |
| `readChipInfo` | Read Chip Info | `flasher.readChipInfo()` (esptool `flash_id`) |
| `flashFirmware` | Flash Firmware… | `flasher.flashFirmware()` (esptool `write_flash`) |
| `flashMicroPython` | Flash MicroPython… | `flasher.flashMicroPython()` (download + erase + write) |
| `openRepl` | Open MicroPython REPL | `monitors.open()` with REPL overrides |
| `deployToDevice` | Deploy Python to Device… | `deployer.deploy()` — auto-detects a `build/deploy.manifest.json` (manifest mode); falls back to the import scan |
| `eraseFlash` | Erase Flash | `flasher.eraseFlash()` (esptool `erase_flash`, confirmed) |

Command handlers receive an optional tree `DeviceNode`. Use
`resolveTargetPath(node, scanner)` to get the port: it prefers the tree selection
and otherwise shows a quick pick of detected devices. Baud/send/disconnect
resolve the *session* via `node.device` → else `monitors.activeSession()`.

**Destructive operations require a modal confirm** (`showWarningMessage(...,
{ modal: true }, ...)`). `eraseFlash` and the erase step of `flashMicroPython`
already do this — keep that pattern for anything that wipes the board.

---

## Configuration reference

Declared in [`package.json`](package.json) (`contributes.configuration`), read
via `vscode.workspace.getConfiguration("hardwareHacker.<group>")`.

| Setting | Default | Read by |
|---------|---------|---------|
| `hardwareHacker.monitor.baudRate` | `115200` | `SerialMonitorManager` |
| `hardwareHacker.monitor.lineEnding` | `"crlf"` | `SerialMonitorManager` (decoded to bytes) |
| `hardwareHacker.monitor.localEcho` | `true` | `SerialMonitorManager` |
| `hardwareHacker.flash.esptoolPath` | `""` (auto-detect) | `locateEsptool()` |
| `hardwareHacker.flash.baudRate` | `460800` | `Flasher` |
| `hardwareHacker.flash.micropythonBoard` | `"ESP32_GENERIC_S3"` | `Flasher.askBoardId()` |
| `hardwareHacker.repl.baudRate` | `115200` | `openRepl` command |
| `hardwareHacker.deploy.mpremotePath` | `""` (auto-detect) | `locateMpremote()` |
| `hardwareHacker.deploy.sourceRoot` | `""` (entry's folder) | `Deployer.sourceRootFor()` — scan mode only, unused in manifest mode |
| `hardwareHacker.deploy.resetAfter` | `true` | `Deployer.buildSteps()` — scan mode only; a manifest's own `resetAfter` wins |

A new setting must be added to `package.json` **and** documented in this table.

---

## Activation & UI surface

- **Activation event:** `onView:hardwareDevices` (activates when the Devices
  view is first opened). If you add a command usable without the view, add its
  activation event.
- **View container:** `hardware-hacker` in the Activity Bar; single view
  `hardwareDevices` ("Devices").
- **Menus** (`contributes.menus`): the refresh icon is in `view/title`; device
  actions are in `view/item/context` grouped as `inline`, `1_monitor`,
  `2_flash`, `3_deploy` (the group order controls the context-menu layout).
  `deployToDevice` also appears in `editor/context` and `editor/title` for `.py`
  files. Menu `when` clauses depend on `viewItem == hardwareDevice` — set that
  `contextValue` on any new actionable tree row.

---

## External tool dependencies

The extension shells out to two external Python CLIs. Both follow the **same
pattern**, and new external-tool integrations should copy it:

1. **Locate** by probing candidates with `<cmd> --help` and keeping the first
   that exits 0 (`esptool.ts` / `mpremote.ts`). Candidates: a user-configured
   path first, then `<tool>`, then `python -m <tool>` / `python3 -m …` / `py -m
   …`. Cache the result; expose a `reset*Cache()`. **Probe with `--help`, not
   `--version`** — esptool v5 (Click CLI) dropped `--version`.
2. **Bail with an install hint** (`*InstallHint()`) via `showErrorMessage` if not
   found — never throw into the void.
3. **Free the port** (`freePort()`) before spawning, since these tools need
   exclusive serial access.
4. **Run in a `ProcessPseudoterminal`** as `CommandStep[]` so the user sees live
   progress; multi-step chains stop on the first non-zero exit.

| Tool | Purpose | Install |
|------|---------|---------|
| `esptool` | chip info, flash, erase, MicroPython write | `pip install esptool` |
| `mpremote` | copy files to board, run/reset | `pip install mpremote` |

`micropython.ts` additionally reaches out to `micropython.org` over HTTPS
(Node's built-in `https`, no dependency) to list and download firmware.

---

## Build, run, package

```bash
npm install            # install deps (pulls the native serialport binary)
npm run bundle         # esbuild → dist/extension.js (pure bundle, used by F5)
npm run build          # bundle + package + install the .vsix into VS Code
npm run install-latest # package + install only (wraps install_latest.ps1)
npm run watch          # rebuild on change (use with the Extension Dev Host)
npm run compile-tests  # tsc type-check only (no emit used for shipping)
npm run package        # vsce package → hardware-hacker-<version>.vsix
```

- `npm run build` is the one-shot "get the latest into my editor" path: it
  bundles, then runs [`install_latest.ps1`](install_latest.ps1) (`vsce package`
  + `code --install-extension --force`). Windows-only by design (PowerShell).
- **Recursion guard:** `vscode:prepublish` must invoke `node esbuild.js`
  directly, never `npm run build` — `build` runs `vsce package`, which runs
  `vscode:prepublish`, so pointing prepublish back at `build` would loop
  forever. Same reason the F5 `preLaunchTask` uses the pure `npm: bundle`
  task: a debug launch should not package/install into the real VS Code.
- Press **F5** (or Run → Start Debugging) to launch the Extension Development
  Host with the extension loaded.
- The bundle marks `vscode` and `serialport` as `external`
  ([`esbuild.js`](esbuild.js)); `serialport` ships in `node_modules`.
- There is **no automated test suite** yet. `compile-tests` (`tsc`, strict mode
  with `noUnused*` / `noImplicitReturns`) is the type-safety gate — run it after
  changes. `.vscodeignore` keeps `src/`/`*.ts`/maps out of the packaged `.vsix`.
- If the native module fails to load in the Electron host, the fix is
  `npx @electron/rebuild -f -w serialport` then reload the window (this is the
  text `serialportRebuildHint()` surfaces).

---

## Conventions an agent must follow

- **Layering:** keep `devices/` free of `vscode`; don't make lower layers import
  higher ones; route new commands through `extension.ts`.
- **Native module:** only touch `serialport` through `serialportLoader.ts`.
- **Terminals over channels:** stream external-process output through
  `ProcessPseudoterminal`; drive live serial through `SerialPseudoterminal`.
- **Confirm destructive actions** with a modal dialog.
- **Free the port** before any esptool/mpremote run.
- **Honesty in identification:** never claim a bridge chip tells you the MCU.
- **Comment the *why*.** Match the existing dense, explanatory comment style.
- **No new runtime dependencies** unless necessary — the codebase prefers Node
  built-ins (`https`, `fs`, `child_process`) over npm packages.

---

## Adding a feature — checklist

Work through this for any new capability, and update the matching parts of this
file as you go (see the [Golden rule](#-golden-rule-keep-this-file-in-sync-with-the-code)):

1. **Command?** Add it to `contributes.commands` in `package.json`, register it
   in `extension.ts`, and add a `view/item/context` (or editor) menu entry if it
   should be clickable. → update [Command reference](#command-reference) +
   [Activation & UI surface](#activation--ui-surface).
2. **Setting?** Add it to `contributes.configuration`, read it via
   `getConfiguration("hardwareHacker.<group>")`. → update
   [Configuration reference](#configuration-reference).
3. **New module?** Place it in the right layer, keep `devices/` `vscode`-free. →
   update [Module map](#module-map).
4. **New external CLI?** Follow the locate → hint → freePort →
   `ProcessPseudoterminal` pattern. → update
   [External tool dependencies](#external-tool-dependencies).
5. **Data model change?** Update `types.ts` and every renderer. → update
   [Data model](#data-model).
6. **Type-check:** run `npm run compile-tests`; build with `npm run build`;
   smoke-test in the Extension Dev Host (F5).
7. **Docs:** update the user-facing [`README.md`](README.md) **and** this file.

If in doubt about a pattern, read the closest existing sibling (e.g. copy
`mpremote.ts` for a new tool, `flasher.ts` for a new orchestrated operation) —
they are the reference implementations.
