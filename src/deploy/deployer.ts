// Orchestrates deploying Python code to a MicroPython board via mpremote.
//
// Mirrors flasher.ts: locate the tool (or bail with an install hint), free the
// serial port by closing any open monitor on it, then run mpremote in a
// process-backed terminal so the user sees live output.
//
// Two ways to decide WHAT gets deployed:
//
//   - Manifest mode: if the firmware repo has a build-produced
//     build/deploy.manifest.json (see manifest.ts), that manifest is the
//     complete and exact deployment — mip packages, staged files, reset — and
//     the import scanner NEVER runs. Detected automatically, nearest manifest
//     above the entry file wins.
//
//   - Import-scan mode (fallback): resolve the entry file's local imports and
//     ship those. Two sub-modes chosen per run:
//       - "install": copy the entry file to the device as main.py (so it runs
//         on every boot) plus its dependencies, then optionally reset.
//       - "run": copy only the dependencies, then `mpremote run <entry>` —
//         streams the program's output without persisting the entry file.

import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ProcessPseudoterminal, CommandStep } from "../flash/processTerminal";
import {
  locateMpremote,
  locatePython,
  mpremoteInstallHint,
  MpremoteInvocation,
} from "./mpremote";
import { resolveDeployment, DeployFile } from "./importResolver";
import {
  BuildScript,
  LoadedManifest,
  ManifestError,
  StalenessResult,
  checkStaleness,
  findBuildScript,
  findManifest,
  loadManifest,
  verifyStagedFiles,
} from "./manifest";
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

    // Tree-view invocation with no file in play: a manifest repo needs no
    // entry file at all (the manifest defines everything), so check the
    // workspace folders before forcing a meaningless .py open dialog.
    if (!entryFile && !this.activePythonFile()) {
      const workspaceManifest = await this.pickWorkspaceManifest();
      if (workspaceManifest) {
        return this.deployFromManifest(inv, devicePath, workspaceManifest);
      }
    }

    const entry = await this.resolveEntryFile(entryFile);
    if (!entry) {
      return;
    }

    // A build-produced manifest above the entry file takes precedence over
    // import scanning: the scan is blind to data files, mip packages, and
    // unimported files like boot.py, so when a repo declares its deployment
    // we ship exactly that and nothing else.
    const manifestPath = findManifest(
      path.dirname(entry),
      this.walkBoundFor(entry)
    );
    if (manifestPath) {
      return this.deployFromManifest(inv, devicePath, manifestPath);
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

  /** The active editor's file, if it looks like Python. */
  private activePythonFile(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (
      editor &&
      (editor.document.languageId === "python" ||
        editor.document.uri.fsPath.toLowerCase().endsWith(".py"))
    ) {
      return editor.document.uri.fsPath;
    }
    return undefined;
  }

  /** Prefer the active Python editor; otherwise show an open dialog. */
  private async resolveEntryFile(
    entryFile?: string
  ): Promise<string | undefined> {
    if (entryFile) {
      return entryFile;
    }
    const active = this.activePythonFile();
    if (active) {
      return active;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Deploy this file",
      filters: { Python: ["py"], "All files": ["*"] },
    });
    return picked?.[0]?.fsPath;
  }

  // --- manifest mode --------------------------------------------------------

  /**
   * Upper bound for the manifest walk. Inside the workspace that's the entry
   * file's workspace folder. A file picked from *outside* the workspace (via
   * the open dialog) still deserves manifest detection — falling back to the
   * import scanner there would silently half-provision a manifest repo — so
   * we bound at the volume root instead. build/deploy.manifest.json is a
   * specific enough marker that false positives are implausible, and
   * loadManifest validates whatever we find anyway.
   */
  private walkBoundFor(entry: string): string {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(entry));
    return folder ? folder.uri.fsPath : path.parse(path.resolve(entry)).root;
  }

  /**
   * Look for build/deploy.manifest.json at the root of each workspace folder.
   * One hit → use it directly; several → let the user pick the project.
   * (findManifest with start === stop checks exactly that one directory.)
   */
  private async pickWorkspaceManifest(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const found: { label: string; manifestPath: string }[] = [];
    for (const folder of folders) {
      const m = findManifest(folder.uri.fsPath, folder.uri.fsPath);
      if (m) {
        found.push({ label: folder.name, manifestPath: m });
      }
    }
    if (found.length === 0) {
      return undefined;
    }
    if (found.length === 1) {
      return found[0].manifestPath;
    }
    const picked = await vscode.window.showQuickPick(
      found.map((f) => ({ ...f, description: f.manifestPath })),
      {
        title: "Deploy which project?",
        placeHolder: "Multiple workspace folders have a deploy manifest",
      }
    );
    return picked?.manifestPath;
  }

  /**
   * Deploy exactly what a build-produced manifest declares. All validation —
   * parse, schema, staged-file hashes, staleness — happens before freePort(),
   * so an abort leaves the board completely untouched.
   *
   * @param skipStalenessCheck set on the re-entry after "Run Build First":
   *                           we just built, so the check would be noise.
   */
  private async deployFromManifest(
    inv: MpremoteInvocation,
    devicePath: string,
    manifestPath: string,
    skipStalenessCheck = false
  ): Promise<void> {
    let loaded: LoadedManifest;
    try {
      loaded = loadManifest(manifestPath);
    } catch (err) {
      void vscode.window.showErrorMessage(
        err instanceof ManifestError ? err.message : String(err)
      );
      return;
    }
    const manifest = loaded.manifest;

    if (manifest.mode === "run") {
      void vscode.window.showInformationMessage(
        `${manifest.name}: the manifest requests "run" mode, which is ` +
          'reserved and not supported yet. Only "install" manifests can be ' +
          "deployed."
      );
      return;
    }

    // The staged bundle must match the manifest byte-for-byte; a mismatch
    // means someone edited build/ by hand or the build was interrupted, and
    // deploying it would put unverified content on the board.
    const issues = verifyStagedFiles(loaded);
    if (issues.length > 0) {
      const shown = issues
        .slice(0, 5)
        .map((i) => i.detail)
        .join("; ");
      const suffix = issues.length > 5 ? `; and ${issues.length - 5} more` : "";
      void vscode.window.showErrorMessage(
        `${manifest.name}: the staged bundle does not match ` +
          `deploy.manifest.json (${shown}${suffix}). Re-run the firmware ` +
          "build (e.g. `python tools/build.py build`) and deploy again."
      );
      return;
    }

    if (!skipStalenessCheck) {
      const staleness = checkStaleness(loaded);
      if (staleness.stale) {
        const proceed = await this.confirmStale(
          inv,
          devicePath,
          loaded,
          staleness
        );
        if (!proceed) {
          return; // cancelled, or rebuilding (which re-enters on its own)
        }
      }
    }

    if (!(await this.confirmManifestDeploy(loaded, devicePath))) {
      return;
    }

    await this.freePort(devicePath);
    const steps = this.buildManifestSteps(inv, devicePath, loaded);
    // Unlike scan mode there is no temp staging dir to clean up — files ship
    // straight from build/fs/ — so no completion callback is needed.
    this.runSteps(`mpremote deploy ${devicePath} (${manifest.name})`, steps);
  }

  /**
   * Warn that sources changed after the build. Returns true to deploy the
   * stale manifest anyway; false to stop (cancel, or a rebuild was started —
   * the rebuild re-enters deployFromManifest itself once the build exits 0).
   */
  private async confirmStale(
    inv: MpremoteInvocation,
    devicePath: string,
    loaded: LoadedManifest,
    staleness: StalenessResult
  ): Promise<boolean> {
    // Offer a rebuild only when the repo ships a build entry we can actually
    // run — and never run it without this explicit confirmation.
    const buildStep = await this.buildStepFor(loaded);
    const buttons = buildStep
      ? ["Run Build First", "Deploy Anyway"]
      : ["Deploy Anyway"];

    const builtAt = new Date(loaded.manifest.builtAt).toLocaleString();
    const more =
      staleness.newerCount > staleness.newerFiles.length
        ? `\n…and ${staleness.newerCount - staleness.newerFiles.length} more`
        : "";
    const choice = await vscode.window.showWarningMessage(
      `${loaded.manifest.name}: ${staleness.newerCount} source file(s) ` +
        `changed since the manifest was built (${builtAt}). Deploying now ` +
        "would put stale code on the board.",
      {
        modal: true,
        detail: "Changed since build:\n" + staleness.newerFiles.join("\n") + more,
      },
      ...buttons
    );

    if (choice === "Deploy Anyway") {
      return true;
    }
    if (choice === "Run Build First" && buildStep) {
      // Build output streams in its own terminal. On exit 0 we re-enter the
      // whole manifest pipeline: the fresh manifest is re-read and re-verified
      // before any confirmation or board contact. On failure the terminal
      // shows the build error and the deploy is simply abandoned.
      this.runSteps(`build ${loaded.manifest.name}`, [buildStep], (code) => {
        if (code === 0) {
          void this.deployFromManifest(
            inv,
            devicePath,
            loaded.manifestPath,
            true
          );
        }
      });
    }
    return false;
  }

  /** The CommandStep that rebuilds the repo's manifest, if we can run one. */
  private async buildStepFor(
    loaded: LoadedManifest
  ): Promise<CommandStep | undefined> {
    const script: BuildScript | undefined = findBuildScript(loaded.repoDir);
    if (!script) {
      return undefined;
    }
    if (script.kind === "python-script") {
      const python = await locatePython();
      if (!python) {
        return undefined; // no interpreter — the warn dialog omits the button
      }
      return {
        command: python,
        args: [script.path, "build"],
        cwd: loaded.repoDir,
      };
    }
    // Makefile-only repo. On a box without make the spawn fails visibly in
    // the terminal and the deploy stops — honest and safe.
    return { command: "make", args: ["build"], cwd: loaded.repoDir };
  }

  /**
   * The pre-deploy summary: every dest with its size (secrets marked — dest
   * and byte count only, never contents), mip packages, reset. Modal like the
   * flasher's confirms, because this overwrites files on the board.
   */
  private async confirmManifestDeploy(
    loaded: LoadedManifest,
    devicePath: string
  ): Promise<boolean> {
    const manifest = loaded.manifest;
    const lines: string[] = [];

    if (manifest.mipPackages.length > 0) {
      lines.push(
        `${manifest.mipPackages.length} mip package(s): ` +
          manifest.mipPackages.join(", ")
      );
    }

    const totalBytes = manifest.files.reduce((sum, f) => sum + f.bytes, 0);
    lines.push(
      `${manifest.files.length} file(s), ${totalBytes.toLocaleString()} bytes:`
    );
    const cap = 15;
    for (const f of manifest.files.slice(0, cap)) {
      lines.push(
        `${f.dest} — ${f.bytes.toLocaleString()} B${f.secret ? " (secret)" : ""}`
      );
    }
    if (manifest.files.length > cap) {
      lines.push(`…and ${manifest.files.length - cap} more`);
    }

    lines.push(`Reset after deploy: ${manifest.resetAfter ? "yes" : "no"}`);

    const choice = await vscode.window.showInformationMessage(
      `Deploy ${manifest.name} to ${devicePath}?`,
      { modal: true, detail: lines.join("\n") },
      "Deploy"
    );
    return choice === "Deploy";
  }

  /**
   * The mpremote steps for a manifest, in the order the deployment contract
   * mandates: mip installs first (most likely failure — needs the network —
   * and failing before any file lands leaves the previous deployment intact),
   * then file copies, then reset last so the board boots into a complete
   * filesystem. The manifest's own resetAfter is authoritative — the
   * hardwareHacker.deploy.resetAfter setting applies to scan mode only,
   * otherwise a per-user setting would silently override the repo's declared
   * build contract.
   */
  private buildManifestSteps(
    inv: MpremoteInvocation,
    devicePath: string,
    loaded: LoadedManifest
  ): CommandStep[] {
    const base = [...inv.baseArgs, "connect", devicePath];
    const steps: CommandStep[] = [];

    for (const pkg of loaded.manifest.mipPackages) {
      steps.push({
        command: inv.command,
        args: [...base, "mip", "install", pkg],
      });
    }

    for (const f of loaded.manifest.files) {
      // Absolute source path: ProcessPseudoterminal spawns without a cwd, and
      // absolute paths keep the echoed command copy-pasteable from anywhere.
      const stagedAbs = path.resolve(loaded.buildDir, f.staged);
      steps.push({
        command: inv.command,
        args: [...base, "fs", "cp", stagedAbs, f.dest],
      });
    }

    if (loaded.manifest.resetAfter) {
      steps.push({ command: inv.command, args: [...base, "reset"] });
    }

    return steps;
  }

  // --- import-scan mode -----------------------------------------------------

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

  /** Launch a (possibly multi-step) command run in a terminal. */
  private runSteps(
    name: string,
    steps: CommandStep[],
    onComplete?: (code: number) => void
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
