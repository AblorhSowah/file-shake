import * as vscode from 'vscode';
import { sanitizeConfig } from '../core/config';
import type { FileShakeConfig } from '../core/config';

const SECTION = 'fileShake';

export function readConfig(): FileShakeConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  const raw: Record<string, unknown> = {
    enable: c.get('enable'),
    enableAnimation: c.get('enableAnimation'),
    idleTimeoutMs: c.get('idleTimeoutMs'),
    windowMs: c.get('windowMs'),
    maxFiles: c.get('maxFiles'),
    excludeGlobs: c.get('excludeGlobs'),
    editedColor: c.get('colors.edited'),
    referencedColor: c.get('colors.referenced'),
    sensitivity: c.get('sensitivity'),
    showWhenIdle: c.get('showWhenIdle'),
    persistUntilNextFile: c.get('persistUntilNextFile'),
    decorateFolders: c.get('decorateFolders'),
    detectExternalEdits: c.get('detectExternalEdits'),
    maxFileSizeKb: c.get('maxFileSizeKb'),
    showStatusBar: c.get('showStatusBar'),
  };
  return sanitizeConfig(raw);
}

export function onDidChangeConfig(cb: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SECTION)) cb();
  });
}

/** Flips `fileShake.enable` in the scope where it is currently defined (default: user settings). */
export async function toggleEnabled(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const c = vscode.workspace.getConfiguration(SECTION, folder?.uri);
  const next = !(c.get<boolean>('enable') ?? true);
  const info = c.inspect<boolean>('enable');
  const attempts: vscode.ConfigurationTarget[] = [];
  if (info?.workspaceFolderValue !== undefined && folder) attempts.push(vscode.ConfigurationTarget.WorkspaceFolder);
  else if (info?.workspaceValue !== undefined) attempts.push(vscode.ConfigurationTarget.Workspace);
  attempts.push(vscode.ConfigurationTarget.Global);
  for (const target of attempts) {
    try {
      await c.update('enable', next, target);
      return;
    } catch {
      // try the next, broader scope
    }
  }
}
