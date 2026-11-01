import type { DecorationSpec, FileKey, ViewRow } from './types';

const PREFIX = 'File Shake: ';

/** Native Explorer decorations: only rows that are active (any phase when showWhenIdle). */
export function buildDecorations(
  rows: readonly ViewRow[],
  o: { showWhenIdle: boolean; decorateFolders: boolean },
): Map<FileKey, DecorationSpec> {
  const out = new Map<FileKey, DecorationSpec>();
  for (const row of rows) {
    if (row.phase !== 'active' && !o.showWhenIdle) continue;
    if (row.role === 'edited') {
      const you = row.source === 'you';
      out.set(row.id, {
        role: 'edited',
        // No edit count here: the decoration must only change on state transitions, not per keystroke.
        badge: you ? '●' : '◆',
        tooltip: `${PREFIX}${you ? 'Edited by you (typing)' : 'Changed outside the editor (external)'}`,
        colorId: 'fileShake.editedForeground',
        propagate: o.decorateFolders,
      });
    } else {
      out.set(row.id, {
        role: 'referenced',
        badge: row.refCount <= 9 ? String(Math.max(0, Math.floor(row.refCount))) : '9+',
        tooltip: `${PREFIX}${row.tooltip}`,
        colorId: 'fileShake.referencedForeground',
        propagate: o.decorateFolders,
      });
    }
  }
  return out;
}

function same(a: DecorationSpec, b: DecorationSpec): boolean {
  return (
    a.role === b.role &&
    a.badge === b.badge &&
    a.tooltip === b.tooltip &&
    a.colorId === b.colorId &&
    a.propagate === b.propagate
  );
}

/** Keys added, removed, or whose spec differs (sorted for determinism). */
export function changedKeys(
  prev: ReadonlyMap<FileKey, DecorationSpec>,
  next: ReadonlyMap<FileKey, DecorationSpec>,
): FileKey[] {
  const keys: FileKey[] = [];
  for (const [k, spec] of next) {
    const old = prev.get(k);
    if (!old || !same(old, spec)) keys.push(k);
  }
  for (const k of prev.keys()) if (!next.has(k)) keys.push(k);
  return keys.sort();
}
