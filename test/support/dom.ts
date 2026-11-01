import { JSDOM } from 'jsdom';
import { mountApp } from '../../src/webview/app';
import type { App, AppEnv, HostApi, PersistedState } from '../../src/webview/app';
import type { WebviewMessage } from '../../src/core/protocol';
import type { Snapshot, ViewRow } from './types';
import { snapshotOf } from './builders';

/** Deterministic stand-in for the browser environment: reduced-motion flag and a manual timer queue. */
export class FakeEnv {
  reduced = false;
  private nextId = 1;
  private readonly listeners = new Set<() => void>();
  readonly timers = new Map<number, { fn: () => void; ms: number }>();
  readonly scheduled: Array<{ id: number; ms: number }> = [];
  readonly cleared: number[] = [];
  subscriptions = 0;
  unsubscriptions = 0;

  readonly env: AppEnv = {
    reducedMotion: () => this.reduced,
    onReducedMotionChange: (cb) => {
      this.subscriptions++;
      this.listeners.add(cb);
      return () => {
        this.unsubscriptions++;
        this.listeners.delete(cb);
      };
    },
    setTimeout: (fn, ms) => {
      const id = this.nextId++;
      this.timers.set(id, { fn, ms });
      this.scheduled.push({ id, ms });
      return id;
    },
    clearTimeout: (id) => {
      this.cleared.push(id);
      this.timers.delete(id);
    },
  };

  /** Flip the reduced-motion preference and notify subscribers (like a matchMedia change event). */
  setReduced(v: boolean): void {
    this.reduced = v;
    for (const l of [...this.listeners]) l();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Run (and remove) every timer that has not been cleared. */
  runTimers(): void {
    const pending = [...this.timers.entries()];
    for (const [id, t] of pending) {
      if (!this.timers.has(id)) continue;
      this.timers.delete(id);
      t.fn();
    }
  }

  get pending(): number {
    return this.timers.size;
  }
}

export class FakeHost {
  readonly messages: WebviewMessage[] = [];
  readonly stateWrites: PersistedState[] = [];
  state: PersistedState | undefined;

  constructor(initial?: PersistedState) {
    this.state = initial;
  }

  readonly api: HostApi = {
    postMessage: (m) => {
      this.messages.push(m);
    },
    getState: () => this.state,
    setState: (s) => {
      this.state = { collapsed: [...s.collapsed] };
      this.stateWrites.push({ collapsed: [...s.collapsed] });
    },
  };

  opens(): string[] {
    return this.messages.filter((m): m is { type: 'open'; id: string } => m.type === 'open').map((m) => m.id);
  }

  get lastCollapsed(): string[] | undefined {
    return this.stateWrites[this.stateWrites.length - 1]?.collapsed;
  }
}

export interface Harness {
  dom: JSDOM;
  document: Document;
  root: HTMLElement;
  env: FakeEnv;
  host: FakeHost;
  app: App;
  /** Send a snapshot the way the extension host would (as structured-clone-like plain data). */
  send(snapshot: Snapshot): void;
  sendRows(rows: ViewRow[], o?: Partial<Snapshot>): void;
  close(): void;
}

let seqCounter = 0;

export function mount(opts: { reduced?: boolean; state?: PersistedState; html?: string } = {}): Harness {
  const dom = new JSDOM(opts.html ?? '<!doctype html><html><body><div id="app"></div></body></html>', { pretendToBeVisual: true });
  const document = dom.window.document;
  const root = document.getElementById('app');
  if (!root) throw new Error('test document has no #app');
  const env = new FakeEnv();
  env.reduced = opts.reduced === true;
  const host = new FakeHost(opts.state);
  const app = mountApp(root, host.api, env.env);
  const send = (snapshot: Snapshot): void => {
    app.handleMessage(JSON.parse(JSON.stringify({ type: 'snapshot', snapshot })));
  };
  return {
    dom,
    document,
    root,
    env,
    host,
    app,
    send,
    sendRows: (rows, o = {}) => send(snapshotOf(rows, { seq: ++seqCounter, ...o })),
    close: () => {
      try {
        app.dispose();
      } finally {
        dom.window.close();
      }
    },
  };
}

// ----- DOM query helpers ------------------------------------------------------------------

export function rowEls(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('li.fs-row')];
}

/** Finds a row by its data-id without trusting CSS selector escaping. */
export function rowById(root: ParentNode, id: string): HTMLElement | undefined {
  return rowEls(root).find((el) => el.getAttribute('data-id') === id);
}

/** Real folders only: the two per-user sections ("You", "External") are li.fs-folder[data-actor] and not counted. */
export function folderEls(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('li.fs-folder:not([data-actor])')];
}

/** The per-user sections that currently exist, in DOM order. */
export function actorEls(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('li.fs-folder[data-actor]')];
}

/** Folder ids are namespaced per user ("@you/src"); tests may pass the bare id ("src") to mean the first match. */
export function bareFolderId(id: string): string {
  return id.replace(/^@(you|external)\//, '');
}

export function folderById(root: ParentNode, id: string): HTMLElement | undefined {
  const all = folderEls(root);
  return all.find((el) => el.getAttribute('data-folder-id') === id) ?? all.find((el) => bareFolderId(el.getAttribute('data-folder-id') ?? '') === id);
}

/** The list that holds a user's top-level folders and files (what used to be ul.fs-tree itself). */
export function treeOf(root: ParentNode, actor: 'you' | 'external' = 'you'): HTMLElement | undefined {
  return actorEls(root).find((el) => el.getAttribute('data-actor') === actor)?.querySelector<HTMLElement>(':scope > ul.fs-children') ?? undefined;
}

export function text(el: Element | null | undefined, selector: string): string {
  return el?.querySelector(selector)?.textContent ?? '';
}

export function click(el: Element): void {
  const win = el.ownerDocument.defaultView;
  if (!win) throw new Error('detached element');
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
}

export function key(el: Element, k: string): KeyboardEvent {
  const win = el.ownerDocument.defaultView;
  if (!win) throw new Error('detached element');
  const ev = new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

/** Every element in the subtree (including root). */
export function allElements(root: Element): Element[] {
  return [root, ...root.querySelectorAll('*')];
}
