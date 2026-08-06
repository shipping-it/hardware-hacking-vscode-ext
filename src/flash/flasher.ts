// Orchestrates esptool operations: read chip info, flash firmware, erase flash,
// and the guided "flash MicroPython" flow (download + erase + write).
//
// Every operation:
//   1. locates esptool (or bails with an install hint),
//   2. frees the serial port by closing any open monitor on it (esptool needs
//      exclusive access), then
//   3. runs esptool in a process-backed terminal so the user sees live progress.

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ProcessPseudoterminal, CommandStep } from "./processTerminal";
import { locateEsptool, esptoolInstallHint, EsptoolInvocation } from "./esptool";
import { SerialMonitorManager } from "../serial/serialMonitor";
import {
  fetchFirmwareList,
  downloadFirmware,
  offsetForBoard,
  looksLikeEsp32Board,
  FirmwareEntry,
} from "./micropython";

/** Board id used by default for the MicroPython download flow. */
const DEFAULT_MICROPYTHON_BOARD = "ESP32_GENERIC_S3";

export class Flasher {
  constructor(private readonly monitors: SerialMonitorManager) {}

  /** `flash_id` — detects the chip and reports flash size / manufacturer / MAC. */
  async readChipInfo(path: string): Promise<void> {
    const inv = await this.ensureEsptool();
    if (!inv) {
      return;
    }
    await this.freePort(path);
    this.run(path, inv, ["flash_id"]);
  }

  /** `write_flash <offset> <file>` — prompts for a .bin and an offset. */
  async flashFirmware(path: string): Promise<void> {
    const inv = await this.ensureEsptool();
    if (!inv) {
      return;
    }

    const files = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Flash this firmware",
      filters: { "Firmware image": ["bin"], "All files": ["*"] },
    });
    if (!files || files.length === 0) {
      return;
    }

    const offset = await this.askOffset();
    if (offset === undefined) {
      return;
    }

    await this.freePort(path);
    this.run(path, inv, ["write_flash", offset, files[0].fsPath]);
  }

  /** `erase_flash` — wipes the entire chip after an explicit confirmation. */
  async eraseFlash(path: string): Promise<void> {
    const inv = await this.ensureEsptool();
    if (!inv) {
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Erase ALL flash on ${path}? This wipes firmware and stored data and cannot be undone.`,
      { modal: true },
      "Erase Flash"
    );
    if (choice !== "Erase Flash") {
      return;
    }

    await this.freePort(path);
    this.run(path, inv, ["erase_flash"]);
  }

  /**
   * Guided MicroPython install: pick a board + version from micropython.org,
   * download the image, then erase and write it in one terminal.
   */
  async flashMicroPython(devicePath: string): Promise<void> {
    const inv = await this.ensureEsptool();
    if (!inv) {
      return;
    }

    const boardId = await this.askBoardId();
    if (!boardId) {
      return;
    }
    if (!looksLikeEsp32Board(boardId)) {
      void vscode.window.showErrorMessage(
        `"${boardId}" doesn't look like an ESP32 board. This flow flashes ` +
          "ESP32-family images via esptool; other ports (rp2, stm32, ...) use " +
          "different tools."
      );
      return;
    }

    const entry = await this.pickFirmware(boardId);
    if (!entry) {
      return;
    }

    const localPath = await this.downloadWithProgress(entry);
    if (!localPath) {
      return;
    }

    const offset = offsetForBoard(boardId);
    const confirmed = await vscode.window.showWarningMessage(
      `Flash MicroPython ${entry.version} to ${devicePath}?\n\n` +
        `This ERASES ALL flash, then writes ${entry.fileName} at ${offset}. ` +
        "Erasing wipes existing firmware and stored data and cannot be undone.",
      { modal: true },
      "Erase & Flash"
    );
    if (confirmed !== "Erase & Flash") {
      this.cleanupTemp(localPath);
      return;
    }

    await this.freePort(devicePath);
    const steps: CommandStep[] = [
      this.step(devicePath, inv, ["erase_flash"]),
      this.step(devicePath, inv, ["write_flash", offset, localPath]),
    ];
    // Delete the downloaded image once the run finishes (the terminal stays open).
    this.runSteps(`esptool micropython ${devicePath}`, steps, () =>
      this.cleanupTemp(localPath)
    );
  }

  // --- internals -----------------------------------------------------------

  private async ensureEsptool(): Promise<EsptoolInvocation | undefined> {
    const inv = await locateEsptool();
    if (!inv) {
      void vscode.window.showErrorMessage(esptoolInstallHint());
    }
    return inv;
  }

  /** Build one esptool CommandStep (base args + port/baud + operation). */
  private step(
    path: string,
    inv: EsptoolInvocation,
    operationArgs: string[]
  ): CommandStep {
    return {
      command: inv.command,
      args: [
        ...inv.baseArgs,
        "--port",
        path,
        "--baud",
        String(this.flashBaudRate()),
        ...operationArgs,
      ],
    };
  }

  /** Build a single-step esptool invocation and launch it in a terminal. */
  private run(
    path: string,
    inv: EsptoolInvocation,
    operationArgs: string[]
  ): void {
    this.runSteps(`esptool ${path}`, [this.step(path, inv, operationArgs)]);
  }

  /** Launch a (possibly multi-step) esptool run in a terminal. */
  private runSteps(
    name: string,
    steps: CommandStep[],
    onComplete?: () => void
  ): void {
    const pty = new ProcessPseudoterminal(steps, onComplete);
    const terminal = vscode.window.createTerminal({ name, pty });
    terminal.show();
  }

  /** Close a monitor holding the port and give the OS a moment to release it. */
  private async freePort(path: string): Promise<void> {
    if (this.monitors.get(path)) {
      this.monitors.close(path);
      await delay(400);
    }
  }

  /** Ask which board to download MicroPython for (default from settings). */
  private async askBoardId(): Promise<string | undefined> {
    const configured = vscode.workspace
      .getConfiguration("hardwareHacker.flash")
      .get<string>("micropythonBoard", DEFAULT_MICROPYTHON_BOARD)
      .trim();
    const value = await vscode.window.showInputBox({
      title: "Flash MicroPython — board",
      prompt:
        "MicroPython board id (see the URL on micropython.org/download, e.g. " +
        "ESP32_GENERIC_S3, ESP32_GENERIC, ESP32_GENERIC_C3).",
      value: configured || DEFAULT_MICROPYTHON_BOARD,
      validateInput: (v) =>
        /^[A-Za-z0-9_]+$/.test(v.trim())
          ? undefined
          : "Use the board id exactly as on micropython.org (letters, digits, _).",
    });
    return value?.trim();
  }

  /** Fetch the board's firmware list and let the user pick a version. */
  private async pickFirmware(
    boardId: string
  ): Promise<FirmwareEntry | undefined> {
    let entries: FirmwareEntry[];
    try {
      entries = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Fetching MicroPython builds for ${boardId}…`,
        },
        () => fetchFirmwareList(boardId)
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(
        `Couldn't fetch firmware list for ${boardId}: ${msg}`
      );
      return undefined;
    }

    if (entries.length === 0) {
      void vscode.window.showErrorMessage(
        `No firmware images found for "${boardId}". Check the board id at ` +
          "micropython.org/download."
      );
      return undefined;
    }

    type FwItem = vscode.QuickPickItem & { entry?: FirmwareEntry };
    const stable = entries.filter((e) => !e.nightly);
    const nightly = entries.filter((e) => e.nightly);
    const items: FwItem[] = [];
    const toItem = (e: FirmwareEntry): FwItem => ({
      label: e.version,
      description: e.variant ? e.variant : "standard",
      detail: e.fileName,
      entry: e,
    });
    if (stable.length > 0) {
      items.push({
        label: "Stable releases",
        kind: vscode.QuickPickItemKind.Separator,
      });
      items.push(...stable.map(toItem));
    }
    if (nightly.length > 0) {
      items.push({
        label: "Nightly / preview",
        kind: vscode.QuickPickItemKind.Separator,
      });
      items.push(...nightly.map(toItem));
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: `MicroPython for ${boardId}`,
      placeHolder: "Select a version to download and flash",
      matchOnDetail: true,
    });
    return picked?.entry;
  }

  /** Download the chosen image to a temp file with a progress notification. */
  private async downloadWithProgress(
    entry: FirmwareEntry
  ): Promise<string | undefined> {
    try {
      return await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Downloading ${entry.fileName}`,
        },
        (progress) => {
          let lastPct = 0;
          return downloadFirmware(entry, (received, total) => {
            if (total > 0) {
              const pct = Math.floor((received / total) * 100);
              if (pct > lastPct) {
                progress.report({
                  increment: pct - lastPct,
                  message: `${pct}%`,
                });
                lastPct = pct;
              }
            } else {
              progress.report({
                message: `${(received / 1_000_000).toFixed(1)} MB`,
              });
            }
          });
        }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Download failed: ${msg}`);
      return undefined;
    }
  }

  /** Remove a downloaded temp image (and its mkdtemp dir) after flashing. */
  private cleanupTemp(filePath: string): void {
    fs.rm(path.dirname(filePath), { recursive: true, force: true }, () => {
      /* best effort */
    });
  }

  /** Ask which flash offset to write to, with ESP32-aware presets. */
  private async askOffset(): Promise<string | undefined> {
    const presets: vscode.QuickPickItem[] = [
      { label: "0x10000", description: "Application (typical single-app image)" },
      { label: "0x0", description: "Merged/full image, or ESP32-S3/-C3 bootloader" },
      { label: "0x1000", description: "Bootloader on classic ESP32 / -S2" },
      { label: "0x8000", description: "Partition table" },
      { label: "Custom…", description: "Enter a custom hex offset" },
    ];
    const picked = await vscode.window.showQuickPick(presets, {
      placeHolder: "Flash offset to write to",
    });
    if (!picked) {
      return undefined;
    }
    if (picked.label !== "Custom…") {
      return picked.label;
    }
    const custom = await vscode.window.showInputBox({
      prompt: "Flash offset (hex, e.g. 0x10000)",
      value: "0x",
      validateInput: (v) =>
        /^0x[0-9a-fA-F]+$/.test(v.trim())
          ? undefined
          : "Enter a hex offset like 0x10000",
    });
    return custom?.trim();
  }

  private flashBaudRate(): number {
    return vscode.workspace
      .getConfiguration("hardwareHacker.flash")
      .get<number>("baudRate", 460800);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
