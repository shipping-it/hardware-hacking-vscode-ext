// Shared lazy loader for the native `serialport` module.
//
// Both the device scanner and the serial monitor need `serialport`, and it's a
// native module that we want to (a) load only once and (b) fail softly if the
// native binary can't be loaded in VS Code's Electron runtime. Centralizing the
// dynamic import here keeps that logic in one place.

/** The subset of the serialport module surface we rely on. */
export interface SerialportModule {
  // The SerialPort class: `new SerialPort({...})` and static `SerialPort.list()`.
  SerialPort: any;
}

let modPromise: Promise<SerialportModule> | undefined;

/**
 * Load (once) and return the serialport module. Rejects if the native binding
 * fails to load. The resolved promise is cached; a rejection is also cached, so
 * we don't hammer a broken native module on every poll — the extension host
 * restarts (clearing this cache) if the user rebuilds and reloads the window.
 */
export function loadSerialport(): Promise<SerialportModule> {
  if (!modPromise) {
    modPromise = import("serialport").then((m: any) => {
      const SerialPort = m.SerialPort ?? m.default?.SerialPort;
      if (!SerialPort || typeof SerialPort.list !== "function") {
        throw new Error("serialport module did not expose SerialPort.list");
      }
      return { SerialPort };
    });
  }
  return modPromise;
}

/** Standard remediation hint shown whenever the native module fails to load. */
export function serialportRebuildHint(): string {
  return (
    "Rebuild the native module for VS Code's Electron runtime:\n" +
    "  npx @electron/rebuild -f -w serialport\n" +
    "then reload the window (Developer: Reload Window)."
  );
}
