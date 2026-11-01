import * as vscode from 'vscode';
import { normalizePath } from '../core/pathUtils';
import type { FileKey, WorkspaceRoot } from '../core/types';

/** FileKey for a `file:` URI; undefined for every other scheme (untitled, git, output, notebook cells...). */
export function fileKeyFromUri(uri: vscode.Uri): FileKey | undefined {
  return uri.scheme === 'file' ? normalizePath(uri.fsPath) : undefined;
}

export function uriFromKey(key: FileKey): vscode.Uri {
  return vscode.Uri.file(key);
}

export function getRoots(): WorkspaceRoot[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => ({ key: normalizePath(f.uri.fsPath), name: f.name }));
}
