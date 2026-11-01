import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { buildWebviewHtml, makeNonce, parseWebviewMessage } from '../core/protocol';
import type { HostMessage } from '../core/protocol';
import type { Snapshot } from '../core/types';

export class ShakeViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'fileShake.view';

  private view: vscode.WebviewView | undefined;
  private viewDisposables: vscode.Disposable[] = [];
  private latest: Snapshot | undefined;
  private disposed = false;
  private resolved = 0;
  private ready = 0;
  private sent = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: (msg: string) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.releaseView();
    this.resolved += 1;
    this.view = view;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist, media] };
    view.webview.html = buildWebviewHtml({
      cspSource: view.webview.cspSource,
      nonce: makeNonce((n) => randomBytes(n)),
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: 'File Shake',
    });

    this.viewDisposables.push(
      view.webview.onDidReceiveMessage((raw: unknown) => this.onMessage(raw)),
      view.onDidChangeVisibility(() => {
        if (view.visible) this.send();
      }),
      view.onDidDispose(() => {
        if (this.view === view) this.releaseView();
      }),
    );
  }

  isVisible(): boolean {
    return this.view?.visible === true;
  }

  /** Counters for the test API: how often the view was resolved, said `ready`, and received a snapshot. */
  stats(): { resolved: number; ready: number; sent: number; visible: boolean } {
    return { resolved: this.resolved, ready: this.ready, sent: this.sent, visible: this.isVisible() };
  }

  /** Stores the snapshot; it is only sent when the view is visible (a hidden webview cannot receive messages). */
  push(snapshot: Snapshot): void {
    this.latest = snapshot;
    if (this.view?.visible) this.send();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseView();
    this.latest = undefined;
  }

  private releaseView(): void {
    for (const d of this.viewDisposables) d.dispose();
    this.viewDisposables = [];
    this.view = undefined;
  }

  private send(): void {
    const view = this.view;
    const snapshot = this.latest;
    if (!view || !snapshot) return;
    const message: HostMessage = { type: 'snapshot', snapshot };
    this.sent += 1;
    Promise.resolve(view.webview.postMessage(message)).catch((err: unknown) => {
      this.log(`postMessage failed: ${String(err)}`);
    });
  }

  private onMessage(raw: unknown): void {
    const msg = parseWebviewMessage(raw);
    if (!msg) return;
    switch (msg.type) {
      case 'ready':
        this.ready += 1;
        this.send();
        break;
      case 'open': {
        // never trust the id as a URI: only rows from the last snapshot can be opened
        const row = this.latest?.rows.find((r) => r.id === msg.id);
        if (!row) return;
        Promise.resolve(vscode.window.showTextDocument(vscode.Uri.parse(row.uri), { preview: true })).catch(
          (err: unknown) => this.log(`open failed for ${row.id}: ${String(err)}`),
        );
        break;
      }
      case 'error':
        this.log(`webview error: ${msg.message}`);
        break;
    }
  }
}
