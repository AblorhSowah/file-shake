import { K } from './constants';
import type { ShakeParams } from './types';

/** Non-finite (NaN, +-Infinity) -> 0; otherwise clamped to [0, 1]. */
export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** Non-finite -> 1; otherwise clamped to [0.25, 4]. */
export function clampSensitivity(s: number): number {
  if (!Number.isFinite(s)) return 1;
  return Math.min(4, Math.max(0.25, s));
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Weight of one content change of `chars` characters: 1 + log2(chars), capped. */
export function changeWeight(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.min(K.MAX_EVENT_WEIGHT, 1 + Math.log2(chars));
}

export interface ContentChangeSize {
  /** text.length */
  inserted: number;
  /** rangeLength */
  deleted: number;
}

/** Weight of one document-change event (all its content changes), capped at MAX_EVENT_WEIGHT. */
export function typingWeight(changes: readonly ContentChangeSize[]): number {
  let sum = 0;
  for (const c of changes) sum += changeWeight(Math.max(c.inserted, c.deleted));
  return Math.min(K.MAX_EVENT_WEIGHT, sum);
}

export interface WeightedEvent {
  at: number;
  weight: number;
}

/** Weighted events per second over the live part of the window. */
export function windowRate(events: readonly WeightedEvent[], now: number, windowMs: number): number {
  let sum = 0;
  let oldest = Infinity;
  let any = false;
  for (const e of events) {
    if (e.at <= now && now - e.at < windowMs) {
      any = true;
      if (e.at < oldest) oldest = e.at;
      if (Number.isFinite(e.weight) && e.weight > 0) sum += e.weight;
    }
  }
  if (!any) return 0;
  const span = Math.max(K.MIN_SPAN_MS, Math.min(now - oldest, windowMs));
  return sum / (span / 1000);
}

/** Saturating map from events/sec to [0, 1] with a floor while anything is happening. */
export function rateToIntensity(rate: number, sensitivity: number): number {
  if (!Number.isFinite(rate) || !(rate > 0)) return 0;
  const raw = 1 - Math.exp((-rate * clampSensitivity(sensitivity)) / K.RATE_SCALE);
  return clamp01(Math.max(K.FLOOR, raw));
}

/** Linear fade from 1 (just edited) to 0 (idle timeout reached). */
export function idleFade(sinceLastMs: number, idleTimeoutMs: number): number {
  if (!(idleTimeoutMs > 0)) return 0;
  const since = Math.max(0, sinceLastMs);
  return clamp01(1 - since / idleTimeoutMs);
}

export function editIntensity(
  events: readonly WeightedEvent[],
  now: number,
  o: { windowMs: number; idleTimeoutMs: number; sensitivity: number },
): number {
  if (events.length === 0) return 0;
  // An active file must never have rate 0 because the user chose a tiny window.
  const w = Math.max(o.windowMs, o.idleTimeoutMs);
  let latest = -Infinity;
  for (const e of events) if (e.at > latest) latest = e.at;
  const since = Math.max(0, now - latest);
  if (since >= o.idleTimeoutMs) return 0;
  return clamp01(
    rateToIntensity(windowRate(events, now, w), o.sensitivity) * idleFade(since, o.idleTimeoutMs),
  );
}

/** Log-scaled reference count: REF_SATURATION references map to 1 at sensitivity 1. */
export function referenceIntensity(count: number, sensitivity: number): number {
  if (!Number.isFinite(count) || !(count > 0)) return 0;
  return clamp01((Math.log2(1 + count) * clampSensitivity(sensitivity)) / Math.log2(1 + K.REF_SATURATION));
}

export function shakeParams(intensity: number): ShakeParams {
  if (!Number.isFinite(intensity) || intensity <= 0) return { amp: 0, dur: K.DUR_BASE, rot: 0 };
  const i = clamp01(intensity);
  return {
    amp: round2(K.AMP_MIN + K.AMP_RANGE * i),
    dur: Math.round(K.DUR_BASE - K.DUR_RANGE * i),
    rot: round2(K.ROT_BASE + K.ROT_RANGE * i),
  };
}
