// Orchestrates esptool operations: read chip info, flash firmware, erase flash.
//
// Every operation:
//   1. locates esptool (or bails with an install hint),
//   2. frees the serial port by closing any open monitor on it (esptool needs
//      exclusive access), then
//   3. runs esptool in a process-backed terminal so the user sees live progress.

import * as vscode from "vscode";
import { ProcessPseudoterminal } from "./processTerminal";
import { locateEsptool, esptoolInstallHint, EsptoolInvocation } from "./esptool";
import { SerialMonitorManager } from "../serial/serialMonitor";

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

  // --- internals -----------------------------------------------------------

  private async ensureEsptool(): Promise<EsptoolInvocation | undefined> {
    const inv = await locateEsptool();
    if (!inv) {
      void vscode.window.showErrorMessage(esptoolInstallHint());
    }
    return inv;
  }

  /** Build the full esptool arg list and launch it in a terminal. */
  private run(
    path: string,
    inv: EsptoolInvocation,
    operationArgs: string[]
  ): void {
    const args = [
      ...inv.baseArgs,
      "--port",
      path,
      "--baud",
      String(this.flashBaudRate()),
      ...operationArgs,
    ];
    const pty = new ProcessPseudoterminal(inv.command, args);
    const terminal = vscode.window.createTerminal({
      name: `esptool ${path}`,
      pty,
    });
    terminal.show();
  }

  /** Close a monitor holding the port and give the OS a moment to release it. */
  private async freePort(path: string): Promise<void> {
    if (this.monitors.get(path)) {
      this.monitors.close(path);
      await delay(400);
    }
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
