import { K } from './constants';
import type { ClassifyReason } from './types';

export interface Classification {
  decision: 'you' | 'external' | 'ignore';
  reason: ClassifyReason;
}

export interface DocChangeContext {
  contentChangeCount: number;
  /** between will-save and did-save (format-on-save edits) */
  isSaving: boolean;
  reason: 'undo' | 'redo' | undefined;
  isDirtyAfter: boolean;
  isActiveEditorDoc: boolean;
  windowFocused: boolean;
}

/** First matching row wins; see DESIGN 7.3. */
export function classifyDocumentChange(c: DocChangeContext): Classification {
  if (c.contentChangeCount === 0) return { decision: 'ignore', reason: 'no-content-change' };
  if (c.isSaving) return { decision: 'ignore', reason: 'saving' };
  if (c.reason === 'undo' || c.reason === 'redo') return { decision: 'you', reason: 'undo-redo' };
  if (!c.isDirtyAfter) return { decision: 'external', reason: 'reload-from-disk' };
  if (c.isActiveEditorDoc && c.windowFocused) return { decision: 'you', reason: 'active-focused-edit' };
  return { decision: 'external', reason: 'background-edit' };
}

export interface WatcherContext {
  /** undefined = no save seen */
  msSinceOwnSave: number | undefined;
}

export function classifyWatcherEvent(c: WatcherContext): Classification {
  if (c.msSinceOwnSave !== undefined && c.msSinceOwnSave < K.SELF_SAVE_WINDOW_MS) {
    return { decision: 'ignore', reason: 'self-save' };
  }
  return { decision: 'external', reason: 'disk-write' };
}
