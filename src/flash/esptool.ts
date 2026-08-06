// Locating esptool on the user's machine.
//
// esptool ships in several shapes depending on how it was installed:
//   - `esptool`         (console script, esptool >= 4.6)
//   - `esptool.py`      (classic script name)
//   - `python -m esptool` / `python3 -m esptool` / `py -m esptool`
//
// We probe candidates by running `<candidate> --help` and keeping the first
// that exits 0. (`--help` works across esptool v4 and the Click-based v5 CLI;
// v5 dropped the `--version` flag in favor of a `version` subcommand, so probing
// with `--version` would wrongly report esptool as missing.) The result is
// cached for the session.

import * as vscode from "vscode";
import { spawn } from "child_process";

/** How to invoke esptool: a command plus any leading args (e.g. ["-m","esptool"]). */
export interface EsptoolInvocation {
  command: string;
  baseArgs: string[];
}

// undefined = not probed yet, null = probed and not found.
let cached: EsptoolInvocation | null | undefined;

export async function locateEsptool(): Promise<EsptoolInvocation | undefined> {
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const candidates: EsptoolInvocation[] = [];

  // A user-configured path/command wins.
  const configured = vscode.workspace
    .getConfiguration("hardwareHacker.flash")
    .get<string>("esptoolPath", "")
    .trim();
  if (configured) {
    candidates.push({ command: configured, baseArgs: [] });
  }

  candidates.push(
    { command: "esptool", baseArgs: [] },
    { command: "esptool.py", baseArgs: [] },
    { command: "python", baseArgs: ["-m", "esptool"] },
    { command: "python3", baseArgs: ["-m", "esptool"] },
    { command: "py", baseArgs: ["-m", "esptool"] }
  );

  for (const candidate of candidates) {
    if (await verify(candidate)) {
      cached = candidate;
      return candidate;
    }
  }

  cached = null;
  return undefined;
}

/** Run `<candidate> --help` and resolve true iff it exits 0 within the timeout. */
function verify(inv: EsptoolInvocation): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };

    let child;
    try {
      child = spawn(inv.command, [...inv.baseArgs, "--help"], {
        windowsHide: true,
      });
    } catch {
      finish(false);
      return;
    }

    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(false);
    }, 5000);
    child.on("close", () => clearTimeout(timer));
  });
}

/** Reset the cached result (e.g. after the user changes the configured path). */
export function resetEsptoolCache(): void {
  cached = undefined;
}

/** User-facing message shown when esptool cannot be found. */
export function esptoolInstallHint(): string {
  return (
    "esptool was not found. Install it with `pip install esptool`, " +
    'or set "hardwareHacker.flash.esptoolPath" to its full path.'
  );
}
