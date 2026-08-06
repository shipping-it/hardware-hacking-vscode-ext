// Locating mpremote on the user's machine.
//
// mpremote is the official MicroPython tool for talking to a board's filesystem
// and REPL. Like esptool it ships in several shapes:
//   - `mpremote`            (console script)
//   - `python -m mpremote`  / `python3 -m mpremote` / `py -m mpremote`
//
// We probe candidates by running `<candidate> --help` and keeping the first that
// exits 0. The result is cached for the session. This mirrors esptool.ts on
// purpose so the two tools behave identically from the extension's point of view.

import * as vscode from "vscode";
import { spawn } from "child_process";

/** How to invoke mpremote: a command plus any leading args (e.g. ["-m","mpremote"]). */
export interface MpremoteInvocation {
  command: string;
  baseArgs: string[];
}

// undefined = not probed yet, null = probed and not found.
let cached: MpremoteInvocation | null | undefined;

export async function locateMpremote(): Promise<MpremoteInvocation | undefined> {
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const candidates: MpremoteInvocation[] = [];

  // A user-configured path/command wins.
  const configured = vscode.workspace
    .getConfiguration("hardwareHacker.deploy")
    .get<string>("mpremotePath", "")
    .trim();
  if (configured) {
    candidates.push({ command: configured, baseArgs: [] });
  }

  candidates.push(
    { command: "mpremote", baseArgs: [] },
    { command: "python", baseArgs: ["-m", "mpremote"] },
    { command: "python3", baseArgs: ["-m", "mpremote"] },
    { command: "py", baseArgs: ["-m", "mpremote"] }
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
function verify(inv: MpremoteInvocation): Promise<boolean> {
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
export function resetMpremoteCache(): void {
  cached = undefined;
}

/** User-facing message shown when mpremote cannot be found. */
export function mpremoteInstallHint(): string {
  return (
    "mpremote was not found. Install it with `pip install mpremote`, " +
    'or set "hardwareHacker.deploy.mpremotePath" to its full path.'
  );
}
