// Serial monitor: a VS Code Pseudoterminal backed by a SerialConnection.
//
// Using a Pseudoterminal (rather than a webview) means the monitor IS a real
// VS Code terminal tab: ANSI colors from ESP32 boot logs render correctly, and
// scrollback, copy/paste, and find all work for free. Keyboard input typed into
// the terminal is forwarded to the device.

import * as vscode from "vscode";
import { SerialConnection } from "./serialConnection";
import { serialportRebuildHint } from "./serialportLoader";

/** Behavior knobs read from configuration at connect time. */
export interface MonitorOptions {
  /** Echo typed characters back into the terminal (many devices don't echo). */
  localEcho: boolean;
  /** Bytes sent to the device when Enter is pressed (may be empty). */
  lineEnding: string;
}

/**
 * The Pseudoterminal implementation. One instance drives one terminal tab and
 * owns one SerialConnection.
 */
export class SerialPseudoterminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;

  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidClose: vscode.Event<number | void> = this.closeEmitter.event;

  private readonly connection: SerialConnection;
  private connected = false;

  constructor(
    readonly path: string,
    public baudRate: number,
    private readonly opts: MonitorOptions,
    private readonly label = "Serial Monitor"
  ) {
    this.connection = new SerialConnection(path, baudRate);
  }

  // Called by VS Code when the terminal is first shown.
  open(): void {
    this.banner(`${this.label} — ${this.path} @ ${this.baudRate} baud`);

    this.connection.onData((chunk) => {
      // Terminals need CRLF; promote bare LF so lines don't stair-step.
      this.writeEmitter.fire(chunk.toString("utf8").replace(/\r?\n/g, "\r\n"));
    });

    this.connection.onClose((err) => {
      this.connected = false;
      if (err) {
        this.system(`connection error: ${err.message}`);
      }
      this.system("disconnected");
      this.closeEmitter.fire();
    });

    void this.connect();
  }

  private async connect(): Promise<void> {
    try {
      await this.connection.open();
      this.connected = true;
      this.system("connected — type to send, close the terminal to disconnect");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.system(`failed to open ${this.path}: ${msg}`);
      // If it's the native module, point the user at the fix.
      if (/serialport|bindings|\.node/i.test(msg)) {
        this.system(serialportRebuildHint());
      }
      this.closeEmitter.fire();
    }
  }

  // Called by VS Code when the terminal is closed.
  close(): void {
    void this.connection.close().finally(() => this.connection.dispose());
  }

  // Called by VS Code for each keystroke typed into the terminal.
  handleInput(data: string): void {
    if (!this.connected) {
      return;
    }
    if (data === "\r") {
      // Enter: send the configured line ending, echo a newline locally.
      this.connection.write(this.opts.lineEnding);
      if (this.opts.localEcho) {
        this.writeEmitter.fire("\r\n");
      }
      return;
    }
    if (data === "\x7f") {
      // Backspace: erase one cell locally, forward DEL to the device.
      if (this.opts.localEcho) {
        this.writeEmitter.fire("\b \b");
      }
      this.connection.write("\x7f");
      return;
    }
    this.connection.write(data);
    if (this.opts.localEcho) {
      this.writeEmitter.fire(data);
    }
  }

  /** Send a whole line (used by the "Send Text" command). */
  sendLine(text: string): void {
    if (!this.connected) {
      return;
    }
    this.connection.write(text + this.opts.lineEnding);
    if (this.opts.localEcho) {
      this.writeEmitter.fire(text + "\r\n");
    }
  }

  /** Change baud on the live connection. */
  async setBaudRate(baud: number): Promise<void> {
    try {
      await this.connection.setBaudRate(baud);
      this.baudRate = baud;
      this.system(`baud rate set to ${baud}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.system(`failed to set baud rate: ${msg}`);
    }
  }

  // --- small output helpers (system messages are dimmed via ANSI) ----------
  private banner(text: string): void {
    this.writeEmitter.fire(`\x1b[1;36m${text}\x1b[0m\r\n`);
  }
  private system(text: string): void {
    this.writeEmitter.fire(`\x1b[2m[${text}]\x1b[0m\r\n`);
  }
}

/** One live monitor session (a terminal tab + its pseudoterminal). */
interface MonitorSession {
  path: string;
  terminal: vscode.Terminal;
  pty: SerialPseudoterminal;
}

/**
 * Optional overrides for a monitor session. Anything omitted falls back to the
 * `hardwareHacker.monitor.*` settings. Used by the MicroPython REPL, which needs
 * fixed 115200 baud, local echo off (the REPL echoes its own characters), and a
 * bare CR on Enter.
 */
export interface MonitorOverrides {
  baudRate?: number;
  localEcho?: boolean;
  /** Raw bytes sent on Enter (already decoded, not the config enum). */
  lineEnding?: string;
  /** Terminal name and banner label, e.g. "MicroPython REPL". */
  label?: string;
}

/**
 * Manages serial monitor sessions — at most one per port path. Resolves the
 * "target" for baud/send/disconnect commands from either the tree selection or
 * the currently active terminal.
 */
export class SerialMonitorManager implements vscode.Disposable {
  private readonly sessions = new Map<string, MonitorSession>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    // Drop a session from the map when its terminal is closed by the user.
    this.disposables.push(
      vscode.window.onDidCloseTerminal((t) => {
        for (const [path, s] of this.sessions) {
          if (s.terminal === t) {
            this.sessions.delete(path);
            break;
          }
        }
      })
    );
  }

  /** Open (or reveal) the monitor for a port. Returns the session. */
  open(path: string, overrides?: MonitorOverrides): MonitorSession {
    const existing = this.sessions.get(path);
    if (existing) {
      existing.terminal.show();
      return existing;
    }
    const opts = this.readOptions();
    if (overrides?.localEcho !== undefined) {
      opts.localEcho = overrides.localEcho;
    }
    if (overrides?.lineEnding !== undefined) {
      opts.lineEnding = overrides.lineEnding;
    }
    const baud = overrides?.baudRate ?? this.readBaudRate();
    const label = overrides?.label ?? "Serial Monitor";
    const pty = new SerialPseudoterminal(path, baud, opts, label);
    const terminal = vscode.window.createTerminal({
      name: overrides?.label ? `${label} ${path}` : `Serial ${path}`,
      pty,
    });
    const session: MonitorSession = { path, terminal, pty };
    this.sessions.set(path, session);
    terminal.show();
    return session;
  }

  /** The session for a specific port, if open. */
  get(path: string): MonitorSession | undefined {
    return this.sessions.get(path);
  }

  /** The session whose terminal is currently focused, if any. */
  activeSession(): MonitorSession | undefined {
    const active = vscode.window.activeTerminal;
    if (!active) {
      return undefined;
    }
    for (const s of this.sessions.values()) {
      if (s.terminal === active) {
        return s;
      }
    }
    return undefined;
  }

  /** Close the monitor for a port (disposing its terminal). */
  close(path: string): void {
    this.sessions.get(path)?.terminal.dispose();
  }

  dispose(): void {
    for (const s of this.sessions.values()) {
      s.terminal.dispose();
    }
    this.sessions.clear();
    this.disposables.forEach((d) => d.dispose());
  }

  private readBaudRate(): number {
    const cfg = vscode.workspace.getConfiguration("hardwareHacker.monitor");
    return cfg.get<number>("baudRate", 115200);
  }

  private readOptions(): MonitorOptions {
    const cfg = vscode.workspace.getConfiguration("hardwareHacker.monitor");
    return {
      localEcho: cfg.get<boolean>("localEcho", true),
      lineEnding: decodeLineEnding(cfg.get<string>("lineEnding", "crlf")),
    };
  }
}

/** Map the friendly config enum to the actual bytes sent on Enter. */
function decodeLineEnding(value: string): string {
  switch (value) {
    case "lf":
      return "\n";
    case "cr":
      return "\r";
    case "none":
      return "";
    case "crlf":
    default:
      return "\r\n";
  }
}
