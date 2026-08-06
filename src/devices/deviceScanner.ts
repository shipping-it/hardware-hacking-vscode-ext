// Device scanner: enumerates serial/USB ports and turns them into DetectedDevice[].
//
// Design notes:
//  - We import `serialport` LAZILY (inside a try/catch) rather than at the top of
//    the file. `serialport` loads a native binary; if that fails to load in the
//    VS Code Electron host, we want to surface a friendly error instead of
//    crashing the whole extension on activation.
//  - We poll on an interval and only fire `onDidChangeDevices` when the set of
//    devices actually changes, so the tree doesn't flicker/redraw every tick.

import { EventEmitter, Disposable, Event } from "vscode";
import { DetectedDevice, deviceKey } from "./types";
import { identifyDevice } from "./chipDatabase";
import { loadSerialport, serialportRebuildHint } from "../serial/serialportLoader";

const POLL_INTERVAL_MS = 2000;

/** Minimal shape of serialport's PortInfo that we consume. */
interface PortInfoLike {
  path: string;
  vendorId?: string; // hex string, e.g. "303a"
  productId?: string; // hex string, e.g. "1001"
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
}

/** Loaded lazily; `null` until first use, then either the fn or an Error. */
type ListFn = () => Promise<PortInfoLike[]>;

export class DeviceScanner implements Disposable {
  private readonly _onDidChangeDevices = new EventEmitter<void>();
  /** Fires whenever the detected device set changes (or the error state does). */
  readonly onDidChangeDevices: Event<void> = this._onDidChangeDevices.event;

  private timer: ReturnType<typeof setInterval> | undefined;
  private listFn: ListFn | undefined;
  private devices: DetectedDevice[] = [];
  /** Non-null when the native serialport binding failed to load. */
  private loadError: string | undefined;

  /** Current snapshot of detected devices (empty while errored). */
  getDevices(): readonly DetectedDevice[] {
    return this.devices;
  }

  /** Human-readable load error, or undefined if serialport loaded fine. */
  getLoadError(): string | undefined {
    return this.loadError;
  }

  /** Begin polling. Runs one immediate scan, then every POLL_INTERVAL_MS. */
  start(): void {
    void this.scan();
    this.timer = setInterval(() => void this.scan(), POLL_INTERVAL_MS);
  }

  /** Force an immediate re-scan (wired to the Refresh command). */
  async refresh(): Promise<void> {
    await this.scan();
  }

  /**
   * Lazily resolve serialport's `list` function. On failure we cache a friendly
   * message in `loadError` and return undefined so callers can render it.
   */
  private async getListFn(): Promise<ListFn | undefined> {
    if (this.listFn) {
      return this.listFn;
    }
    if (this.loadError) {
      return undefined; // already tried and failed; don't spam retries
    }
    try {
      const { SerialPort } = await loadSerialport();
      this.listFn = () => SerialPort.list();
      return this.listFn;
    } catch (err) {
      this.loadError =
        "Failed to load the native 'serialport' module: " +
        (err instanceof Error ? err.message : String(err)) +
        "\n" +
        serialportRebuildHint();
      this._onDidChangeDevices.fire();
      return undefined;
    }
  }

  /** Perform one enumeration and fire the change event if the set changed. */
  private async scan(): Promise<void> {
    const list = await this.getListFn();
    if (!list) {
      return; // load failed; error state already published
    }

    let ports: PortInfoLike[];
    try {
      ports = await list();
    } catch (err) {
      // A transient enumeration error shouldn't wipe the last good list;
      // just log and keep the previous snapshot.
      console.error("[hardware-hacker] SerialPort.list() failed:", err);
      return;
    }

    const next = ports.map((p) => this.toDevice(p));
    next.sort((a, b) => a.path.localeCompare(b.path));

    if (this.hasChanged(next)) {
      this.devices = next;
      this._onDidChangeDevices.fire();
    }
  }

  /** Normalize serialport's PortInfo into our DetectedDevice model. */
  private toDevice(p: PortInfoLike): DetectedDevice {
    const vendorId = parseHex(p.vendorId);
    const productId = parseHex(p.productId);
    return {
      path: p.path,
      vendorId,
      productId,
      manufacturer: p.manufacturer,
      serialNumber: p.serialNumber,
      pnpId: p.pnpId,
      identity: identifyDevice(vendorId, productId),
    };
  }

  /** Structural comparison against the current snapshot (order-independent-ish). */
  private hasChanged(next: DetectedDevice[]): boolean {
    if (next.length !== this.devices.length) {
      return true;
    }
    const prevKeys = new Set(this.devices.map(deviceKey));
    return next.some((d) => !prevKeys.has(deviceKey(d)));
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this._onDidChangeDevices.dispose();
  }
}

/** Parse serialport's hex string ("303a") into a number, tolerant of "0x" prefix. */
function parseHex(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const n = parseInt(value.replace(/^0x/i, ""), 16);
  return Number.isNaN(n) ? undefined : n;
}
