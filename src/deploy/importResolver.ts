// Static import scanner: given an entry .py file, work out which *local* modules
// it needs so they can be shipped to the device alongside it.
//
// We read the file, match its `import` / `from ... import ...` statements with
// line regexes, resolve each to a local .py (or package __init__.py) under a
// source root, and recurse into whatever we find. Modules that don't resolve
// locally are assumed to be builtin/frozen/mip-installed (already on the board)
// and are reported back so the caller can tell the user what was skipped.
//
// This is deliberately shallow, in the same candid spirit as micropython.ts:
//   - no dynamic imports (`__import__`, importlib), no conditional-branch logic;
//   - comment/string handling is naive (we cut at the first `#`);
//   - multi-line parenthesised `from x import (...)` only sees names on the
//     first line.
// It handles the common case — a project folder of local modules — well, and
// degrades safely (a missed dependency simply isn't copied; nothing crashes).

import * as fs from "fs";
import * as path from "path";

/** A file to copy, with the path it should live at on the device (POSIX). */
export interface DeployFile {
  /** Absolute path on the host. */
  localPath: string;
  /** Path relative to the source root, POSIX-style (e.g. "sensors/bme280.py"). */
  devicePath: string;
}

export interface Deployment {
  files: DeployFile[];
  /** Module tokens that couldn't be resolved locally (assumed builtin/frozen). */
  unresolved: string[];
}

/**
 * Resolve the transitive set of local files reachable from `entryFile`.
 *
 * @param entryFile the .py file to start from.
 * @param sourceRoot base directory absolute imports resolve against and device
 *                   paths are computed relative to.
 */
export function resolveDeployment(
  entryFile: string,
  sourceRoot: string
): Deployment {
  const root = path.resolve(sourceRoot);
  const entry = path.resolve(entryFile);

  const files: DeployFile[] = [];
  const unresolved = new Set<string>();
  const visited = new Set<string>();
  const queue: string[] = [];

  const enqueue = (abs: string): void => {
    const key = path.normalize(abs);
    if (visited.has(key)) {
      return;
    }
    visited.add(key);
    files.push({ localPath: key, devicePath: toDevicePath(root, key) });
    queue.push(key);
  };

  enqueue(entry);

  while (queue.length > 0) {
    const file = queue.shift() as string;
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue; // unreadable file — skip, don't fail the whole deploy
    }
    const fileDir = path.dirname(file);

    for (const stmt of parseImports(text)) {
      if (stmt.kind === "import") {
        // `import a.b, c` — always absolute, resolved against the source root.
        for (const module of stmt.modules) {
          const resolved = resolveModuleFiles(root, module.split("."));
          if (resolved) {
            resolved.forEach(enqueue);
          } else {
            unresolved.add(module);
          }
        }
        continue;
      }

      // `from [dots][module] import names`
      const startDir = stmt.dots > 0 ? climb(fileDir, stmt.dots) : root;
      const modParts = stmt.module ? stmt.module.split(".") : [];
      let found = false;

      if (modParts.length > 0) {
        const resolved = resolveModuleFiles(startDir, modParts);
        if (resolved) {
          resolved.forEach(enqueue);
          found = true;
        }
      }
      // A name may itself be a submodule: `from pkg import submod`.
      for (const name of stmt.names) {
        const resolved = resolveModuleFiles(startDir, [...modParts, name]);
        if (resolved) {
          resolved.forEach(enqueue);
          found = true;
        }
      }

      if (!found) {
        const label = ".".repeat(stmt.dots) + stmt.module;
        unresolved.add(label || stmt.names.join(", "));
      }
    }
  }

  return { files, unresolved: [...unresolved] };
}

// --- statement parsing -------------------------------------------------------

type ImportStatement =
  | { kind: "import"; modules: string[] }
  | { kind: "from"; dots: number; module: string; names: string[] };

const FROM_RE = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+)$/;
const IMPORT_RE = /^\s*import\s+(.+)$/;

function parseImports(text: string): ImportStatement[] {
  const out: ImportStatement[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    let m = FROM_RE.exec(line);
    if (m) {
      out.push({
        kind: "from",
        dots: m[1].length,
        module: m[2],
        names: parseNames(m[3]),
      });
      continue;
    }
    m = IMPORT_RE.exec(line);
    if (m) {
      const modules = m[1]
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter((s) => /^[\w.]+$/.test(s));
      if (modules.length > 0) {
        out.push({ kind: "import", modules });
      }
    }
  }
  return out;
}

/** Split the imported-names clause: `(a, b as c, *)` -> ["a", "b"]. */
function parseNames(clause: string): string[] {
  return clause
    .trim()
    .replace(/^\(/, "")
    .replace(/\)\s*$/, "")
    .split(",")
    .map((x) => x.trim().split(/\s+as\s+/)[0].trim())
    .filter((x) => /^\w+$/.test(x)); // drops "*" and trailing empties
}

/** Cut a line at its first `#`. Naive but adequate for import lines. */
function stripComment(line: string): string {
  const i = line.indexOf("#");
  return i === -1 ? line : line.slice(0, i);
}

// --- module resolution -------------------------------------------------------

/**
 * Resolve dotted `parts` against `baseDir` to a list of local files to ship:
 * the leaf module (`a/b/c.py` or `a/b/c/__init__.py`) plus any `__init__.py`
 * that exists for the intermediate packages. Returns null if the leaf isn't a
 * local file.
 */
function resolveModuleFiles(baseDir: string, parts: string[]): string[] | null {
  if (parts.length === 0) {
    return null;
  }
  const files: string[] = [];

  // Intermediate package __init__.py files (best effort — only if present).
  let dir = baseDir;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = path.join(dir, parts[i]);
    const init = path.join(dir, "__init__.py");
    if (isFile(init)) {
      files.push(init);
    }
  }

  const leaf = path.join(baseDir, ...parts);
  const asModule = leaf + ".py";
  const asPackage = path.join(leaf, "__init__.py");
  if (isFile(asModule)) {
    files.push(asModule);
    return files;
  }
  if (isFile(asPackage)) {
    files.push(asPackage);
    return files;
  }
  return null;
}

/** Walk up `dots - 1` directory levels (dots=1 is the current package). */
function climb(dir: string, dots: number): string {
  let d = dir;
  for (let i = 1; i < dots; i++) {
    d = path.dirname(d);
  }
  return d;
}

function toDevicePath(root: string, absFile: string): string {
  let rel = path.relative(root, absFile);
  if (rel.startsWith("..")) {
    // Outside the source root (e.g. a relative import above it) — flatten to
    // the bare file name at the device root rather than emit an invalid path.
    rel = path.basename(absFile);
  }
  return rel.split(path.sep).join("/");
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
