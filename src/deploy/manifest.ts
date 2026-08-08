// Reading and validating a firmware repo's build-produced deployment manifest.
//
// Firmware repos that follow the deployment contract (see the reference repo's
// docs/DEPLOY-FORMAT.md, schemaVersion 1) run their own build, which stages the
// exact on-device file set under build/fs/ and emits build/deploy.manifest.json
// describing it: every file with its dest path, size, and sha256, plus any mip
// packages and whether to reset afterwards.
//
// The manifest exists because import scanning (importResolver.ts) is
// structurally blind to things a board needs at runtime: data files read via
// open() (secrets.json), packages installed on-device with mip (umqtt.robust),
// and files nothing imports but MicroPython runs anyway (boot.py). A manifest
// is therefore treated as the *complete and exact* deployment — when one is
// present the extension deploys it verbatim and never runs the import scanner.
//
// This module is pure Node (fs/path/crypto, no vscode) in the same spirit as
// importResolver.ts: all the parsing/validation logic stays unit-testable and
// UI-agnostic; the Deployer owns every prompt and message box.

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/** The manifest file name, always directly inside a `build/` directory. */
const MANIFEST_RELPATH = path.join("build", "deploy.manifest.json");

/** One file entry: copy `build/<staged>` on the host to `dest` on the board. */
export interface ManifestFile {
  /** Device path in mpremote's remote-marker form, e.g. ":main.py". */
  dest: string;
  /** Staged copy, POSIX path relative to the build/ dir, e.g. "fs/main.py". */
  staged: string;
  bytes: number;
  sha256: string;
  /** Never log/preview the contents of secret files — dest + size only. */
  secret: boolean;
}

export interface DeployManifest {
  schemaVersion: 1;
  name: string;
  /** ISO-8601 build timestamp; validated parseable at load time. */
  builtAt: string;
  /** "install" persists files + resets; "run" is reserved for future use. */
  mode: "install" | "run";
  resetAfter: boolean;
  mipPackages: string[];
  files: ManifestFile[];
}

/** A parsed manifest plus the filesystem context it was resolved from. */
export interface LoadedManifest {
  manifest: DeployManifest;
  /** Absolute path of build/deploy.manifest.json. */
  manifestPath: string;
  /** The build/ directory; `staged` paths resolve against this. */
  buildDir: string;
  /** Parent of buildDir — the firmware repo root (staleness scan scope). */
  repoDir: string;
}

/** One problem found while verifying the staged bundle against the manifest. */
export interface StagedFileIssue {
  dest: string;
  kind: "missing" | "size-mismatch" | "sha256-mismatch" | "unreadable";
  /** Human-readable sentence. Never contains file contents (files may be secret). */
  detail: string;
}

export interface StalenessResult {
  stale: boolean;
  /** Repo-relative paths newer than builtAt, capped for display. */
  newerFiles: string[];
  /** Total count (may exceed newerFiles.length). */
  newerCount: number;
}

/** How to rebuild the manifest, if the repo ships a recognizable build entry. */
export interface BuildScript {
  kind: "python-script" | "makefile";
  /** Absolute path to tools/build.py or the Makefile. */
  path: string;
}

/**
 * Thrown by loadManifest. The message is user-ready — the caller can surface
 * it directly in an error notification without rewording.
 */
export class ManifestError extends Error {}

/**
 * Walk upward from `startDir` looking for `<dir>/build/deploy.manifest.json`.
 * Nearest wins (a nested project's manifest beats a parent repo's). The walk
 * includes `stopDir` itself and never goes above it.
 */
export function findManifest(
  startDir: string,
  stopDir: string
): string | undefined {
  const stop = path.resolve(stopDir);
  let dir = path.resolve(startDir);
  // Bounded defensively: path.dirname(root) === root, so we also stop when the
  // walk stops making progress (covers a stopDir that isn't above startDir).
  for (;;) {
    const candidate = path.join(dir, MANIFEST_RELPATH);
    if (isFile(candidate)) {
      return candidate;
    }
    if (dir === stop) {
      return undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Read, parse, and shape-validate a manifest. Throws ManifestError with a
 * user-ready message on any problem; on success the returned manifest is fully
 * typed and normalized (mipPackages defaults to [], secret to false).
 *
 * Deliberately strict about `staged` paths: they must stay inside the build/
 * directory. A manifest is repo-provided data — without this check a crafted
 * manifest could make the extension copy arbitrary host files to the board.
 */
export function loadManifest(manifestPath: string): LoadedManifest {
  const abs = path.resolve(manifestPath);
  const buildDir = path.dirname(abs);
  const repoDir = path.dirname(buildDir);

  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (err) {
    throw new ManifestError(
      `Could not read ${abs}: ${errorMessage(err)}`
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ManifestError(
      `deploy.manifest.json is not valid JSON (${errorMessage(err)}). ` +
        rebuildHint()
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ManifestError(
      "deploy.manifest.json is not a JSON object. " + rebuildHint()
    );
  }
  const obj = raw as Record<string, unknown>;

  // schemaVersion gates everything else: a newer format may have moved fields,
  // so we refuse rather than guess.
  if (obj.schemaVersion !== 1) {
    throw new ManifestError(
      `deploy.manifest.json has schemaVersion ${JSON.stringify(
        obj.schemaVersion
      )}; this extension supports version 1. It may have been produced by a ` +
        "newer build format — update the extension or rebuild with a " +
        "compatible tool."
    );
  }

  const name = typeof obj.name === "string" && obj.name ? obj.name : "firmware";

  const builtAt = obj.builtAt;
  if (typeof builtAt !== "string" || Number.isNaN(Date.parse(builtAt))) {
    throw new ManifestError(
      "deploy.manifest.json has a missing or unparseable builtAt timestamp. " +
        rebuildHint()
    );
  }

  const mode = obj.mode;
  if (mode !== "install" && mode !== "run") {
    throw new ManifestError(
      `deploy.manifest.json has unknown mode ${JSON.stringify(mode)} ` +
        '(expected "install" or "run"). ' +
        rebuildHint()
    );
  }

  const mipPackages = obj.mipPackages ?? [];
  if (
    !Array.isArray(mipPackages) ||
    mipPackages.some((p) => typeof p !== "string" || p.trim() === "")
  ) {
    throw new ManifestError(
      "deploy.manifest.json has a malformed mipPackages list. " + rebuildHint()
    );
  }

  if (!Array.isArray(obj.files)) {
    throw new ManifestError(
      "deploy.manifest.json has no files array. " + rebuildHint()
    );
  }
  const files: ManifestFile[] = obj.files.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new ManifestError(
        `deploy.manifest.json files[${i}] is not an object. ` + rebuildHint()
      );
    }
    const f = entry as Record<string, unknown>;
    if (
      typeof f.dest !== "string" ||
      f.dest === "" ||
      typeof f.staged !== "string" ||
      f.staged === "" ||
      typeof f.bytes !== "number" ||
      typeof f.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/i.test(f.sha256)
    ) {
      throw new ManifestError(
        `deploy.manifest.json files[${i}] is malformed ` +
          "(needs dest, staged, bytes, sha256). " +
          rebuildHint()
      );
    }
    // The escape check: resolve and require the result to stay under build/.
    const stagedAbs = path.resolve(buildDir, f.staged);
    if (
      path.isAbsolute(f.staged) ||
      path.relative(buildDir, stagedAbs).startsWith("..")
    ) {
      throw new ManifestError(
        `deploy.manifest.json files[${i}] has staged path ` +
          `"${f.staged}" outside the build directory — refusing to deploy it.`
      );
    }
    return {
      dest: f.dest,
      staged: f.staged,
      bytes: f.bytes,
      sha256: f.sha256.toLowerCase(),
      secret: f.secret === true,
    };
  });

  return {
    manifest: {
      schemaVersion: 1,
      name,
      builtAt,
      mode,
      resetAfter: obj.resetAfter === true,
      mipPackages: mipPackages as string[],
      files,
    },
    manifestPath: abs,
    buildDir,
    repoDir,
  };
}

/**
 * Verify every staged file exists and matches the manifest's byte count and
 * sha256. Returns ALL issues rather than stopping at the first, so a single
 * abort message can show the full damage. An empty array means the bundle is
 * intact and safe to ship.
 *
 * This runs before any board contact: a mismatch means the bundle and the
 * manifest disagree (edited by hand, or a partial build) and deploying it
 * would put unverified content on the device.
 */
export function verifyStagedFiles(loaded: LoadedManifest): StagedFileIssue[] {
  const issues: StagedFileIssue[] = [];
  for (const f of loaded.manifest.files) {
    const stagedAbs = path.resolve(loaded.buildDir, f.staged);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(stagedAbs);
    } catch {
      issues.push({
        dest: f.dest,
        kind: "missing",
        detail: `${f.dest}: staged file ${f.staged} is missing`,
      });
      continue;
    }
    if (!stat.isFile()) {
      issues.push({
        dest: f.dest,
        kind: "missing",
        detail: `${f.dest}: staged path ${f.staged} is not a file`,
      });
      continue;
    }
    if (stat.size !== f.bytes) {
      issues.push({
        dest: f.dest,
        kind: "size-mismatch",
        detail:
          `${f.dest}: staged file is ${stat.size} bytes, ` +
          `manifest says ${f.bytes}`,
      });
      continue;
    }

    let digest: string;
    try {
      digest = crypto
        .createHash("sha256")
        .update(fs.readFileSync(stagedAbs))
        .digest("hex");
    } catch {
      issues.push({
        dest: f.dest,
        kind: "unreadable",
        detail: `${f.dest}: staged file ${f.staged} could not be read`,
      });
      continue;
    }
    if (digest !== f.sha256) {
      // Report only that the hash differs — never the contents (may be secret).
      issues.push({
        dest: f.dest,
        kind: "sha256-mismatch",
        detail: `${f.dest}: staged file's sha256 does not match the manifest`,
      });
    }
  }
  return issues;
}

// Directories that hold build output, tooling, or VCS state — never firmware
// source, so changes there shouldn't trigger the staleness warning.
const STALENESS_SKIP = new Set(["__pycache__", "node_modules", ".venv", "venv"]);

/** How many changed files to name in the warning before "…and N more". */
const STALENESS_LIST_CAP = 5;

/**
 * Scan the firmware repo for files modified after the manifest was built.
 * A build older than its sources means the board would get stale code — the
 * caller warns and lets the user decide (this function only reports).
 *
 * mtime vs the builtAt wall clock is an approximation (clock skew, checkouts
 * that rewrite mtimes), which is exactly why staleness is a warning and not a
 * hard failure like a hash mismatch.
 */
export function checkStaleness(loaded: LoadedManifest): StalenessResult {
  const builtAtMs = Date.parse(loaded.manifest.builtAt);
  const buildDirKey = path.normalize(loaded.buildDir);
  const newerFiles: string[] = [];
  let newerCount = 0;

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — not evidence of staleness
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip build output (comparing it to itself is meaningless), VCS/tool
        // state, and dot-directories generally.
        if (
          path.normalize(full) === buildDirKey ||
          entry.name.startsWith(".") ||
          STALENESS_SKIP.has(entry.name)
        ) {
          continue;
        }
        walk(full);
      } else if (entry.isFile()) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.mtimeMs > builtAtMs) {
          newerCount++;
          if (newerFiles.length < STALENESS_LIST_CAP) {
            newerFiles.push(
              path.relative(loaded.repoDir, full).split(path.sep).join("/")
            );
          }
        }
      }
    }
  };

  walk(loaded.repoDir);
  return { stale: newerCount > 0, newerFiles, newerCount };
}

/**
 * Locate the repo's build entry point, if it ships one. tools/build.py is
 * preferred over a Makefile because it runs anywhere Python does (Windows
 * boxes rarely have make), matching the deployment contract's own preference.
 */
export function findBuildScript(repoDir: string): BuildScript | undefined {
  const buildPy = path.join(repoDir, "tools", "build.py");
  if (isFile(buildPy)) {
    return { kind: "python-script", path: buildPy };
  }
  const makefile = path.join(repoDir, "Makefile");
  if (isFile(makefile)) {
    return { kind: "makefile", path: makefile };
  }
  return undefined;
}

/** The standard remedy for a manifest/bundle problem. */
function rebuildHint(): string {
  return "Re-run the firmware repo's build (e.g. `python tools/build.py build`).";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
