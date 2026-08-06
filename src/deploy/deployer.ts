// Orchestrates deploying a Python file (and the local modules it imports) to a
// MicroPython board via mpremote.
//
// Mirrors flasher.ts: locate the tool (or bail with an install hint), free the
// serial port by closing any open monitor on it, then run mpremote in a
// process-backed terminal so the user sees live output.
//
// Two modes, chosen per run:
//   - "install": copy the entry file to the device as main.py (so it runs on
//     every boot) plus its dependencies, then optionally reset.
//   - "run": copy only the dependencies, then `mpremote run <entry>` — streams
//     the program's output without persisting the entry file.

import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ProcessPseudoterminal, CommandStep } from "../flash/processTerminal";
import {
  locateMpremote,
  mpremoteInstallHint,
  MpremoteInvocation,
} from "./mpremote";
import { resolveDeployment, DeployFile } from "./importResolver";
import { SerialMonitorManager } from "../serial/serialMonitor";

type DeployMode = "install" | "run";

export class Deployer {
  constructor(private readonly monitors: SerialMonitorManager) {}

  /**
   * Deploy a Python file to the board.
   *
   * @param devicePath serial port of the target board.
   * @param entryFile  the .py to deploy; if omitted, uses the active editor or
   *                   prompts with an open dialog.
   */
  async deploy(devicePath: string, entryFile?: string): Promise<void> {
    const inv = await this.ensureMpremote();
    if (!inv) {
      return;
    }

    const entry = await this.resolveEntryFile(entryFile);
    if (!entry) {
      return;
    }

    const sourceRoot = this.sourceRootFor(entry);
    const { files, unresolved } = resolveDeployment(entry, sourceRoot);

    const mode = await this.askMode(path.basename(entry), files.length);
    if (!mode) {
      return;
    }

    // Let the user know which imports were treated as already-on-device.
    if (unresolved.length > 0) {
      void vscode.window.showInformationMessage(
        `Deploying ${path.basename(entry)}: assuming these imports are builtin/` +
          `frozen on the board (not shipped): ${unresolved.join(", ")}.`
      );
    }

    const entryKey = path.normalize(path.resolve(entry));
    const staged = this.stagedFiles(files, entryKey, mode);

    let stageDir: string | undefined;
    if (staged.length > 0) {
      stageDir = this.writeStage(staged);
    }

    await this.freePort(devicePath);

    const steps = this.buildSteps(inv, devicePath, entry, stageDir, mode);
    this.runSteps(`mpremote deploy ${devicePath}`, steps, () => {
      if (stageDir) {
        this.cleanupTemp(stageDir);
      }
    });
  }

  // --- internals -----------------------------------------------------------

  private async ensureMpremote(): Promise<MpremoteInvocation | undefined> {
    const inv = await locateMpremote();
    if (!inv) {
      void vscode.window.showErrorMessage(mpremoteInstallHint());
    }
    return inv;
  }

  /** Prefer the active Python editor; otherwise show an open dialog. */
  private async resolveEntryFile(
    entryFile?: string
  ): Promise<string | undefined> {
    if (entryFile) {
      return entryFile;
    }
    const editor = vscode.window.activeTextEditor;
    if (
      editor &&
      (editor.document.languageId === "python" ||
        editor.document.uri.fsPath.toLowerCase().endsWith(".py"))
    ) {
      return editor.document.uri.fsPath;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Deploy this file",
      filters: { Python: ["py"], "All files": ["*"] },
    });
    return picked?.[0]?.fsPath;
  }

  /** Configured source root, or the entry file's own directory. */
  private sourceRootFor(entry: string): string {
    const configured = vscode.workspace
      .getConfiguration("hardwareHacker.deploy")
      .get<string>("sourceRoot", "")
      .trim();
    return configured ? configured : path.dirname(entry);
  }

  /** Ask install-as-main.py vs run-once. */
  private async askMode(
    entryName: string,
    fileCount: number
  ): Promise<DeployMode | undefined> {
    const suffix = fileCount > 1 ? ` (+${fileCount - 1} imported)` : "";
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: "Install as main.py",
          description: "runs automatically on every boot",
          detail: `Copies ${entryName}${suffix} to the board; entry becomes main.py.`,
          mode: "install" as const,
        },
        {
          label: "Run once",
          description: "stream output now, nothing persists",
          detail: `Ships imports${suffix ? "" : " (none)"}, then runs ${entryName} and shows its output.`,
          mode: "run" as const,
        },
      ],
      { title: `Deploy ${entryName}`, placeHolder: "How should it run?" }
    );
    return picked?.mode;
  }

  /**
   * The files to copy for a mode. Install renames the entry to main.py; run
   * ships only the dependencies (the entry streams from the host via `run`).
   */
  private stagedFiles(
    files: DeployFile[],
    entryKey: string,
    mode: DeployMode
  ): DeployFile[] {
    if (mode === "install") {
      return files.map((f) =>
        f.localPath === entryKey ? { ...f, devicePath: "main.py" } : f
      );
    }
    return files.filter((f) => f.localPath !== entryKey);
  }

  /** Copy staged files into a fresh temp dir mirroring the device layout. */
  private writeStage(staged: DeployFile[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-deploy-"));
    for (const f of staged) {
      const dest = path.join(dir, ...f.devicePath.split("/"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f.localPath, dest);
    }
    return dir;
  }

  /** Build the mpremote command steps for the chosen mode. */
  private buildSteps(
    inv: MpremoteInvocation,
    devicePath: string,
    entry: string,
    stageDir: string | undefined,
    mode: DeployMode
  ): CommandStep[] {
    const base = [...inv.baseArgs, "connect", devicePath];
    const steps: CommandStep[] = [];

    if (stageDir) {
      // `fs cp -r <stage>/. :` copies the *contents* of the staged tree into the
      // device root, creating directories as needed. mpremote detects "copy
      // contents" from a trailing "/." — it must be a forward slash even on
      // Windows, or it would copy the temp dir itself (with its random name).
      const contents = stageDir.split(path.sep).join("/") + "/.";
      steps.push({
        command: inv.command,
        args: [...base, "fs", "cp", "-r", contents, ":"],
      });
    }

    if (mode === "run") {
      steps.push({ command: inv.command, args: [...base, "run", entry] });
    } else if (this.resetAfter()) {
      steps.push({ command: inv.command, args: [...base, "reset"] });
    }

    return steps;
  }

  private resetAfter(): boolean {
    return vscode.workspace
      .getConfiguration("hardwareHacker.deploy")
      .get<boolean>("resetAfter", true);
  }

  /** Launch a (possibly multi-step) mpremote run in a terminal. */
  private runSteps(
    name: string,
    steps: CommandStep[],
    onComplete?: () => void
  ): void {
    const pty = new ProcessPseudoterminal(steps, onComplete);
    const terminal = vscode.window.createTerminal({ name, pty });
    terminal.show();
  }

  /** Close a monitor holding the port and give the OS a moment to release it. */
  private async freePort(devicePath: string): Promise<void> {
    if (this.monitors.get(devicePath)) {
      this.monitors.close(devicePath);
      await delay(400);
    }
  }

  /** Remove the staging temp dir after the run finishes. */
  private cleanupTemp(dir: string): void {
    fs.rm(dir, { recursive: true, force: true }, () => {
      /* best effort */
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
