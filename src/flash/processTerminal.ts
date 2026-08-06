// A Pseudoterminal that runs one or more child processes and streams their output.
//
// Reused for every esptool operation (flash_id, write_flash, erase_flash). Using
// a terminal instead of an OutputChannel matters here because esptool draws its
// progress with bare carriage returns ("Writing at 0x... ( 42 %)\r"); a terminal
// renders that as a single updating line, an OutputChannel would spam hundreds.
//
// Steps run sequentially in the same terminal; if a step exits non-zero the
// remaining steps are skipped (e.g. don't write_flash if erase_flash failed).
//
// The terminal is intentionally left OPEN when the run finishes: we never fire
// onDidClose, so VS Code keeps the tab around and the user can read the full
// output (and any error) and close it themselves. A completion callback lets the
// caller run cleanup (e.g. delete a downloaded temp image) without closing it.

import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";

/** One command to run: an executable plus its arguments. */
export interface CommandStep {
  command: string;
  args: string[];
}

export class ProcessPseudoterminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;

  private readonly steps: CommandStep[];
  private child?: ChildProcess;
  private aborted = false;
  private finished = false;

  /**
   * @param steps      one command, or a sequence run in order.
   * @param onComplete called once when the run ends (success, failure, or
   *                   abort) with the last exit code. Does not close the terminal.
   */
  constructor(
    steps: CommandStep[] | CommandStep,
    private readonly onComplete?: (code: number) => void
  ) {
    this.steps = Array.isArray(steps) ? steps : [steps];
  }

  open(): void {
    this.runFrom(0);
  }

  // Called by VS Code when the user closes the terminal tab.
  close(): void {
    this.aborted = true;
    this.child?.kill();
  }

  handleInput(data: string): void {
    // Ctrl+C aborts the running operation (and the rest of the chain).
    if (data === "\x03") {
      this.aborted = true;
      this.child?.kill("SIGINT");
    }
  }

  /** Run steps[index], then recurse to the next one on success. */
  private runFrom(index: number): void {
    if (this.aborted) {
      return;
    }
    const step = this.steps[index];
    if (!step) {
      // All steps completed successfully.
      this.line("");
      this.line("\x1b[32m[done]\x1b[0m");
      this.line(
        "\x1b[2m(finished — this terminal stays open so you can read the " +
          "output; close it when you're done)\x1b[0m"
      );
      this.complete(0);
      return;
    }

    // Echo the exact command so the user can see (and copy) what ran.
    const label =
      this.steps.length > 1 ? `[${index + 1}/${this.steps.length}] ` : "";
    this.line(`\x1b[1;36m${label}$ ${step.command} ${step.args.join(" ")}\x1b[0m`);
    this.line("");

    try {
      this.child = spawn(step.command, step.args, { windowsHide: true });
    } catch (err) {
      this.line(`\x1b[31mfailed to start: ${message(err)}\x1b[0m`);
      this.complete(1);
      return;
    }

    this.child.stdout?.on("data", (d: Buffer) => this.emit(d));
    this.child.stderr?.on("data", (d: Buffer) => this.emit(d));
    this.child.on("error", (err) =>
      this.line(`\r\n\x1b[31m${err.message}\x1b[0m`)
    );
    this.child.on("close", (code) => {
      if (this.aborted) {
        this.line("");
        this.line("\x1b[31m[aborted]\x1b[0m");
        this.complete(code ?? 1);
        return;
      }
      if (code !== 0) {
        // Stop the chain: don't run later steps after a failure.
        this.line("");
        this.line(`\x1b[31m[exited with code ${code}]\x1b[0m`);
        if (index < this.steps.length - 1) {
          this.line("\x1b[2m(remaining steps skipped)\x1b[0m");
        }
        this.line(
          "\x1b[2m(this terminal stays open so you can read the error; " +
            "close it when you're done)\x1b[0m"
        );
        this.complete(code ?? 1);
        return;
      }
      // Success: on to the next step.
      this.line("");
      this.runFrom(index + 1);
    });
  }

  /** Fire the completion callback once. Deliberately does NOT close the terminal. */
  private complete(code: number): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.onComplete?.(code);
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
