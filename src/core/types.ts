/** All shared data types live here and only here. */

/** Normalised absolute POSIX path; drive letter lower-cased ("/home/u/p/a.ts", "c:/p/a.ts", UNC "//srv/share/a.ts"). */
export type FileKey = string;
export type EditSource = 'you' | 'external';
export type Phase = 'active' | 'idle';
export type Role = 'edited' | 'referenced';

export interface WorkspaceRoot {
  key: FileKey;
  name: string;
}

/** Shake parameters: px, ms, deg. */
export interface ShakeParams {
  amp: number;
  dur: number;
  rot: number;
}

export interface TrackedFile {
  key: FileKey;
  source: EditSource;
  phase: Phase;
  intensity: number;
  /** windowRate at now, even when idle */
  rate: number;
  firstEditAt: number;
  lastEditAt: number;
  editCount: number;
}

export interface ViewRow {
  id: FileKey;
  uri: string;
  name: string;
  dir: string;
  folderPath: string[];
  role: Role;
  /** which "user" this row is shown under: the writer of an edited row, or the writer whose file references a yellow row */
  actor: EditSource;
  /** null for referenced rows */
  source: EditSource | null;
  phase: Phase;
  intensity: number;
  shake: ShakeParams;
  /** 0 for edited rows */
  refCount: number;
  badge: string;
  tooltip: string;
}

export interface Snapshot {
  v: 1;
  seq: number;
  enabled: boolean;
  animate: boolean;
  /** '' = follow the theme colour */
  colors: { edited: string; referenced: string };
  rows: ViewRow[];
}

export interface DecorationSpec {
  role: Role;
  badge: string;
  tooltip: string;
  colorId: 'fileShake.editedForeground' | 'fileShake.referencedForeground';
  propagate: boolean;
}

/** Milliseconds clock. */
export interface Clock {
  now(): number;
}

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): { cancel(): void };
}

export type ClassifyReason =
  | 'no-content-change'
  | 'saving'
  | 'undo-redo'
  | 'reload-from-disk'
  | 'active-focused-edit'
  | 'background-edit'
  | 'disk-write'
  | 'self-save'
  | 'dedupe'
  | 'excluded'
  | 'burst'
  | 'scheme'
  | 'disabled'
  | 'external-detection-off';

export interface LogEntry {
  at: number;
  key: string;
  origin: 'doc' | 'watcher';
  decision: 'you' | 'external' | 'ignore';
  reason: ClassifyReason;
  weight: number;
}

// ---------------------------------------------------------------------------
// Reference detection types (DESIGN section 8). Re-exported from references/index.ts.
// ---------------------------------------------------------------------------

export type LanguageKey =
  | 'ts'
  | 'js'
  | 'python'
  | 'go'
  | 'java'
  | 'kotlin'
  | 'c'
  | 'cpp'
  | 'rust'
  | 'ruby'
  | 'php'
  | 'css'
  | 'scss'
  | 'less'
  | 'html'
  | 'markdown';

/** `imported`: a name, 'default' or '*'. `local` may be dotted (python "a.b.c"). */
export interface ImportBinding {
  local: string;
  imported: string;
}

export type ImportKind =
  | 'import'
  | 'export-from'
  | 'require'
  | 'dynamic'
  | 'include'
  | 'use'
  | 'mod'
  | 'link'
  | 'style-import'
  | 'markdown-link';

export interface ImportStatement {
  specifier: string;
  kind: ImportKind;
  /** 1-based */
  line: number;
  /** 1-based, inclusive */
  endLine: number;
  bindings: ImportBinding[];
  typeOnly: boolean;
  /** python leading dots; ruby `require_relative` and php `__DIR__ .` use 1 as a "relative to this file" marker; else 0 */
  relativeLevel: number;
  /** C `<...>` */
  angle: boolean;
  /** java static import */
  isStatic: boolean;
}

export interface ScanResult {
  /** same length as the input; comments and string contents replaced by spaces, newlines kept */
  masked: string;
  /** offset of each opening quote -> raw string contents */
  strings: ReadonlyMap<number, string>;
}

export interface ProbeFs {
  isFile(p: FileKey): Promise<boolean>;
  /** names; [] if missing */
  listDir(p: FileKey): Promise<string[]>;
  readText(p: FileKey, maxBytes: number): Promise<string | undefined>;
}

export interface ProjectInfo {
  roots: FileKey[];
  tsconfig?: { dir: FileKey; baseUrl?: FileKey; paths: Record<string, string[]> };
  goModule?: { dir: FileKey; modulePath: string };
  psr4?: Record<string, FileKey[]>;
}

/** python `from pkg import a, b` can yield several targets, each with its own bindings. */
export interface ResolvedTarget {
  key: FileKey;
  bindings: readonly ImportBinding[];
}

export interface ResolveContext {
  fs: ProbeFs;
  project: ProjectInfo;
  isExcluded(key: FileKey): boolean;
  budget: { probes: number };
  memo: Map<string, boolean>;
  /** java/kotlin: package of the analysed file, if already known (avoids re-reading it) */
  packageName?: string | undefined;
}

export interface ReferenceTarget {
  key: FileKey;
  count: number;
  statements: number;
  usages: number;
  lines: number[];
  specifiers: string[];
}

export interface ReferenceResult {
  source: FileKey;
  language: LanguageKey | undefined;
  targets: ReferenceTarget[];
  truncated: boolean;
  unresolved: number;
  skipped?: 'unsupported-language' | 'too-large' | 'binary' | 'unreadable' | 'excluded';
  parseMs: number;
}

export interface AnalyzeInput {
  path: FileKey;
  languageId: string;
  text: string;
  fs: ProbeFs;
  project: ProjectInfo;
  isExcluded(key: FileKey): boolean;
  now?: () => number;
  maxFileSizeKb?: number;
}
