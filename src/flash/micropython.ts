// MicroPython firmware discovery + download from micropython.org.
//
// There is no public JSON API, but each board has a download page at
//   https://micropython.org/download/<BOARD_ID>/
// whose firmware links point at
//   https://micropython.org/resources/firmware/<file>.bin
// We fetch that page, scrape the .bin links, and let the caller pick one. The
// selected image is streamed to a temp file, then handed to esptool.
//
// No third-party dependency: Node's built-in https/fs/os are enough.

import * as https from "https";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { IncomingMessage } from "http";

const MICROPYTHON_HOST = "https://micropython.org";

/** One downloadable firmware image parsed off a board's download page. */
export interface FirmwareEntry {
  /** Absolute URL to the .bin. */
  url: string;
  /** Bare file name, e.g. "ESP32_GENERIC_S3-20260406-v1.28.0.bin". */
  fileName: string;
  /** Version string, e.g. "1.28.0" or "1.29.0-preview.673.g06bcfd5b74". */
  version: string;
  /** Board variant suffix, e.g. "SPIRAM_OCT" or "FLASH_4M"; "" for standard. */
  variant: string;
  /** True for nightly/preview/unstable builds. */
  nightly: boolean;
}

/**
 * Fetch and parse the list of firmware images for a board.
 *
 * @param boardId e.g. "ESP32_GENERIC_S3"
 * @returns entries in page order (stable newest-first, then nightlies), deduped.
 */
export async function fetchFirmwareList(
  boardId: string
): Promise<FirmwareEntry[]> {
  const pageUrl = `${MICROPYTHON_HOST}/download/${encodeURIComponent(boardId)}/`;
  const html = await httpGetText(pageUrl);

  // Match both absolute and root-relative firmware links.
  const re = /(?:https:\/\/micropython\.org)?\/resources\/firmware\/([A-Za-z0-9._+-]+\.bin)/g;
  const seen = new Set<string>();
  const entries: FirmwareEntry[] = [];

  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const fileName = m[1];
    if (seen.has(fileName)) {
      continue;
    }
    seen.add(fileName);
    // Only keep images belonging to this board (the page can reference others).
    if (!fileName.startsWith(boardId)) {
      continue;
    }
    entries.push(parseFirmwareFileName(boardId, fileName));
  }

  return entries;
}

/** Break a firmware file name into version / variant / nightly. */
function parseFirmwareFileName(
  boardId: string,
  fileName: string
): FirmwareEntry {
  const base = fileName.replace(/\.bin$/, "");
  const nightly = /preview|unstable/i.test(base);

  // Version is whatever follows the last "-v".
  const vMatch = base.match(/-v(.+)$/);
  const version = vMatch ? vMatch[1] : base;

  // Variant is the text between the board id and the "-<YYYYMMDD>-v..." tail.
  let variant = "";
  const afterBoard = base.startsWith(boardId)
    ? base.slice(boardId.length).replace(/^-/, "")
    : base;
  const dateIdx = afterBoard.search(/-?\d{8}-v/);
  if (dateIdx > 0) {
    variant = afterBoard.slice(0, dateIdx).replace(/^-|-$/g, "");
  } else if (dateIdx === -1) {
    variant = afterBoard;
  }

  return {
    url: `${MICROPYTHON_HOST}/resources/firmware/${fileName}`,
    fileName,
    version,
    variant,
    nightly,
  };
}

/**
 * Download a firmware image to a fresh temp file.
 *
 * @param onProgress optional callback with bytes received / total (total may be
 *                   0 if the server sends no Content-Length).
 * @returns the path to the downloaded file (caller should delete when done).
 */
export async function downloadFirmware(
  entry: FirmwareEntry,
  onProgress?: (received: number, total: number) => void
): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-micropython-"));
  const dest = path.join(dir, entry.fileName);

  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let received = 0;

    const cleanupReject = (err: Error) => {
      file.close();
      fs.rm(dest, { force: true }, () => reject(err));
    };

    httpGetStream(entry.url)
      .then((res) => {
        const total = Number(res.headers["content-length"] ?? 0);
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          onProgress?.(received, total);
        });
        res.on("error", cleanupReject);
        file.on("error", cleanupReject);
        file.on("finish", () => file.close(() => resolve()));
        res.pipe(file);
      })
      .catch(cleanupReject);
  });

  return dest;
}

/**
 * Choose the flash offset for a board's merged .bin image.
 *
 * The original ESP32 and the -S2 keep their second-stage bootloader at 0x1000;
 * the newer SoCs that boot over USB-Serial-JTAG (-S3, -C2, -C3, -C6, -H2) place
 * it at 0x0. MicroPython ships a single merged image flashed at that offset.
 */
export function offsetForBoard(boardId: string): string {
  const id = boardId.toUpperCase();
  if (/(S3|C2|C3|C6|H2)/.test(id)) {
    return "0x0";
  }
  return "0x1000"; // classic ESP32 and -S2
}

/** Best-effort check that a board id targets an esptool-flashable ESP32 SoC. */
export function looksLikeEsp32Board(boardId: string): boolean {
  return /ESP32/i.test(boardId);
}

// --- tiny HTTPS helpers (redirect-following) ---------------------------------

/** GET a URL and resolve the response stream, following redirects. */
function httpGetStream(
  url: string,
  redirectsLeft = 5
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "hardware-hacker-vscode" } }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume(); // drain the redirect body
        if (redirectsLeft <= 0) {
          reject(new Error(`too many redirects fetching ${url}`));
          return;
        }
        const next = new URL(location, url).toString();
        httpGetStream(next, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status} fetching ${url}`));
        return;
      }
      resolve(res);
    });
    req.on("error", reject);
  });
}

/** GET a URL and buffer the whole body as UTF-8 text. */
async function httpGetText(url: string): Promise<string> {
  const res = await httpGetStream(url);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    res.on("error", reject);
  });
}
