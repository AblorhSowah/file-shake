import * as vscode from 'vscode';
import { changedKeys } from '../core/decorations';
import type { DecorationSpec, FileKey } from '../core/types';
import { fileKeyFromUri, uriFromKey } from './uriKey';

const CHUNK = 250;

/** Explorer tint/badge/tooltip for edited and referenced files. Only exact changed URIs are ever fired. */
export class ShakeDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private current: Map<FileKey, DecorationSpec> = new Map();
  private readonly emitter = new vscode.EventEmitter<undefined | vscode.Uri | vscode.Uri[]>();
  private disposed = false;
  readonly onDidChangeFileDecorations = this.emitter.event;

  update(next: Map<FileKey, DecorationSpec>): void {
    if (this.disposed) return;
    const changed = changedKeys(this.current, next);
    this.current = next;
    // The workbench caps events at 250 URIs; chunking keeps every changed URI addressed individually.
    for (let i = 0; i < changed.length; i += CHUNK) {
      this.emitter.fire(changed.slice(i, i + CHUNK).map(uriFromKey));
    }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const key = fileKeyFromUri(uri);
    if (key === undefined) return undefined;
    const spec = this.current.get(key);
    if (!spec) return undefined;
    const decoration = new vscode.FileDecoration(spec.badge, spec.tooltip, new vscode.ThemeColor(spec.colorId));
    decoration.propagate = spec.propagate;
    return decoration;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.current = new Map();
    this.emitter.dispose();
  }
}
