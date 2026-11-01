import type { ViewRow } from './types';

export interface StatusInput {
  enabled: boolean;
  rows: readonly ViewRow[];
  /** treat idle edited rows as current (default false) */
  showWhenIdle?: boolean;
}

export function buildStatus(i: StatusInput): { text: string; tooltip: string } {
  if (!i.enabled) {
    return { text: '$(circle-slash) File Shake: off', tooltip: 'File Shake is off' };
  }
  const edited = i.rows.filter((r) => r.role === 'edited');
  const referenced = i.rows.filter((r) => r.role === 'referenced');
  const tooltip = [
    `File Shake — ${edited.length} edited, ${referenced.length} referenced`,
    ...edited.map((r) => `${r.name} — ${r.badge}`),
  ].join('\n');

  const primary = edited.find((r) => r.phase === 'active') ?? (i.showWhenIdle === true ? edited[0] : undefined);
  if (!primary) return { text: '$(pulse) File Shake', tooltip };

  const label = primary.source === 'external' ? 'external' : 'typing';
  let text = `$(pulse) ${primary.name} · ${label}`;
  const r = referenced.length;
  if (r > 0) text += ` · ${r} ${r === 1 ? 'ref' : 'refs'}`;
  return { text, tooltip };
}
