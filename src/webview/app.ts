import { K } from '../core/constants';
import { round3 } from '../core/intensity';
import { parseHostMessage } from '../core/protocol';
import type { WebviewMessage } from '../core/protocol';
import { buildTree } from '../core/tree';
import type { FolderNode, TreeNode } from '../core/tree';
import type { Snapshot, ViewRow } from '../core/types';

export interface PersistedState {
  /** folder ids the user collapsed */
  collapsed: string[];
}

export interface HostApi {
  postMessage(m: WebviewMessage): void;
  getState(): PersistedState | undefined;
  setState(s: PersistedState): void;
}

export interface AppEnv {
  reducedMotion(): boolean;
  onReducedMotionChange(cb: () => void): () => void;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export interface App {
  handleMessage(raw: unknown): void;
  dispose(): void;
  readonly lastSeq: number;
}

const EMPTY_TEXT = 'No files are being edited. Type in a file, or let a tool change one, and it will show up here.';
const DISABLED_TEXT = "File Shake is turned off. Use the toggle in this view's title bar to turn it back on.";

function defaultEnv(doc: Document): AppEnv {
  const win = doc.defaultView;
  const query = (): MediaQueryList | undefined =>
    win && typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : undefined;
  return {
    reducedMotion: () => query()?.matches === true,
    onReducedMotionChange: (cb) => {
      const mql = query();
      if (!mql) return () => undefined;
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    setTimeout: (fn, ms) => (win ? win.setTimeout(fn, ms) : 0),
    clearTimeout: (id) => win?.clearTimeout(id),
  };
}

function isElement(x: EventTarget | null): x is Element {
  return x !== null && 'closest' in x && typeof x.closest === 'function';
}

interface RowEl {
  el: HTMLElement;
  name: HTMLElement;
  dir: HTMLElement;
  badge: HTMLElement;
  meter: HTMLElement;
  level: HTMLElement;
  /** cached values so unchanged rows cause no DOM writes */
  last: Map<string, string>;
  leaveTimer: number | undefined;
}

interface FolderEl {
  el: HTMLLIElement;
  toggle: HTMLButtonElement;
  label: HTMLElement;
  count: HTMLElement;
  children: HTMLUListElement;
  last: Map<string, string>;
}

function cleanState(raw: PersistedState | undefined): Set<string> {
  const out = new Set<string>();
  const list: unknown = raw?.collapsed;
  if (Array.isArray(list)) for (const v of list) if (typeof v === 'string') out.add(v);
  return out;
}

/** Mounts the File Shake tree into `root`. Has no side effects at import time. */
export function mountApp(root: HTMLElement, host: HostApi, envOverride: Partial<AppEnv> = {}): App {
  const doc = root.ownerDocument;
  const env: AppEnv = { ...defaultEnv(doc), ...envOverride };

  const collapsed = cleanState(host.getState());
  const rowEls = new Map<string, RowEl>();
  const folderEls = new Map<string, FolderEl>();
  let knownIds = new Set<string>();
  let baselineDone = false;
  let lastSeq = -1;
  let last: Snapshot | undefined;
  let emptyEl: HTMLElement | undefined;
  let currentFolders: ReadonlySet<string> = new Set();
  let disposed = false;

  const tree = doc.createElement('ul');
  tree.className = 'fs-tree';
  tree.setAttribute('role', 'tree');
  root.setAttribute('data-motion', env.reducedMotion() ? 'off' : 'on');
  root.setAttribute('data-state', 'empty');
  root.appendChild(tree);

  // ----- helpers ---------------------------------------------------------------

  const setIfChanged = (cache: Map<string, string>, key: string, value: string, apply: () => void): void => {
    if (cache.get(key) === value) return;
    cache.set(key, value);
    apply();
  };

  const motionOn = (snapshot: Snapshot): boolean => snapshot.animate && !env.reducedMotion();

  const showEmpty = (text: string): void => {
    if (!emptyEl) {
      emptyEl = doc.createElement('div');
      emptyEl.className = 'fs-empty';
      root.insertBefore(emptyEl, tree);
    }
    emptyEl.textContent = text;
  };

  const hideEmpty = (): void => {
    emptyEl?.remove();
    emptyEl = undefined;
  };

  const persist = (): void => {
    host.setState({ collapsed: [...collapsed].sort() });
  };

  // ----- rows ------------------------------------------------------------------

  const createRow = (row: ViewRow): RowEl => {
    const el = doc.createElement('li');
    el.setAttribute('role', 'treeitem');
    el.setAttribute('tabindex', '0');
    const name = doc.createElement('span');
    name.className = 'fs-name';
    const dir = doc.createElement('span');
    dir.className = 'fs-dir';
    const badge = doc.createElement('span');
    badge.className = 'fs-badge';
    const meter = doc.createElement('span');
    meter.className = 'fs-meter';
    const level = doc.createElement('i');
    meter.appendChild(level);
    el.append(name, dir, badge, meter);
    el.setAttribute('data-id', row.id);
    return { el, name, dir, badge, meter, level, last: new Map(), leaveTimer: undefined };
  };

  const updateRow = (r: RowEl, row: ViewRow, motion: boolean): void => {
    const c = r.last;
    setIfChanged(c, 'role', row.role, () => r.el.setAttribute('data-role', row.role));
    // className is rebuilt every time so the state classes below stay authoritative
    const classes = ['fs-row', `fs-row--${row.role}`];
    const shaking = motion && row.phase === 'active' && row.intensity > 0;
    if (shaking) classes.push('is-shaking');
    if (row.phase === 'idle') classes.push('is-idle');
    if (r.leaveTimer !== undefined) classes.push('is-leaving');
    const cls = classes.join(' ');
    if (r.el.className !== cls) r.el.className = cls;

    setIfChanged(c, 'phase', row.phase, () => r.el.setAttribute('data-phase', row.phase));
    setIfChanged(c, 'source', row.source ?? '', () => {
      if (row.source === null) r.el.removeAttribute('data-source');
      else r.el.setAttribute('data-source', row.source);
    });
    setIfChanged(c, 'label', `${row.name}, ${row.badge}`, () => r.el.setAttribute('aria-label', `${row.name}, ${row.badge}`));
    setIfChanged(c, 'tooltip', row.tooltip, () => r.el.setAttribute('title', row.tooltip));
    setIfChanged(c, 'name', row.name, () => {
      r.name.textContent = row.name;
    });
    setIfChanged(c, 'dir', row.dir, () => {
      r.dir.textContent = row.dir;
    });
    setIfChanged(c, 'badge', row.badge, () => {
      r.badge.textContent = row.badge;
    });
    setIfChanged(c, 'amp', `${row.shake.amp}px`, () => r.el.style.setProperty('--fs-amp', `${row.shake.amp}px`));
    setIfChanged(c, 'dur', `${row.shake.dur}ms`, () => r.el.style.setProperty('--fs-dur', `${row.shake.dur}ms`));
    setIfChanged(c, 'rot', `${row.shake.rot}deg`, () => r.el.style.setProperty('--fs-rot', `${row.shake.rot}deg`));
    setIfChanged(c, 'level', String(round3(row.intensity)), () =>
      r.el.style.setProperty('--fs-level', String(round3(row.intensity))),
    );
  };

  // ----- folders ---------------------------------------------------------------

  const createFolder = (node: FolderNode): FolderEl => {
    const el = doc.createElement('li');
    el.className = 'fs-folder';
    el.setAttribute('role', 'treeitem');
    el.setAttribute('data-folder-id', node.id);
    const toggle = doc.createElement('button');
    toggle.className = 'fs-folder-toggle';
    toggle.setAttribute('type', 'button');
    const chevron = doc.createElement('span');
    chevron.className = 'fs-chevron';
    const label = doc.createElement('span');
    label.className = 'fs-folder-label';
    const count = doc.createElement('span');
    count.className = 'fs-folder-count';
    toggle.append(chevron, label, count);
    const children = doc.createElement('ul');
    children.className = 'fs-children';
    children.setAttribute('role', 'group');
    el.append(toggle, children);
    return { el, toggle, label, count, children, last: new Map() };
  };

  const updateFolder = (f: FolderEl, node: FolderNode): void => {
    const c = f.last;
    const isCollapsed = collapsed.has(node.id);
    setIfChanged(c, 'expanded', String(!isCollapsed), () => {
      f.el.setAttribute('aria-expanded', String(!isCollapsed));
      f.children.hidden = isCollapsed;
    });
    setIfChanged(c, 'label', node.label, () => {
      f.label.textContent = node.label;
    });
    setIfChanged(c, 'count', String(node.fileCount), () => {
      f.count.textContent = String(node.fileCount);
    });
    setIfChanged(c, 'top', node.topRole ?? '', () => {
      if (node.topRole === null) f.el.removeAttribute('data-top-role');
      else f.el.setAttribute('data-top-role', node.topRole);
    });
    setIfChanged(c, 'active', String(node.hasActive), () => {
      f.el.classList.toggle('has-active', node.hasActive);
    });
  };

  /**
   * Puts `wanted` into `parent` in order, moving a node only when it is out of place (moving a node
   * restarts its CSS animation). Unwanted siblings (leaving rows, folders waiting to be pruned) are skipped.
   */
  const placeChildren = (parent: HTMLElement, wanted: HTMLElement[]): void => {
    const wantedSet = new Set<Element>(wanted);
    let ref: Element | null = parent.firstElementChild;
    for (const el of wanted) {
      while (ref && !wantedSet.has(ref)) ref = ref.nextElementSibling;
      if (ref === el) ref = ref.nextElementSibling;
      else parent.insertBefore(el, ref);
    }
  };

  const reconcile = (parent: HTMLElement, nodes: readonly TreeNode[], snapshot: Snapshot, seen: Set<string>, seenFolders: Set<string>): void => {
    const wanted: HTMLElement[] = [];
    const motion = motionOn(snapshot);
    for (const node of nodes) {
      if (node.kind === 'folder') {
        seenFolders.add(node.id);
        let f = folderEls.get(node.id);
        if (!f) {
          f = createFolder(node);
          folderEls.set(node.id, f);
        }
        updateFolder(f, node);
        reconcile(f.children, node.children, snapshot, seen, seenFolders);
        wanted.push(f.el);
      } else {
        seen.add(node.id);
        let r = rowEls.get(node.id);
        if (!r) {
          r = createRow(node.row);
          rowEls.set(node.id, r);
        } else if (r.leaveTimer !== undefined) {
          env.clearTimeout(r.leaveTimer);
          r.leaveTimer = undefined;
        }
        updateRow(r, node.row, motion);
        wanted.push(r.el);
      }
    }
    placeChildren(parent, wanted);
  };

  const pruneFolders = (seenFolders: ReadonlySet<string>): void => {
    // deepest first is not required: a folder is kept while any row element lives below it
    for (const [id, f] of [...folderEls]) {
      if (seenFolders.has(id)) continue;
      if (f.el.querySelector('.fs-row') === null) {
        f.el.remove();
        folderEls.delete(id);
      }
    }
  };

  const syncState = (): void => {
    if (rowEls.size === 0 && last?.enabled !== false) {
      root.setAttribute('data-state', 'empty');
      showEmpty(EMPTY_TEXT);
    } else if (last?.enabled === false) {
      root.setAttribute('data-state', 'disabled');
      showEmpty(DISABLED_TEXT);
    } else {
      root.setAttribute('data-state', 'rows');
      hideEmpty();
    }
  };

  const removeRowNow = (id: string): void => {
    const r = rowEls.get(id);
    if (!r) return;
    if (r.leaveTimer !== undefined) env.clearTimeout(r.leaveTimer);
    r.el.remove();
    rowEls.delete(id);
  };

  const startLeaving = (id: string, r: RowEl): void => {
    if (r.leaveTimer !== undefined) return;
    r.el.classList.add('is-leaving');
    r.leaveTimer = env.setTimeout(() => {
      r.leaveTimer = undefined;
      if (disposed) return;
      removeRowNow(id);
      pruneFolders(currentFolders);
      syncState();
    }, K.LEAVE_MS);
  };

  const applyColors = (snapshot: Snapshot): void => {
    if (snapshot.colors.edited !== '') root.style.setProperty('--fs-edited-override', snapshot.colors.edited);
    else root.style.removeProperty('--fs-edited-override');
    if (snapshot.colors.referenced !== '') root.style.setProperty('--fs-referenced-override', snapshot.colors.referenced);
    else root.style.removeProperty('--fs-referenced-override');
  };

  const render = (snapshot: Snapshot): void => {
    root.setAttribute('data-motion', motionOn(snapshot) ? 'on' : 'off');
    applyColors(snapshot);

    if (!snapshot.enabled) {
      for (const id of [...rowEls.keys()]) removeRowNow(id);
      for (const f of folderEls.values()) f.el.remove();
      folderEls.clear();
      knownIds = new Set();
      baselineDone = true;
      currentFolders = new Set();
      syncState();
      return;
    }

    const nodes = buildTree(snapshot.rows);
    const seen = new Set<string>();
    const seenFolders = new Set<string>();

    // auto-expand folders that gained a file we have not seen before
    if (baselineDone) {
      const ancestors = (list: readonly TreeNode[], trail: string[]): void => {
        for (const n of list) {
          if (n.kind === 'folder') {
            ancestors(n.children, [...trail, n.id]);
          } else if (!knownIds.has(n.id)) {
            for (const folderId of trail) collapsed.delete(folderId);
          }
        }
      };
      const before = collapsed.size;
      ancestors(nodes, []);
      if (collapsed.size !== before) persist();
    }
    baselineDone = true;

    reconcile(tree, nodes, snapshot, seen, seenFolders);

    for (const [id, r] of rowEls) if (!seen.has(id)) startLeaving(id, r);
    currentFolders = seenFolders;
    pruneFolders(seenFolders);
    knownIds = seen;
    syncState();
  };

  // ----- events ----------------------------------------------------------------

  const openRow = (el: Element): void => {
    const row = el.closest('.fs-row');
    if (!row || row.classList.contains('is-leaving')) return;
    const id = row.getAttribute('data-id');
    if (id !== null) host.postMessage({ type: 'open', id });
  };

  const toggleFolder = (btn: Element): void => {
    const li = btn.closest('.fs-folder');
    const id = li?.getAttribute('data-folder-id');
    if (!li || id === null || id === undefined) return;
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    const f = folderEls.get(id);
    if (f) {
      const isCollapsed = collapsed.has(id);
      f.last.set('expanded', String(!isCollapsed));
      f.el.setAttribute('aria-expanded', String(!isCollapsed));
      f.children.hidden = isCollapsed;
    }
    persist();
  };

  const onClick = (e: Event): void => {
    const t = e.target;
    if (!isElement(t)) return;
    const toggle = t.closest('.fs-folder-toggle');
    if (toggle) {
      toggleFolder(toggle);
      return;
    }
    openRow(t);
  };

  const onKeyDown = (e: Event): void => {
    const t = e.target;
    if (!isElement(t) || !('key' in e) || typeof e.key !== 'string') return;
    const toggle = t.closest('.fs-folder-toggle');
    if (toggle) {
      // Space is left to the browser: a <button> turns it into a click
      if (e.key === 'Enter') {
        e.preventDefault();
        toggleFolder(toggle);
      }
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      const row = t.closest('.fs-row');
      if (row) {
        e.preventDefault();
        openRow(row);
      }
    }
  };

  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeyDown);

  const stopMotionWatch = env.onReducedMotionChange(() => {
    if (disposed || !last) return;
    const motion = motionOn(last);
    root.setAttribute('data-motion', motion ? 'on' : 'off');
    for (const row of last.rows) {
      const r = rowEls.get(row.id);
      if (r) updateRow(r, row, motion);
    }
  });

  syncState();
  host.postMessage({ type: 'ready' });

  return {
    handleMessage(raw: unknown): void {
      if (disposed) return;
      const msg = parseHostMessage(raw);
      if (!msg) return;
      const snapshot = msg.snapshot;
      if (snapshot.seq < lastSeq) return;
      lastSeq = snapshot.seq;
      last = snapshot;
      render(snapshot);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeyDown);
      stopMotionWatch();
      for (const r of rowEls.values()) {
        if (r.leaveTimer !== undefined) env.clearTimeout(r.leaveTimer);
        r.leaveTimer = undefined;
      }
    },
    get lastSeq(): number {
      return lastSeq;
    },
  };
}
