// The Activity Bar tree: one row per detected device, expandable into detail rows.
//
// Node model: a `TreeNode` is a discriminated union of three shapes —
//   - "device"  : a top-level, collapsible device row
//   - "detail"  : a child key/value row under a device
//   - "message" : a single informational row (empty state or load error)

import * as vscode from "vscode";
import { DeviceScanner } from "../devices/deviceScanner";
import { DetectedDevice, ConnectionKind } from "../devices/types";

type TreeNode =
  | { type: "device"; device: DetectedDevice }
  | { type: "detail"; label: string; value: string }
  | { type: "message"; label: string; icon?: string };

export class DeviceTreeProvider
  implements vscode.TreeDataProvider<TreeNode>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly scanner: DeviceScanner) {
    // Re-render whenever the scanner reports a change or an error.
    this.scanner.onDidChangeDevices(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.type) {
      case "device":
        return this.deviceItem(node.device);
      case "detail": {
        const item = new vscode.TreeItem(
          `${node.label}: ${node.value}`,
          vscode.TreeItemCollapsibleState.None
        );
        item.tooltip = node.value;
        return item;
      }
      case "message": {
        const item = new vscode.TreeItem(
          node.label,
          vscode.TreeItemCollapsibleState.None
        );
        if (node.icon) {
          item.iconPath = new vscode.ThemeIcon(node.icon);
        }
        return item;
      }
    }
  }

  getChildren(node?: TreeNode): TreeNode[] {
    // Root level.
    if (!node) {
      const loadError = this.scanner.getLoadError();
      if (loadError) {
        return [
          {
            type: "message",
            label: "serialport failed to load — see Output / hover for details",
            icon: "error",
          },
          { type: "detail", label: "Fix", value: loadError },
        ];
      }
      const devices = this.scanner.getDevices();
      if (devices.length === 0) {
        return [
          {
            type: "message",
            label: "No devices detected — connect a board and Refresh",
            icon: "info",
          },
        ];
      }
      return devices.map((device) => ({ type: "device", device }));
    }

    // Children of a device row = its detail rows.
    if (node.type === "device") {
      return this.detailRows(node.device);
    }
    return [];
  }

  private deviceItem(device: DetectedDevice): vscode.TreeItem {
    const item = new vscode.TreeItem(
      device.path,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    item.description = device.identity.label;
    item.tooltip = new vscode.MarkdownString(
      `**${device.path}** — ${device.identity.label}\n\n` +
        (device.identity.chipHint ? `${device.identity.chipHint}\n\n` : "") +
        (device.identity.detail ?? "")
    );
    item.iconPath = iconForKind(device.identity.kind);
    // Used by the `view/item/context` menu `when` clause to show Copy Info.
    item.contextValue = "hardwareDevice";
    return item;
  }

  private detailRows(d: DetectedDevice): TreeNode[] {
    const rows: TreeNode[] = [];
    const vidpid =
      d.vendorId !== undefined
        ? `${hex(d.vendorId)}:${d.productId !== undefined ? hex(d.productId) : "????"}`
        : "n/a";
    rows.push({ type: "detail", label: "VID:PID", value: vidpid });
    rows.push({
      type: "detail",
      label: "Connection",
      value: kindLabel(d.identity.kind),
    });
    if (d.identity.bridgeChip) {
      rows.push({ type: "detail", label: "Bridge", value: d.identity.bridgeChip });
    }
    if (d.identity.chipHint) {
      rows.push({ type: "detail", label: "Chip", value: d.identity.chipHint });
    }
    if (d.manufacturer) {
      rows.push({ type: "detail", label: "Manufacturer", value: d.manufacturer });
    }
    if (d.serialNumber) {
      rows.push({ type: "detail", label: "Serial", value: d.serialNumber });
    }
    if (d.pnpId) {
      rows.push({ type: "detail", label: "PnP ID", value: d.pnpId });
    }
    return rows;
  }
}

function iconForKind(kind: ConnectionKind): vscode.ThemeIcon {
  switch (kind) {
    case "native":
      // Highlight likely-ESP32 native-USB devices in green.
      return new vscode.ThemeIcon(
        "circuit-board",
        new vscode.ThemeColor("charts.green")
      );
    case "bridge":
      return new vscode.ThemeIcon("plug");
    default:
      return new vscode.ThemeIcon("question");
  }
}

function kindLabel(kind: ConnectionKind): string {
  switch (kind) {
    case "native":
      return "Native USB (no bridge)";
    case "bridge":
      return "USB-to-UART bridge";
    default:
      return "Unknown";
  }
}

function hex(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, "0");
}
