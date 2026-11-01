import * as vscode from 'vscode';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private disposed = false;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    this.item.name = 'File Shake';
    this.item.command = 'fileShake.focusView';
  }

  update(status: { text: string; tooltip: string }, visible: boolean): void {
    if (this.disposed) return;
    this.item.text = status.text;
    this.item.tooltip = status.tooltip;
    if (visible) this.item.show();
    else this.item.hide();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.item.dispose();
  }
}
