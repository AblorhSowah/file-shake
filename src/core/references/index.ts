import { K } from '../constants';
import { hasSegment } from '../pathUtils';
import type {
  AnalyzeInput,
  FileKey,
  ImportBinding,
  ReferenceResult,
  ReferenceTarget,
  ResolvedTarget,
} from '../types';
import { detectLanguage, parseWithScan } from './parsers/index';
import { resolveImport } from './resolver';
import { blankSpans } from './scan';
import { countUsages } from './usage';

export type {
  AnalyzeInput,
  ImportBinding,
  ImportKind,
  ImportStatement,
  LanguageKey,
  ProbeFs,
  ProjectInfo,
  ReferenceResult,
  ReferenceTarget,
  ResolveContext,
  ResolvedTarget,
  ScanResult,
} from '../types';
export { detectLanguage, parseImports } from './parsers/index';
export { scanCode } from './scan';
export { countUsages } from './usage';
export { loadProjectInfo } from './projectInfo';
export { resolveImport } from './resolver';

interface Acc {
  statements: number;
  lines: Set<number>;
  specifiers: string[];
  bindings: Map<string, ImportBinding>;
}

/**
 * Analyses one source file: parse imports, resolve them to workspace files and count how often each
 * target is referenced (import statements + identifier usages). Never rejects.
 */
export async function analyzeReferences(i: AnalyzeInput): Promise<ReferenceResult> {
  const now = i.now ?? Date.now;
  const started = now();
  const language = detectLanguage(i.languageId, i.path);
  const result: ReferenceResult = {
    source: i.path,
    language,
    targets: [],
    truncated: false,
    unresolved: 0,
    parseMs: 0,
  };
  const finish = (r: ReferenceResult): ReferenceResult => {
    r.parseMs = Math.max(0, now() - started);
    return r;
  };

  try {
    if (i.isExcluded(i.path)) return finish({ ...result, skipped: 'excluded' });
    const maxBytes = (i.maxFileSizeKb ?? 512) * 1024;
    if (i.text.length > maxBytes) return finish({ ...result, skipped: 'too-large' });
    if (i.text.slice(0, 8000).includes('\u0000')) return finish({ ...result, skipped: 'binary' });
    if (language === undefined) return finish({ ...result, skipped: 'unsupported-language' });

    const { statements, spans, scan } = parseWithScan(language, i.text);
    // The statements' own text (names in the import list) must not count as usages. Blanking the exact
    // spans, rather than whole lines, keeps usages that share a line with an import.
    const usageText = blankSpans(scan.masked, spans);
    const noLines: ReadonlySet<number> = new Set<number>();

    const ctx = { fs: i.fs, project: i.project, isExcluded: i.isExcluded, budget: { probes: K.MAX_PROBES }, memo: new Map<string, boolean>() };
    const deadline = started + K.ANALYSIS_TIMEOUT_MS;
    const acc = new Map<FileKey, Acc>();
    let unresolved = 0;
    let truncated = false;

    for (let idx = 0; idx < statements.length; idx += 1) {
      const stmt = statements[idx];
      if (!stmt) continue;
      if (now() > deadline) {
        truncated = true;
        unresolved += statements.length - idx;
        break;
      }
      let targets: ResolvedTarget[];
      try {
        targets = await resolveImport(stmt, i.path, language, ctx);
      } catch {
        targets = [];
      }
      if (targets.length === 0) {
        unresolved += 1;
        continue;
      }
      const countedForStatement = new Set<FileKey>();
      for (const t of targets) {
        if (t.key === i.path || hasSegment(t.key, 'node_modules') || i.isExcluded(t.key)) continue;
        let a = acc.get(t.key);
        if (!a) {
          a = { statements: 0, lines: new Set(), specifiers: [], bindings: new Map() };
          acc.set(t.key, a);
        }
        if (!countedForStatement.has(t.key)) {
          countedForStatement.add(t.key);
          a.statements += 1;
          a.lines.add(stmt.line);
          if (!a.specifiers.includes(stmt.specifier)) a.specifiers.push(stmt.specifier);
        }
        for (const b of t.bindings) if (!a.bindings.has(b.local)) a.bindings.set(b.local, b);
      }
    }

    const targets: ReferenceTarget[] = [];
    for (const [key, a] of acc) {
      const usages = countUsages(usageText, [...a.bindings.values()], noLines);
      targets.push({
        key,
        count: a.statements + usages,
        statements: a.statements,
        usages,
        lines: [...a.lines].sort((x, y) => x - y),
        specifiers: a.specifiers,
      });
    }
    targets.sort((x, y) => y.count - x.count || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    if (targets.length > K.MAX_REFS_PER_SOURCE) {
      targets.length = K.MAX_REFS_PER_SOURCE;
      truncated = true;
    }
    return finish({ ...result, targets, truncated, unresolved });
  } catch {
    return finish({ ...result, skipped: 'unreadable' });
  }
}
