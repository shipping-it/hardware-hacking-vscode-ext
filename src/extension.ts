// Extension entry point: wires the device scanner, the tree view, the serial
// monitor manager, and the commands together.
//
// Milestone 1: detect + list + identify devices.
// Milestone 2: interactive serial monitor (this file grew the connect/disconnect/
//              setBaudRate/sendText commands and the SerialMonitorManager).
// Still deferred: firmware flashing, raw-USB/DFU detection.

import * as vscode from "vscode";
import { DeviceScanner } from "./devices/deviceScanner";
import { DeviceTreeProvider } from "./ui/deviceTreeProvider";
import { DetectedDevice } from "./devices/types";
import { SerialMonitorManager } from "./serial/serialMonitor";
import { Flasher } from "./flash/flasher";

/** Common baud rates offered by the Set Baud Rate quick pick. */
const COMMON_BAUD_RATES = [
  9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600,
];

export function activate(context: vscode.ExtensionContext): void {
  const scanner = new DeviceScanner();
  const treeProvider = new DeviceTreeProvider(scanner);
  const monitors = new SerialMonitorManager();
  const flasher = new Flasher(monitors);

  const treeView = vscode.window.createTreeView("hardwareDevices", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  const refreshCmd = vscode.commands.registerCommand(
    "hardwareHacker.refreshDevices",
    () => scanner.refresh()
  );

  const copyCmd = vscode.commands.registerCommand(
    "hardwareHacker.copyDeviceInfo",
    async (node?: DeviceNode) => {
      const device = node?.device;
      if (!device) {
        return;
      }
      await vscode.env.clipboard.writeText(formatDeviceInfo(device));
      void vscode.window.showInformationMessage(
        `Copied info for ${device.path} to clipboard.`
      );
    }
  );

  const connectCmd = vscode.commands.registerCommand(
    "hardwareHacker.connect",
    async (node?: DeviceNode) => {
      const path = await resolveTargetPath(node, scanner);
      if (path) {
        monitors.open(path);
      }
    }
  );

  const disconnectCmd = vscode.commands.registerCommand(
    "hardwareHacker.disconnect",
    (node?: DeviceNode) => {
      // From the tree we know the port; otherwise act on the active terminal.
      const session = node?.device
        ? monitors.get(node.device.path)
        : monitors.activeSession();
      if (session) {
        monitors.close(session.path);
      } else {
        void vscode.window.showWarningMessage(
          "No serial monitor to disconnect. Focus a Serial terminal or use the device menu."
        );
      }
    }
  );

  const setBaudCmd = vscode.commands.registerCommand(
    "hardwareHacker.setBaudRate",
    async (node?: DeviceNode) => {
      const session = node?.device
        ? monitors.get(node.device.path)
        : monitors.activeSession();
      if (!session) {
        void vscode.window.showWarningMessage(
          "No active serial monitor. Open one first, then set its baud rate."
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        COMMON_BAUD_RATES.map((b) => ({
          label: String(b),
          description: b === session.pty.baudRate ? "current" : undefined,
        })),
        { placeHolder: `Baud rate for ${session.path}` }
      );
      if (picked) {
        await session.pty.setBaudRate(Number(picked.label));
      }
    }
  );

  const sendTextCmd = vscode.commands.registerCommand(
    "hardwareHacker.sendText",
    async (node?: DeviceNode) => {
      const session = node?.device
        ? monitors.get(node.device.path)
        : monitors.activeSession();
      if (!session) {
        void vscode.window.showWarningMessage(
          "No active serial monitor. Open one first, then send text."
        );
        return;
      }
      const text = await vscode.window.showInputBox({
        prompt: `Send to ${session.path}`,
        placeHolder: "Text to send (a line ending is appended per settings)",
      });
      if (text !== undefined) {
        session.pty.sendLine(text);
      }
    }
  );

  const readChipInfoCmd = vscode.commands.registerCommand(
    "hardwareHacker.readChipInfo",
    async (node?: DeviceNode) => {
      const path = await resolveTargetPath(node, scanner);
      if (path) {
        await flasher.readChipInfo(path);
      }
    }
  );

  const flashFirmwareCmd = vscode.commands.registerCommand(
    "hardwareHacker.flashFirmware",
    async (node?: DeviceNode) => {
      const path = await resolveTargetPath(node, scanner);
      if (path) {
        await flasher.flashFirmware(path);
      }
    }
  );

  const eraseFlashCmd = vscode.commands.registerCommand(
    "hardwareHacker.eraseFlash",
    async (node?: DeviceNode) => {
      const path = await resolveTargetPath(node, scanner);
      if (path) {
        await flasher.eraseFlash(path);
      }
    }
  );

  context.subscriptions.push(
    scanner,
    treeView,
    monitors,
    refreshCmd,
    copyCmd,
    connectCmd,
    disconnectCmd,
    setBaudCmd,
    sendTextCmd,
    readChipInfoCmd,
    flashFirmwareCmd,
    eraseFlashCmd
  );

  scanner.start();
}

export function deactivate(): void {
  // Disposal handled via context.subscriptions.
}

/** The tree node shape passed to commands invoked from the device tree. */
interface DeviceNode {
  device?: DetectedDevice;
}

/**
 * Determine which port to act on: prefer the tree selection, otherwise show a
 * quick pick of currently detected devices.
 */
async function resolveTargetPath(
  node: DeviceNode | undefined,
  scanner: DeviceScanner
): Promise<string | undefined> {
  if (node?.device) {
    return node.device.path;
  }
  const devices = scanner.getDevices();
  if (devices.length === 0) {
    void vscode.window.showWarningMessage(
      "No devices detected. Connect a board and try again."
    );
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    devices.map((d) => ({
      label: d.path,
      description: d.identity.label,
    })),
    { placeHolder: "Select a device to open a serial monitor" }
  );
  return picked?.label;
}

/** Plain-text device summary used by the Copy Device Info command. */
function formatDeviceInfo(d: DetectedDevice): string {
  const lines = [
    `Path:         ${d.path}`,
    `Identity:     ${d.identity.label}`,
    `Connection:   ${d.identity.kind}`,
  ];
  if (d.vendorId !== undefined) {
    lines.push(`Vendor ID:    0x${hex(d.vendorId)}`);
  }
  if (d.productId !== undefined) {
    lines.push(`Product ID:   0x${hex(d.productId)}`);
  }
  if (d.identity.bridgeChip) {
    lines.push(`Bridge chip:  ${d.identity.bridgeChip}`);
  }
  if (d.identity.chipHint) {
    lines.push(`Chip hint:    ${d.identity.chipHint}`);
  }
  if (d.manufacturer) {
    lines.push(`Manufacturer: ${d.manufacturer}`);
  }
  if (d.serialNumber) {
    lines.push(`Serial:       ${d.serialNumber}`);
  }
  if (d.pnpId) {
    lines.push(`PnP ID:       ${d.pnpId}`);
  }
  if (d.identity.detail) {
    lines.push("", d.identity.detail);
  }
  return lines.join("\n");
}

function hex(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, "0");
}
