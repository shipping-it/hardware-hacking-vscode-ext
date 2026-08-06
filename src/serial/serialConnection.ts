// A thin, promise-friendly wrapper around a single open serialport connection.
//
// Keeps the raw serialport object private and exposes just what the monitor
// needs: data events, a close event, write, and a live baud-rate change.

import { EventEmitter, Event } from "vscode";
import { loadSerialport } from "./serialportLoader";

export class SerialConnection {
  private port: any;
  private opened = false;

  private readonly _onData = new EventEmitter<Buffer>();
  /** Fires for each chunk of bytes received from the device. */
  readonly onData: Event<Buffer> = this._onData.event;

  private readonly _onClose = new EventEmitter<Error | undefined>();
  /** Fires when the port closes; carries an Error for abnormal closes. */
  readonly onClose: Event<Error | undefined> = this._onClose.event;

  constructor(
    readonly path: string,
    public baudRate: number
  ) {}

  /** Open the port. Rejects if the native module or the port itself fails. */
  async open(): Promise<void> {
    const { SerialPort } = await loadSerialport();
    this.port = new SerialPort({
      path: this.path,
      baudRate: this.baudRate,
      autoOpen: false,
    });

    await new Promise<void>((resolve, reject) => {
      this.port.open((err: Error | null) => (err ? reject(err) : resolve()));
    });
    this.opened = true;

    this.port.on("data", (chunk: Buffer) => this._onData.fire(chunk));
    this.port.on("error", (err: Error) => this._onClose.fire(err));
    this.port.on("close", () => {
      this.opened = false;
      this._onClose.fire(undefined);
    });
  }

  /** Write raw data to the device (no-op if not open). */
  write(data: string | Buffer): void {
    if (this.opened && this.port) {
      this.port.write(data);
    }
  }

  /** Change baud rate on the live connection without closing it. */
  async setBaudRate(baud: number): Promise<void> {
    this.baudRate = baud;
    if (this.opened && this.port) {
      await new Promise<void>((resolve, reject) => {
        this.port.update({ baudRate: baud }, (err: Error | null) =>
          err ? reject(err) : resolve()
        );
      });
    }
  }

  /** Close the port if open. Safe to call multiple times. */
  async close(): Promise<void> {
    if (this.port && this.opened) {
      await new Promise<void>((resolve) => this.port.close(() => resolve()));
    }
    this.opened = false;
  }

  /** Release event emitters. Call after `close()` when done with the connection. */
  dispose(): void {
    this._onData.dispose();
    this._onClose.dispose();
  }
}
