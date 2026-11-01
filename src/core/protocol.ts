import { COLOR_PATTERN } from './constants';
import type { EditSource, Phase, Role, ShakeParams, Snapshot, ViewRow } from './types';

export { buildWebviewHtml, makeNonce } from './webviewHtml';

export const PROTOCOL_VERSION = 1;

export type HostMessage = { type: 'snapshot'; snapshot: Snapshot };
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'open'; id: string }
  | { type: 'error'; message: string };

const MAX_ROWS = 500;
const MAX_STRING = 10_000;
const MAX_ERROR = 500;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length <= MAX_STRING ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function color(v: unknown): string | undefined {
  return typeof v === 'string' && (v === '' || COLOR_PATTERN.test(v)) ? v : undefined;
}

function parseShake(v: unknown): ShakeParams | undefined {
  if (!isObject(v)) return undefined;
  const amp = num(v['amp']);
  const dur = num(v['dur']);
  const rot = num(v['rot']);
  if (amp === undefined || dur === undefined || rot === undefined) return undefined;
  return { amp, dur, rot };
}

function parseRow(v: unknown): ViewRow | undefined {
  if (!isObject(v)) return undefined;
  const id = str(v['id']);
  const uri = str(v['uri']);
  const name = str(v['name']);
  const dir = str(v['dir']);
  const badge = str(v['badge']);
  const tooltip = str(v['tooltip']);
  const intensity = num(v['intensity']);
  const refCount = num(v['refCount']);
  const shake = parseShake(v['shake']);
  const role = v['role'];
  const phase = v['phase'];
  const source = v['source'];
  const folderPath = v['folderPath'];
  if (
    id === undefined ||
    uri === undefined ||
    name === undefined ||
    dir === undefined ||
    badge === undefined ||
    tooltip === undefined ||
    intensity === undefined ||
    refCount === undefined ||
    shake === undefined ||
    intensity < 0 ||
    intensity > 1
  ) {
    return undefined;
  }
  if (role !== 'edited' && role !== 'referenced') return undefined;
  if (phase !== 'active' && phase !== 'idle') return undefined;
  if (source !== 'you' && source !== 'external' && source !== null) return undefined;
  if (!Array.isArray(folderPath) || folderPath.length > 256) return undefined;
  const folders: string[] = [];
  for (const seg of folderPath) {
    const s = str(seg);
    if (s === undefined) return undefined;
    folders.push(s);
  }
  return {
    id,
    uri,
    name,
    dir,
    folderPath: folders,
    role: role as Role,
    source: source as EditSource | null,
    phase: phase as Phase,
    intensity,
    shake,
    refCount,
    badge,
    tooltip,
  };
}

/** Deep-validates a message from the extension host. Returns a fresh object, or null when malformed. Never throws. */
export function parseHostMessage(raw: unknown): HostMessage | null {
  try {
    if (!isObject(raw) || raw['type'] !== 'snapshot') return null;
    const s = raw['snapshot'];
    if (!isObject(s)) return null;
    if (s['v'] !== PROTOCOL_VERSION) return null;
    const seq = num(s['seq']);
    if (seq === undefined) return null;
    if (typeof s['enabled'] !== 'boolean' || typeof s['animate'] !== 'boolean') return null;
    const colors = s['colors'];
    if (!isObject(colors)) return null;
    const edited = color(colors['edited']);
    const referenced = color(colors['referenced']);
    if (edited === undefined || referenced === undefined) return null;
    const rawRows = s['rows'];
    if (!Array.isArray(rawRows) || rawRows.length > MAX_ROWS) return null;
    const rows: ViewRow[] = [];
    for (const r of rawRows) {
      const row = parseRow(r);
      if (!row) return null;
      rows.push(row);
    }
    return {
      type: 'snapshot',
      snapshot: {
        v: 1,
        seq,
        enabled: s['enabled'],
        animate: s['animate'],
        colors: { edited, referenced },
        rows,
      },
    };
  } catch {
    return null;
  }
}

/** Validates a message from the webview. `error` messages are truncated to 500 chars. Never throws. */
export function parseWebviewMessage(raw: unknown): WebviewMessage | null {
  try {
    if (!isObject(raw)) return null;
    switch (raw['type']) {
      case 'ready':
        return { type: 'ready' };
      case 'open': {
        const id = str(raw['id']);
        return id === undefined ? null : { type: 'open', id };
      }
      case 'error': {
        const m = raw['message'];
        return typeof m === 'string' ? { type: 'error', message: m.slice(0, MAX_ERROR) } : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
