import { mountApp } from './app';
import type { HostApi, PersistedState } from './app';
import type { WebviewMessage } from '../core/protocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

function readState(raw: unknown): PersistedState | undefined {
  if (typeof raw !== 'object' || raw === null || !('collapsed' in raw) || !Array.isArray(raw.collapsed)) {
    return undefined;
  }
  return { collapsed: raw.collapsed.filter((v): v is string => typeof v === 'string') };
}

const vscode = acquireVsCodeApi();
const root = document.getElementById('app');

if (root) {
  const host: HostApi = {
    postMessage: (m: WebviewMessage) => vscode.postMessage(m),
    getState: () => readState(vscode.getState()),
    setState: (s: PersistedState) => vscode.setState(s),
  };
  const app = mountApp(root, host);
  window.addEventListener('message', (e: MessageEvent<unknown>) => app.handleMessage(e.data));
  window.addEventListener('error', (e: ErrorEvent) => {
    vscode.postMessage({ type: 'error', message: String(e.message) } satisfies WebviewMessage);
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    vscode.postMessage({ type: 'error', message: String(e.reason) } satisfies WebviewMessage);
  });
}
