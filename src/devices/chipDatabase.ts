// USB Vendor/Product ID -> device identification.
//
// This is the heart of "is this an ESP32, and how is it connected?". It is a
// deliberately small, heavily-commented lookup table so it is easy to extend as
// you meet new boards. Add an entry, reload the extension, done.
//
// ---------------------------------------------------------------------------
// The one big honesty caveat (important for hardware hacking!):
//
//   A USB-to-UART *bridge* chip (CP210x, CH340, FTDI, PL2303) is a generic
//   part. The SAME CP2102 sits on ESP32 boards, STM32 boards, Arduino clones,
//   GPS modules, and countless others. So when we see a bridge VID/PID we can
//   confidently name the *bridge*, but we CANNOT know the target MCU behind it
//   from USB IDs alone.
//
//   Only Espressif's own USB Vendor ID (0x303A) tells us we're truly looking at
//   an Espressif SoC — because those chips (ESP32-S2/-S3/-C3/-C6/...) speak USB
//   natively via their built-in USB peripheral, no bridge involved. Even then
//   the VID doesn't pin down the exact variant; the PID and USB mode narrow it.
// ---------------------------------------------------------------------------

import type { DeviceIdentity } from "./types";

// --- Well-known USB Vendor IDs -------------------------------------------------
const VID_ESPRESSIF = 0x303a; // Espressif Systems (native-USB SoCs)
const VID_SILABS = 0x10c4; // Silicon Labs (CP210x bridges)
const VID_WCH = 0x1a86; // WCH / Jiangsu Qinheng (CH340/CH341/CH9102 bridges)
const VID_FTDI = 0x0403; // FTDI (FT232/FT2232/... bridges)
const VID_PROLIFIC = 0x067b; // Prolific (PL2303 bridges)

/**
 * Known Espressif native-USB Product IDs and what USB "mode" they present.
 * The SoC can re-enumerate under different PIDs depending on how it booted.
 */
const ESPRESSIF_PIDS: Record<number, string> = {
  0x1001: "USB-Serial-JTAG (CDC) mode", // typical running/monitor mode on S3/C3/C6
  0x0002: "DFU / download mode",
  0x0009: "DFU / download mode",
};

/**
 * Rough mapping of WCH product IDs to the specific bridge part, purely for a
 * nicer label. Unknown PIDs still resolve to the generic "CH34x" family.
 */
const WCH_PIDS: Record<number, string> = {
  0x7523: "CH340",
  0x5523: "CH341",
  0x55d4: "CH9102",
};

function hex(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Classify a device from its USB Vendor/Product IDs.
 *
 * @param vendorId  numeric USB VID (undefined for non-USB ports)
 * @param productId numeric USB PID (undefined if unknown)
 */
export function identifyDevice(
  vendorId?: number,
  productId?: number
): DeviceIdentity {
  // Non-USB / virtual serial ports (Bluetooth SPP, PCI UARTs, com0com, ...)
  if (vendorId === undefined) {
    return {
      label: "Serial port (no USB info)",
      kind: "unknown",
      detail:
        "This port reports no USB Vendor/Product ID. It may be a built-in " +
        "UART, a Bluetooth serial port, or a virtual port.",
    };
  }

  switch (vendorId) {
    case VID_ESPRESSIF: {
      const mode =
        productId !== undefined ? ESPRESSIF_PIDS[productId] : undefined;
      return {
        label: "Espressif native-USB device",
        kind: "native",
        chipHint: "Espressif SoC (likely ESP32-S3 / -S2 / -C3 / -C6)",
        detail:
          `Espressif USB VID 0x${hex(VID_ESPRESSIF)}` +
          (productId !== undefined ? `, PID 0x${hex(productId)}` : "") +
          (mode ? ` — ${mode}.` : ".") +
          " This is a chip speaking USB directly via its built-in USB " +
          "peripheral (no UART bridge). The exact variant can't be read from " +
          "the VID alone; confirm via chip detection / esptool in a later step.",
      };
    }

    case VID_SILABS:
      return bridge("CP210x", VID_SILABS, productId,
        "Silicon Labs CP210x USB-to-UART bridge (e.g. CP2102/CP2104).");

    case VID_WCH: {
      const part =
        (productId !== undefined && WCH_PIDS[productId]) || "CH34x";
      return bridge(part, VID_WCH, productId,
        "WCH USB-to-UART bridge, common on low-cost ESP32/Arduino clones.");
    }

    case VID_FTDI:
      return bridge("FTDI", VID_FTDI, productId,
        "FTDI USB-to-UART bridge (e.g. FT232R/FT2232).");

    case VID_PROLIFIC:
      return bridge("PL2303", VID_PROLIFIC, productId,
        "Prolific PL2303 USB-to-UART bridge.");

    default:
      return {
        label: `Unrecognized USB device (VID 0x${hex(vendorId)})`,
        kind: "unknown",
        detail:
          `USB VID 0x${hex(vendorId)}` +
          (productId !== undefined ? `, PID 0x${hex(productId)}` : "") +
          ". Not in the chip database yet — add it to chipDatabase.ts to give " +
          "it a friendly name.",
      };
  }
}

/** Build a `bridge`-kind identity with the shared honesty caveat baked in. */
function bridge(
  bridgeChip: string,
  vendorId: number,
  productId: number | undefined,
  note: string
): DeviceIdentity {
  return {
    label: `${bridgeChip} USB-UART bridge`,
    kind: "bridge",
    bridgeChip,
    detail:
      `${note} VID 0x${hex(vendorId)}` +
      (productId !== undefined ? `, PID 0x${hex(productId)}` : "") +
      ". NOTE: a bridge chip is generic — the target MCU behind it (ESP32 or " +
      "otherwise) cannot be determined from USB IDs alone.",
  };
}
