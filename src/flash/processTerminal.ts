// A Pseudoterminal that runs a child process and streams its output.
//
// Reused for every esptool operation (flash_id, write_flash, erase_flash). Using
// a terminal instead of an OutputChannel matters here because esptool draws its
// progress with bare carriage returns ("Writing at 0x... ( 42 %)\r"); a terminal
// renders that as a single updating line, an OutputChannel would spam hundreds.

import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";

export class ProcessPseudoterminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;

  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidClose: vscode.Event<number | void> = this.closeEmitter.event;

  private child?: ChildProcess;

  constructor(
    private readonly command: string,
    private readonly args: string[]
  ) {}

  open(): void {
    // Echo the exact command so the user can see (and copy) what ran.
    this.line(`\x1b[1;36m$ ${this.command} ${this.args.join(" ")}\x1b[0m`);
    this.line("");

    try {
      this.child = spawn(this.command, this.args, { windowsHide: true });
    } catch (err) {
      this.line(`\x1b[31mfailed to start: ${message(err)}\x1b[0m`);
      this.closeEmitter.fire(1);
      return;
    }

    this.child.stdout?.on("data", (d: Buffer) => this.emit(d));
    this.child.stderr?.on("data", (d: Buffer) => this.emit(d));
    this.child.on("error", (err) =>
      this.line(`\r\n\x1b[31m${err.message}\x1b[0m`)
    );
    this.child.on("close", (code) => {
      this.line("");
      this.line(
        code === 0
          ? "\x1b[32m[done]\x1b[0m"
          : `\x1b[31m[exited with code ${code}]\x1b[0m`
      );
      this.line("\x1b[2m(close this terminal when finished)\x1b[0m");
      this.closeEmitter.fire(code ?? 0);
    });
  }

  close(): void {
    this.child?.kill();
  }

  handleInput(data: string): void {
    // Ctrl+C aborts the running operation.
    if (data === "\x03") {
      this.child?.kill("SIGINT");
    }
  }

  private emit(chunk: Buffer): void {
    // Promote lone LF to CRLF for the terminal; leave bare CR (progress) intact.
    this.writeEmitter.fire(chunk.toString("utf8").replace(/\r?\n/g, "\r\n"));
  }

  private line(text: string): void {
    this.writeEmitter.fire(text + "\r\n");
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
