// Shared data model for a detected device.
//
// This module is intentionally free of any `vscode` imports so the detection
// layer stays decoupled from the UI. Later milestones (serial monitor, flashing)
// will reuse `DetectedDevice` as the common currency between layers.

/**
 * How a device is (probably) connected to the host.
 *
 * - `native`  : the chip exposes USB directly (e.g. an ESP32-S3 using its
 *               built-in USB peripheral / USB-Serial-JTAG). No bridge chip.
 * - `bridge`  : a separate USB-to-UART bridge chip (CP210x, CH340, FTDI, ...)
 *               sits between the target chip and USB.
 * - `unknown` : we could not classify it from the USB IDs.
 */
export type ConnectionKind = "native" | "bridge" | "unknown";

/**
 * The result of looking a device up in the chip database. This is a *best
 * effort* interpretation of the USB Vendor/Product IDs — see `chipDatabase.ts`
 * for the honesty caveats (a generic bridge chip cannot tell us the exact
 * target MCU).
 */
export interface DeviceIdentity {
  /** Human-readable one-liner shown as the device's title. */
  label: string;
  /** Classification used for iconography and later logic. */
  kind: ConnectionKind;
  /** The bridge chip family, when `kind === "bridge"` (e.g. "CP210x"). */
  bridgeChip?: string;
  /** A hint about the target MCU, when we can infer one (e.g. Espressif SoC). */
  chipHint?: string;
  /** Longer explanation, surfaced as a tooltip / detail row. */
  detail?: string;
}

/**
 * A single detected serial/USB device, normalized from serialport's `PortInfo`.
 * VID/PID are stored as numbers (serialport reports them as hex strings).
 */
export interface DetectedDevice {
  /** OS port path, e.g. "COM7" on Windows or "/dev/ttyUSB0" on Linux. */
  path: string;
  /** USB Vendor ID, or undefined for non-USB / virtual ports. */
  vendorId?: number;
  /** USB Product ID, or undefined. */
  productId?: number;
  manufacturer?: string;
  serialNumber?: string;
  /** OS Plug-and-Play id string (raw, useful for debugging). */
  pnpId?: string;
  /** Best-effort identification from the chip database. */
  identity: DeviceIdentity;
}

/**
 * A stable key for change detection — two scans are "the same device" if this
 * matches. Includes VID/PID so a board re-enumerating under a different mode is
 * treated as a change.
 */
export function deviceKey(d: DetectedDevice): string {
  return `${d.path}|${d.vendorId ?? ""}|${d.productId ?? ""}`;
}
