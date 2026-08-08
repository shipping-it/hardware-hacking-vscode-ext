# Hardware Hacker (VS Code extension)

A learning-focused VS Code extension for hardware hacking. It detects anything
connected over serial/USB, identifies whether it looks like an **ESP32** (and *how*
it's connected), gives you an interactive **serial monitor**, and **flashes firmware**
via Espressif's `esptool`. Built and tested against an **ESP32-S3**.

- [Prerequisites](#prerequisites)
- [Quick start — run in development](#quick-start--run-in-development)
- [Build & install it locally](#build--install-it-locally)
- [First run / smoke test](#first-run--smoke-test)
- [Features](#features)
- [Troubleshooting](#troubleshooting)
- [Extending device detection](#extending-device-detection)
- [Roadmap](#roadmap) · [Project layout](#project-layout)

---

## Prerequisites

| Tool | Version | Needed for |
|------|---------|------------|
| [VS Code](https://code.visualstudio.com/) | ≥ 1.85 | Running the extension |
| [Node.js](https://nodejs.org/) (LTS) + npm | Node ≥ 18 | Building the extension |
| [Python](https://www.python.org/) + [`esptool`](https://github.com/espressif/esptool) | Python ≥ 3.9 | **Flashing only** (not needed for detection/monitor) |

Install `esptool` once (only if you want the flashing features):

```bash
pip install esptool
```

**USB drivers:**
- **ESP32-S3** (and other native-USB Espressif chips) enumerate directly on Windows
  10/11, macOS, and Linux — **no driver needed**.
- Boards using a **USB-to-UART bridge** may need a driver: CP210x (Silicon Labs),
  CH340/CH9102 (WCH). On Linux, add yourself to the `dialout` group for port access.

---

## Quick start — run in development

Use this while hacking on the extension itself — it launches a second VS Code window
(the *Extension Development Host*) with the extension loaded, and you can set breakpoints.

```bash
npm install
npm run build
```

Then press **F5** in VS Code (or Run → *Run Extension*). A new window opens with the
**Hardware Hacker** icon in the Activity Bar.

For an auto-rebuild loop while you edit, run the watcher instead of `npm run build`:

```bash
npm run watch
```

(then press **F5**; reload the dev window with **Developer: Reload Window** after changes).

---

## Build & install it locally

Use this to install Hardware Hacker into your **everyday VS Code** as a real extension
(no F5, no dev window). It packages the extension into a `.vsix` file and installs it.

**1. Install dependencies** (skip if you already did):

```bash
npm install
```

**2. Package into a `.vsix`:**

```bash
npm run package
```

This runs `vsce package`, which first rebuilds `dist/` (via the `vscode:prepublish`
script) and then produces **`hardware-hacker-0.1.0.vsix`** in the project root.

> `vsce` may print warnings about a missing `repository`, `LICENSE`, or icon field.
> These are **non-fatal** — the `.vsix` is still created. You can ignore them for a
> local build.

**3. Install the `.vsix`** — either method works:

- **From the terminal** (requires the `code` CLI on your PATH — in VS Code run
  *Shell Command: Install 'code' command in PATH* once):

  ```bash
  code --install-extension hardware-hacker-0.1.0.vsix
  ```

- **From the UI:** open the **Extensions** view (`Ctrl+Shift+X`) → click the `⋯`
  menu at the top → **Install from VSIX…** → pick the file.

Reload the window when prompted. The Hardware Hacker icon now appears in your normal
VS Code's Activity Bar.

**Updating:** bump `version` in `package.json`, re-run `npm run package`, and install
the new `.vsix` the same way (it replaces the old one).

**Uninstalling:**

```bash
code --uninstall-extension local.hardware-hacker
```

…or right-click the extension in the Extensions view → **Uninstall**.

---

## First run / smoke test

1. Click the **Hardware Hacker** chip icon in the Activity Bar → the **Devices** view opens.
2. With nothing plugged in, you'll see *"No devices detected."*
3. Plug in your **ESP32-S3** → a row appears within ~2s. Expand it to confirm VID `303A`
   and an *"Espressif native-USB"* identity.
4. *(If you installed esptool)* right-click the device → **Read Chip Info**. This runs a
   safe, read-only `flash_id` and is the best end-to-end check that the whole toolchain
   works before you ever write to the chip.

---

## Features

### Device detection

- Adds a **Hardware Hacker** icon to the Activity Bar with a **Devices** tree.
- Continuously detects connected serial/USB ports (polls every ~2s) and identifies them:
  - **Espressif native-USB** devices (VID `0x303A`) — e.g. an **ESP32-S3** using its
    built-in USB peripheral, no bridge chip. Shown with a green circuit-board icon.
  - **USB-to-UART bridges** — CP210x (Silicon Labs), CH340/CH341/CH9102 (WCH),
    FTDI, PL2303 (Prolific). Shown honestly as *bridges*: the target MCU behind a
    generic bridge chip can't be read from USB IDs alone.
- Expand a device to see VID:PID, connection type, manufacturer, serial number, and PnP ID.
- **Refresh** button in the view title bar; **Copy Device Info** on the right-click menu.

### Serial monitor

Open a live connection to any detected device and read/write to it in a real VS Code
terminal tab (ANSI colors, scrollback, copy/paste, and find all work).

- **Open:** click the **plug** icon on a device row, or run **Hardware Hacker: Open
  Serial Monitor** from the Command Palette (it will prompt you to pick a device).
- **Type to send:** keystrokes go straight to the device; press Enter to send the
  configured line ending. Or run **Send Text to Device** to send a whole line.
- **Change baud live:** **Set Baud Rate** re-tunes the open connection without reconnecting.
- **Disconnect:** close the terminal tab, or run **Disconnect Serial Monitor**.

| Setting | Default | Meaning |
|---------|---------|---------|
| `hardwareHacker.monitor.baudRate` | `115200` | Baud rate used when opening a monitor |
| `hardwareHacker.monitor.lineEnding` | `crlf` | Bytes sent on Enter (`crlf`/`lf`/`cr`/`none`) |
| `hardwareHacker.monitor.localEcho` | `true` | Echo typed characters locally |

### MicroPython REPL

Once a board is running MicroPython, open an interactive **REPL** over serial:

- **Open:** click the **terminal** icon on a device row, or run **Hardware Hacker:
  Open MicroPython REPL** from the Command Palette.
- It's a serial monitor pre-tuned for MicroPython: **115200 baud**, **local echo off**
  (the REPL echoes your keystrokes itself), and a bare **CR** on Enter.
- Press **Enter** for the `>>>` prompt. **Ctrl-C** interrupts a running program;
  **Ctrl-D** soft-reboots. **Ctrl-E** enters paste mode. (These are passed straight
  through to the device.)

| Setting | Default | Meaning |
|---------|---------|---------|
| `hardwareHacker.repl.baudRate` | `115200` | Baud rate used when opening the MicroPython REPL |

### Firmware flashing

Flash and inspect ESP32 chips using Espressif's [`esptool`](https://github.com/espressif/esptool).
Each operation auto-closes any serial monitor open on that port (esptool needs exclusive
access) and runs in a terminal so you see live progress.

- **Read Chip Info** — runs `flash_id`: detects the chip, revision, flash size,
  manufacturer, and MAC.
- **Flash Firmware…** — pick a `.bin`, choose an offset (presets: `0x10000` app,
  `0x0` merged image / ESP32-S3 bootloader, `0x8000` partition table), then `write_flash`.
- **Flash MicroPython…** — a guided install (see below).
- **Erase Flash** — `erase_flash` after a confirmation prompt (destructive).

All are on the device right-click menu and the Command Palette.

#### Flash MicroPython…

One command downloads the right image from
[micropython.org](https://micropython.org/download/) and installs it:

1. Confirm the **board id** (defaults to `hardwareHacker.flash.micropythonBoard`,
   i.e. `ESP32_GENERIC_S3` — it's the id in the `micropython.org/download/<ID>/` URL).
2. Pick a **version** from the fetched list (stable releases first, then
   nightly/preview builds; variants like `SPIRAM_OCT` are labeled).
3. The image downloads to a temp file, then — after one confirmation — the extension
   runs **`erase_flash`** followed by **`write_flash`** in a terminal so you see live
   progress. The flash offset is chosen for the chip automatically (`0x0` for
   ESP32-S3/-C3/-C6/-H2, `0x1000` for the classic ESP32 / -S2).

> Flashing MicroPython **always erases the whole chip first** (recommended when
> coming from other firmware), so it wipes any existing firmware and stored files.

When it finishes, use **Open MicroPython REPL** (above) to talk to the board.

| Setting | Default | Meaning |
|---------|---------|---------|
| `hardwareHacker.flash.esptoolPath` | *(empty)* | Override esptool command/path; empty = auto-detect |
| `hardwareHacker.flash.baudRate` | `460800` | Baud rate used for flashing/erasing |
| `hardwareHacker.flash.micropythonBoard` | `ESP32_GENERIC_S3` | Default board id for **Flash MicroPython** |

The extension auto-detects `esptool`, `esptool.py`, or `python -m esptool`.

### Deploying Python to the board

**Deploy Python to Device…** (device right-click menu, editor title/context menu on
`.py` files, or the Command Palette) copies your code to a MicroPython board with
[`mpremote`](https://docs.micropython.org/en/latest/reference/mpremote.html)
(`pip install mpremote`). It works in one of two ways, detected automatically.

#### Deploying from a manifest

If your firmware repo produces a **deployment manifest** — a
`build/deploy.manifest.json` plus a staged bundle under `build/fs/`, emitted by
the repo's own build (e.g. `python tools/build.py build`; format spec:
`docs/DEPLOY-FORMAT.md` in the reference `ha-connector` repo) — the extension
deploys **exactly what the manifest lists**: installs each `mip` package,
copies each staged file to its device path, and resets if the manifest says so.
No import scanning, no additions, no omissions — so data files (`secrets.json`),
`mip` packages, and unimported files (`boot.py`) all reach the board and it
boots fully provisioned.

The manifest is found by walking up from the deployed file (nearest wins), or
directly at the workspace folder root when you deploy from the device tree.
Before touching the board, the extension verifies every staged file against the
manifest's sizes and sha256 hashes (on mismatch: re-run the build), and warns if
sources changed after the build — offering to run the repo's build for you
(only with your explicit confirmation). A confirmation dialog shows the full
plan first; files marked `secret` are listed by name and size only, never shown.

#### Deploying a file + its imports (no manifest)

Without a manifest, the extension scans the file's `import` statements and ships
the file plus its local dependencies. Choose per run:

- **Install as main.py** — the file becomes `main.py` on the board (runs on
  every boot), dependencies keep their paths, then the board resets.
- **Run once** — dependencies are copied, the file streams its output via
  `mpremote run` without being persisted.

Imports that don't resolve to local files are assumed to be builtin/frozen on
the board and are reported, not shipped. Note this scan can't see data files
opened at runtime or `mip` packages — that's what the manifest flow is for.

| Setting | Default | Meaning |
|---------|---------|---------|
| `hardwareHacker.deploy.mpremotePath` | *(empty)* | Override mpremote command/path; empty = auto-detect |
| `hardwareHacker.deploy.sourceRoot` | *(empty)* | Import-scan mode: base dir for resolving imports; empty = the file's folder |
| `hardwareHacker.deploy.resetAfter` | `true` | Import-scan mode: reset after installing as main.py (a manifest's own `resetAfter` wins) |

---

## Troubleshooting

**"serialport failed to load" in the Devices view.**
Port enumeration uses the native [`serialport`](https://serialport.io/) module. It usually
loads via N-API prebuilt binaries, but on an ABI mismatch you may need to rebuild it for
VS Code's Electron runtime:

```bash
npx @electron/rebuild -f -w serialport
```

Then reload the window. If this happens with the **installed `.vsix`** (not the F5 dev
host), run the rebuild in the project, then re-run `npm run package` and reinstall the
new `.vsix`.

**"esptool was not found."**
Install it (`pip install esptool`) or point the extension at it via
`hardwareHacker.flash.esptoolPath`.

**"Port is busy" / access denied when flashing or connecting.**
Another program holds the port. Close other serial monitors/terminals (Arduino IDE, a
`screen`/`putty` session, another editor). The extension auto-closes *its own* monitor
before flashing, but it can't close external tools.

**ESP32-S3 won't connect for flash/erase.**
Force download mode: hold **BOOT**, tap **RESET**, release **BOOT**, then retry the
operation. Lowering `hardwareHacker.flash.baudRate` can also help flaky cables.

---

## Extending device detection

All identification lives in [`src/devices/chipDatabase.ts`](src/devices/chipDatabase.ts).
To recognize a new board, add its USB VID (and optionally PID) to the table with a label
and a `kind` of `native`, `bridge`, or `unknown`. Rebuild (`npm run build`) and reload the
extension to pick it up.

---

## Roadmap

- [x] Detect + identify connected serial/USB devices (Milestone 1).
- [x] Interactive serial monitor — read/write, baud rate, line endings (Milestone 2).
- [x] Firmware flashing via `esptool` — read chip info / write_flash / erase_flash (Milestone 3).
- [x] Guided MicroPython install (download from micropython.org + erase + flash) and a serial REPL (Milestone 4).
- [x] Deploy Python to the board via `mpremote` — build-manifest deploys (exact, verified) with import-scan fallback (Milestone 5).
- [ ] Raw USB (libusb) detection for DFU/JTAG-only modes that don't expose a serial port.

## Project layout

```
src/
  extension.ts              activate/deactivate; wires scanner + tree + monitor + commands
  devices/
    types.ts                DetectedDevice model (UI-agnostic)
    chipDatabase.ts         USB VID/PID -> identification (edit this to extend)
    deviceScanner.ts        polls serialport, diffs, fires change events
  serial/
    serialportLoader.ts     shared lazy loader for the native serialport module
    serialConnection.ts     promise-friendly wrapper around one open port
    serialMonitor.ts        Pseudoterminal + session manager (the monitor)
  flash/
    esptool.ts              locate esptool (esptool / esptool.py / python -m esptool)
    micropython.ts          fetch/parse micropython.org firmware list + download + offset
    processTerminal.ts      Pseudoterminal that runs child process step(s) (live progress)
    flasher.ts              chip info / write_flash / erase_flash / flash MicroPython
  deploy/
    mpremote.ts             locate mpremote (mpremote / python -m mpremote) + a Python
    manifest.ts             find/parse/verify build/deploy.manifest.json (sha256, staleness)
    importResolver.ts       static import scan -> local files to ship (fallback mode)
    deployer.ts             deploy orchestration: manifest mode or scan mode + prompts
  ui/
    deviceTreeProvider.ts   the Activity Bar Devices tree
```
