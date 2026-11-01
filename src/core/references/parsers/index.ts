import { buildLineIndex, scanCode } from '../scan';
import type { ImportStatement, LanguageKey, ScanResult } from '../../types';
import { parseCFamily } from './cfamily';
import { parseCss } from './css';
import { parseGo } from './go';
import { parseHtml } from './html';
import { parseJsTs } from './jsTs';
import { parseJvm } from './jvm';
import { parseMarkdown } from './markdown';
import { parsePhp } from './php';
import { parsePython } from './python';
import { parseRuby } from './ruby';
import { parseRust } from './rust';
import { Collector } from './util';

export type { ImportBinding, ImportKind, ImportStatement, LanguageKey } from '../../types';
export { readPackageName } from './jvm';

const BY_LANGUAGE_ID: Record<string, LanguageKey> = {
  typescript: 'ts',
  typescriptreact: 'ts',
  javascript: 'js',
  javascriptreact: 'js',
  python: 'python',
  go: 'go',
  java: 'java',
  kotlin: 'kotlin',
  c: 'c',
  cpp: 'cpp',
  rust: 'rust',
  ruby: 'ruby',
  php: 'php',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  markdown: 'markdown',
};

const BY_EXTENSION: Record<string, LanguageKey> = {
  '.ts': 'ts',
  '.tsx': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.js': 'js',
  '.jsx': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.php': 'php',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.md': 'markdown',
  '.markdown': 'markdown',
};

/** languageId first, then the file extension. */
export function detectLanguage(languageId: string, filePath: string): LanguageKey | undefined {
  const byId = Object.prototype.hasOwnProperty.call(BY_LANGUAGE_ID, languageId) ? BY_LANGUAGE_ID[languageId] : undefined;
  if (byId) return byId;
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const ext = base.slice(dot).toLowerCase();
  return Object.prototype.hasOwnProperty.call(BY_EXTENSION, ext) ? BY_EXTENSION[ext] : undefined;
}

export interface ParsedFile {
  statements: ImportStatement[];
  /** [start, end] source offsets of each statement, parallel to `statements` */
  spans: Array<[number, number]>;
  scan: ScanResult;
}

/** Scans once and parses; analyzeReferences reuses the masked text for usage counting. */
export function parseWithScan(lang: LanguageKey, text: string): ParsedFile {
  const scan = scanCode(lang, text);
  const lines = buildLineIndex(text);
  const out = new Collector(lines);
  const inp = { lang, text, masked: scan.masked, strings: scan.strings, lines };
  try {
    switch (lang) {
      case 'ts':
      case 'js':
        parseJsTs(inp, out);
        break;
      case 'python':
        parsePython(inp, out);
        break;
      case 'go':
        parseGo(inp, out);
        break;
      case 'java':
      case 'kotlin':
        parseJvm(inp, out);
        break;
      case 'c':
      case 'cpp':
        parseCFamily(inp, out);
        break;
      case 'rust':
        parseRust(inp, out);
        break;
      case 'ruby':
        parseRuby(inp, out);
        break;
      case 'php':
        parsePhp(inp, out);
        break;
      case 'css':
      case 'scss':
      case 'less':
        parseCss(inp, out);
        break;
      case 'html':
        parseHtml(inp, out);
        break;
      case 'markdown':
        parseMarkdown(inp, out);
        break;
    }
  } catch {
    // total: keep whatever was collected
  }
  return { statements: out.result(), spans: out.spans(), scan };
}

/** Sync, total, linear-time; at most MAX_STATEMENTS statements. */
export function parseImports(lang: LanguageKey, text: string): ImportStatement[] {
  return parseWithScan(lang, text).statements;
}
