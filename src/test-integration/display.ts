import {execFileSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';

type Point = {x: number; y: number};
type Rect = Point & {width: number; height: number};

const jxa = (script: string): string =>
  execFileSync('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit');${script}`], {
    encoding: 'utf8'
  }).trim();

/**
 * The named display's frame in global coordinates (top-left origin, y down), the cursor and the
 * frontmost app.
 */
function find(name: string): {display: Rect; cursor: Point; front: number} {
  const found = jxa(`
    const screens = $.NSScreen.screens.js;
    const s = screens.find((s) => s.localizedName.js === ${JSON.stringify(name)});
    const f = s && s.frame;
    const top = screens[0].frame.size.height;
    const c = $.CGEventGetLocation($.CGEventCreate(null));
    const front = $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    JSON.stringify(f ? {
      display: {x: f.origin.x, y: top - f.origin.y - f.size.height, width: f.size.width, height: f.size.height},
      cursor: {x: c.x, y: c.y}, front
    } : null)`);
  const parsed = JSON.parse(found) as {display: Rect; cursor: Point; front: number} | null;
  if (!parsed) throw new Error(`No display is named ${name} (DYNOTABLE_TEST_DISPLAY).`);
  return parsed;
}

const warp = ({x, y}: Point) => jxa(`$.CGWarpMouseCursorPosition({x: ${x}, y: ${y}})`);

/** The bounds of the on-screen windows of the processes whose command line holds `marker`. */
function windowsOf(marker: string): Rect[] {
  let pids: number[];
  try {
    pids = execFileSync('pgrep', ['-f', marker], {encoding: 'utf8'}).split('\n').map(Number);
  } catch {
    return [];
  }
  return windowsOfPids(pids);
}

export function windowsOfPids(pids: number[]): Rect[] {
  const bounds = jxa(`
    const pids = ${JSON.stringify(pids.filter(Boolean))};
    const list = ObjC.deepUnwrap(ObjC.castRefToObject(
      $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0)));
    JSON.stringify(list.filter((w) => pids.includes(w.kCGWindowOwnerPID) && w.kCGWindowLayer === 0)
      .map((w) => ({x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y,
        width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height})))`);
  return JSON.parse(bounds) as Rect[];
}

const inside = (w: Rect, d: Rect) =>
  w.x >= d.x && w.y >= d.y && w.x + w.width <= d.x + d.width && w.y + w.height <= d.y + d.height;

/**
 * Launches VS Code with its window on the macOS display `name`. VS Code ignores stored window state
 * in an extension test window and opens it on the display under the cursor, so the cursor is put
 * back at the centre of that display until the window is there (a hand on the mouse can move it
 * away), then returns. `marker` is a string unique to this launch's command line.
 */
export async function onDisplay<T>(
  name: string,
  marker: string,
  launch: () => Promise<T>
): Promise<T> {
  if (process.platform !== 'darwin') throw new Error('DYNOTABLE_TEST_DISPLAY needs macOS.');
  const {display, cursor, front} = find(name);
  const centre = {x: display.x + display.width / 2, y: display.y + display.height / 2};
  warp(centre);
  let settled = false;
  const launched = launch().finally(() => (settled = true));
  let windows: Rect[] = [];
  try {
    for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
      windows = windowsOf(marker);
      if (windows.length > 0 || settled) break;
      warp(centre);
      await sleep(50);
    }
  } finally {
    warp(cursor);
    // The new window takes the focus; the app that had it gets it back.
    jxa(`const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${front});
      if (!app.isNil()) app.activateWithOptions(0);`);
  }
  if (windows.length === 0) {
    await launched;
    throw new Error('No VS Code window was seen, so its display is unknown.');
  }
  const outside = windows.filter((w) => !inside(w, display));
  if (outside.length > 0) {
    throw new Error(`A VS Code window opened outside ${name}: ${JSON.stringify(outside)}`);
  }
  return launched;
}
