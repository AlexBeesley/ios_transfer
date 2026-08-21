import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { TransferOptions } from '../shared/types';

/**
 * Persisted transfer preferences.
 *
 * Copying happens often enough that re-picking a destination and re-setting the
 * same options every time is friction; whatever was used last is what comes
 * back next launch.
 */

export type StoredSettings = TransferOptions;

export interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}

function boundsFile(): string {
  return path.join(app.getPath('userData'), 'window.json');
}

/** Remembers where the window was, so it reopens where it was left. */
export function loadBounds(): WindowBounds | null {
  try {
    const raw = JSON.parse(fs.readFileSync(boundsFile(), 'utf8')) as Partial<WindowBounds>;
    if (typeof raw.width !== 'number' || typeof raw.height !== 'number') return null;
    return {
      width: Math.max(960, Math.round(raw.width)),
      height: Math.max(640, Math.round(raw.height)),
      x: typeof raw.x === 'number' ? Math.round(raw.x) : undefined,
      y: typeof raw.y === 'number' ? Math.round(raw.y) : undefined,
      maximized: raw.maximized === true,
    };
  } catch {
    return null;
  }
}

export function saveBounds(value: WindowBounds): void {
  try {
    fs.mkdirSync(path.dirname(boundsFile()), { recursive: true });
    fs.writeFileSync(boundsFile(), JSON.stringify(value));
  } catch {
    /* a failed write just means the next launch uses defaults */
  }
}

/** Where this user's imports go when nothing has been chosen yet. */
const PREFERRED_DEFAULT_DESTINATION = 'D:\\media on HDD\\iphone';

function defaults(): StoredSettings {
  let destination = PREFERRED_DEFAULT_DESTINATION;
  try {
    // Fall back to Pictures if that drive is not present on this machine.
    if (!fs.existsSync(path.parse(destination).root)) {
      destination = path.join(app.getPath('pictures'), 'iPhone Import');
    }
  } catch {
    destination = path.join(app.getPath('pictures'), 'iPhone Import');
  }

  return {
    destination,
    // A flat dump by default — but see onConflict: iPhone file names repeat
    // once the camera counter wraps past IMG_9999, so without renaming a flat
    // copy would quietly discard every repeat.
    organizeByDate: false,
    includeMotion: true,
    onConflict: 'rename',
    preserveDates: true,
  };
}

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function sanitize(input: unknown): StoredSettings {
  const base = defaults();
  if (typeof input !== 'object' || input === null) return base;
  const value = input as Partial<StoredSettings>;

  return {
    destination:
      typeof value.destination === 'string' && value.destination.trim()
        ? value.destination
        : base.destination,
    organizeByDate:
      typeof value.organizeByDate === 'boolean' ? value.organizeByDate : base.organizeByDate,
    includeMotion:
      typeof value.includeMotion === 'boolean' ? value.includeMotion : base.includeMotion,
    onConflict:
      value.onConflict === 'skip' || value.onConflict === 'overwrite' || value.onConflict === 'rename'
        ? value.onConflict
        : base.onConflict,
    preserveDates:
      typeof value.preserveDates === 'boolean' ? value.preserveDates : base.preserveDates,
  };
}

export function loadSettings(): StoredSettings {
  try {
    return sanitize(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')));
  } catch {
    return defaults();
  }
}

export function saveSettings(input: unknown): StoredSettings {
  const settings = sanitize(input);
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch {
    /* a failed write just means the next launch uses defaults */
  }
  return settings;
}
