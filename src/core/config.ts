import { COLOR_PATTERN, K } from './constants';
import type { TrackerOptions } from './activityTracker';

export interface FileShakeConfig {
  enable: boolean;
  enableAnimation: boolean;
  idleTimeoutMs: number;
  windowMs: number;
  maxFiles: number;
  excludeGlobs: string[];
  /** '' = follow the theme */
  editedColor: string;
  /** '' = follow the theme */
  referencedColor: string;
  sensitivity: number;
  showWhenIdle: boolean;
  decorateFolders: boolean;
  detectExternalEdits: boolean;
  maxFileSizeKb: number;
  showStatusBar: boolean;
}

export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/out/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.venv/**',
  '**/__pycache__/**',
  '**/.vscode-test/**',
  '**/*.min.js',
  '**/*.map',
  '**/*.log',
  '**/*.vsix',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
];

export const DEFAULT_CONFIG: FileShakeConfig = {
  enable: true,
  enableAnimation: true,
  idleTimeoutMs: 2500,
  windowMs: 3000,
  maxFiles: 40,
  excludeGlobs: [...DEFAULT_EXCLUDE_GLOBS],
  editedColor: '',
  referencedColor: '',
  sensitivity: 1,
  showWhenIdle: false,
  decorateFolders: true,
  detectExternalEdits: true,
  maxFileSizeKb: 512,
  showStatusBar: true,
};

export { COLOR_PATTERN };

function num(v: unknown, def: number, min: number, max: number, integer: boolean): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return def;
  const clamped = Math.min(max, Math.max(min, v));
  return integer ? Math.round(clamped) : clamped;
}

function bool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def;
}

function color(v: unknown): string {
  return typeof v === 'string' && COLOR_PATTERN.test(v) ? v : '';
}

/** Total: never throws; every invalid value falls back to its default or is clamped. */
export function sanitizeConfig(raw: Readonly<Record<string, unknown>>): FileShakeConfig {
  const d = DEFAULT_CONFIG;
  try {
    const r: Readonly<Record<string, unknown>> = typeof raw === 'object' && raw !== null ? raw : {};
    const globs = r['excludeGlobs'];
    return {
      enable: bool(r['enable'], d.enable),
      enableAnimation: bool(r['enableAnimation'], d.enableAnimation),
      idleTimeoutMs: num(r['idleTimeoutMs'], d.idleTimeoutMs, 500, 60000, false),
      windowMs: num(r['windowMs'], d.windowMs, 500, 30000, false),
      maxFiles: num(r['maxFiles'], d.maxFiles, 5, 200, true),
      excludeGlobs: Array.isArray(globs)
        ? globs.filter((g): g is string => typeof g === 'string')
        : [...d.excludeGlobs],
      editedColor: color(r['editedColor']),
      referencedColor: color(r['referencedColor']),
      sensitivity: num(r['sensitivity'], d.sensitivity, 0.25, 4, false),
      showWhenIdle: bool(r['showWhenIdle'], d.showWhenIdle),
      decorateFolders: bool(r['decorateFolders'], d.decorateFolders),
      detectExternalEdits: bool(r['detectExternalEdits'], d.detectExternalEdits),
      maxFileSizeKb: num(r['maxFileSizeKb'], d.maxFileSizeKb, 16, 4096, true),
      showStatusBar: bool(r['showStatusBar'], d.showStatusBar),
    };
  } catch {
    return { ...d, excludeGlobs: [...d.excludeGlobs] };
  }
}

export function toTrackerOptions(c: FileShakeConfig): TrackerOptions {
  return {
    windowMs: c.windowMs,
    idleTimeoutMs: c.idleTimeoutMs,
    retainAfterIdleMs: K.RETAIN_AFTER_IDLE_MS,
    maxFiles: c.maxFiles,
    sensitivity: c.sensitivity,
    showWhenIdle: c.showWhenIdle,
  };
}
