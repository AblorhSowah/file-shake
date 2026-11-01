import { K } from './constants';
import { referenceIntensity, shakeParams } from './intensity';
import { basename, toDisplayPath } from './pathUtils';
import type { EditSource, FileKey, ReferenceResult, TrackedFile, ViewRow, WorkspaceRoot } from './types';

export interface ModelInput {
  tracked: readonly TrackedFile[];
  references: ReadonlyMap<FileKey, ReferenceResult>;
  roots: readonly WorkspaceRoot[];
  toUri(key: FileKey): string;
  sensitivity: number;
  maxFiles: number;
  showWhenIdle: boolean;
}

interface Contribution {
  source: FileKey;
  actor: EditSource;
  count: number;
  active: boolean;
}

function editedRow(t: TrackedFile, i: ModelInput): ViewRow {
  const d = toDisplayPath(t.key, i.roots);
  const you = t.source === 'you';
  return {
    id: t.key,
    uri: i.toUri(t.key),
    name: d.name,
    dir: d.dir,
    folderPath: d.folderPath,
    role: 'edited',
    actor: t.source,
    source: t.source,
    phase: t.phase,
    intensity: t.intensity,
    shake: shakeParams(t.intensity),
    refCount: 0,
    badge: you ? 'typing' : 'external',
    tooltip: `${you ? 'Edited by you (typing)' : 'Changed outside the editor (external)'} · ${t.editCount} edits`,
  };
}

/** Turns tracker state + reference results into the rows shown in the view (DESIGN 7.5). */
export function buildRows(i: ModelInput): ViewRow[] {
  const maxFiles = Math.max(0, Math.floor(Number.isFinite(i.maxFiles) ? i.maxFiles : 0));
  const tracked = [...i.tracked].sort((a, b) => b.lastEditAt - a.lastEditAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const trackedKeys = new Set(tracked.map((t) => t.key));

  const edited = tracked.slice(0, maxFiles).map((t) => editedRow(t, i));

  // the cap on analysed sources applies to each user separately, so one user's burst cannot hide the other's references
  const sources = (['you', 'external'] as const).flatMap((actor) =>
    tracked
      .filter((t) => t.source === actor && (t.phase === 'active' || i.showWhenIdle))
      .slice(0, K.MAX_REFERENCE_SOURCES),
  );

  const counts = new Map<FileKey, number>();
  const contributions = new Map<FileKey, Contribution[]>();
  for (const src of sources) {
    const result = i.references.get(src.key);
    if (!result) continue;
    for (const target of result.targets) {
      if (target.key === src.key || trackedKeys.has(target.key)) continue;
      counts.set(target.key, (counts.get(target.key) ?? 0) + target.count);
      const list = contributions.get(target.key) ?? [];
      list.push({ source: src.key, actor: src.source, count: target.count, active: src.phase === 'active' });
      contributions.set(target.key, list);
    }
  }

  const referenced: ViewRow[] = [];
  for (const [key, count] of counts) {
    const contribs = contributions.get(key) ?? [];
    const active = contribs.some((c) => c.active);
    // a file referenced from both users' files is listed once, under the user whose files reference it most (ties: you)
    const byActor = { you: 0, external: 0 };
    for (const c of contribs) byActor[c.actor] += c.count;
    const actor: EditSource = byActor.external > byActor.you ? 'external' : 'you';
    const intensity = active ? referenceIntensity(count, i.sensitivity) : 0;
    const d = toDisplayPath(key, i.roots);
    const names: string[] = [];
    for (const c of contribs) {
      const n = basename(c.source);
      if (!names.includes(n)) names.push(n);
    }
    referenced.push({
      id: key,
      uri: i.toUri(key),
      name: d.name,
      dir: d.dir,
      folderPath: d.folderPath,
      role: 'referenced',
      actor,
      source: null,
      phase: active ? 'active' : 'idle',
      intensity,
      shake: shakeParams(intensity),
      refCount: count,
      badge: `×${count} ${count === 1 ? 'ref' : 'refs'}`,
      tooltip: `Referenced ${count}× by ${names.join(', ')}`,
    });
  }
  referenced.sort((a, b) => b.refCount - a.refCount || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return [...edited, ...referenced.slice(0, Math.max(0, maxFiles - edited.length))];
}
