import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, sanitizeConfig, toTrackerOptions } from '../../src/core/config';
import type { FileShakeConfig } from '../../src/core/config';
import { DEFAULT_TRACKER_OPTIONS } from '../../src/core/activityTracker';
import { K } from '../../src/core/constants';

const EXPECTED_DEFAULT_GLOBS = [
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

const KEYS: Array<keyof FileShakeConfig> = [
  'enable',
  'enableAnimation',
  'idleTimeoutMs',
  'windowMs',
  'maxFiles',
  'excludeGlobs',
  'editedColor',
  'referencedColor',
  'sensitivity',
  'showWhenIdle',
  'persistUntilNextFile',
  'decorateFolders',
  'detectExternalEdits',
  'maxFileSizeKb',
  'showStatusBar',
];

describe('DEFAULT_CONFIG', () => {
  it('matches the documented defaults', () => {
    assert.equal(DEFAULT_CONFIG.enable, true);
    assert.equal(DEFAULT_CONFIG.enableAnimation, true);
    assert.equal(DEFAULT_CONFIG.idleTimeoutMs, 2500);
    assert.equal(DEFAULT_CONFIG.windowMs, 3000);
    assert.equal(DEFAULT_CONFIG.maxFiles, 40);
    assert.equal(DEFAULT_CONFIG.sensitivity, 1);
    assert.equal(DEFAULT_CONFIG.maxFileSizeKb, 512);
    assert.equal(DEFAULT_CONFIG.showWhenIdle, false);
    assert.equal(DEFAULT_CONFIG.persistUntilNextFile, true);
    assert.equal(DEFAULT_CONFIG.decorateFolders, true);
    assert.equal(DEFAULT_CONFIG.detectExternalEdits, true);
    assert.equal(DEFAULT_CONFIG.showStatusBar, true);
    assert.equal(DEFAULT_CONFIG.editedColor, '');
    assert.equal(DEFAULT_CONFIG.referencedColor, '');
    assert.deepEqual([...DEFAULT_CONFIG.excludeGlobs], EXPECTED_DEFAULT_GLOBS);
  });

  it('has exactly the documented keys', () => {
    assert.deepEqual(Object.keys(DEFAULT_CONFIG).sort(), [...KEYS].sort());
  });
});

describe('sanitizeConfig', () => {
  it('an empty record yields the defaults', () => {
    assert.deepEqual(sanitizeConfig({}), DEFAULT_CONFIG);
  });

  it('unknown keys are dropped; the result has exactly the documented keys', () => {
    const c = sanitizeConfig({ bogus: 1, enable: false, __proto__: { x: 1 } });
    assert.deepEqual(Object.keys(c).sort(), [...KEYS].sort());
    assert.equal(c.enable, false);
  });

  it('valid values pass through unchanged', () => {
    const raw = {
      enable: false,
      enableAnimation: false,
      idleTimeoutMs: 1234,
      windowMs: 4321,
      maxFiles: 77,
      excludeGlobs: ['**/*.foo', 'bar/**'],
      editedColor: '#112233',
      referencedColor: '#abc',
      sensitivity: 2.5,
      showWhenIdle: true,
      persistUntilNextFile: false,
      decorateFolders: false,
      detectExternalEdits: false,
      maxFileSizeKb: 1024,
      showStatusBar: false,
    };
    assert.deepEqual(sanitizeConfig(raw), raw);
  });

  describe('numeric ranges clamp', () => {
    const ranges: Array<[keyof FileShakeConfig, number, number, number, boolean]> = [
      ['idleTimeoutMs', 500, 60000, 2500, false],
      ['windowMs', 500, 30000, 3000, false],
      ['maxFiles', 5, 200, 40, true],
      ['sensitivity', 0.25, 4, 1, false],
      ['maxFileSizeKb', 16, 4096, 512, true],
    ];
    for (const [key, min, max, def, integer] of ranges) {
      it(`${key}: [${min}, ${max}] default ${def}`, () => {
        const get = (v: unknown): unknown => sanitizeConfig({ [key]: v })[key];
        assert.equal(get(min - 1), min);
        assert.equal(get(-1), min);
        assert.equal(get(-1e9), min);
        assert.equal(get(0), min);
        assert.equal(get(max + 1), max);
        assert.equal(get(1e12), max);
        assert.equal(get(min), min);
        assert.equal(get(max), max);
        assert.equal(get(Number.NaN), def);
        assert.equal(get(undefined), def);
        assert.equal(get(null), def);
        assert.equal(get(String(max)), def, 'numeric strings are not numbers');
        assert.equal(get('abc'), def);
        assert.equal(get(true), def);
        assert.equal(get({}), def);
        assert.equal(get([]), def);
        // Infinity is a number but not finite: either clamp-to-max or fall back to default is acceptable,
        // as long as the result is in range.
        const inf = get(Number.POSITIVE_INFINITY);
        assert.ok(typeof inf === 'number' && inf >= min && inf <= max, `Infinity -> ${String(inf)}`);
        const ninf = get(Number.NEGATIVE_INFINITY);
        assert.ok(typeof ninf === 'number' && ninf >= min && ninf <= max, `-Infinity -> ${String(ninf)}`);
        if (integer) {
          const mid = Math.floor((min + max) / 2);
          assert.equal(get(mid + 0.4), mid, 'integers are rounded');
          assert.equal(get(mid + 0.6), mid + 1, 'integers are rounded');
        }
      });
    }

    it('fractional idle/window values stay within half a unit of the input', () => {
      const idle = sanitizeConfig({ idleTimeoutMs: 2500.6 }).idleTimeoutMs;
      assert.ok(Math.abs(idle - 2500.6) <= 0.5);
    });
  });

  describe('booleans', () => {
    const boolKeys: Array<[keyof FileShakeConfig, boolean]> = [
      ['enable', true],
      ['enableAnimation', true],
      ['showWhenIdle', false],
      ['persistUntilNextFile', true],
      ['decorateFolders', true],
      ['detectExternalEdits', true],
      ['showStatusBar', true],
    ];
    for (const [key, def] of boolKeys) {
      it(`${key}: non-boolean falls back to default ${def}`, () => {
        for (const bad of ['true', 'false', 'yes', 1, 0, null, undefined, {}, [], Number.NaN]) {
          assert.equal(sanitizeConfig({ [key]: bad })[key], def, `${key}=${String(bad)}`);
        }
        assert.equal(sanitizeConfig({ [key]: true })[key], true);
        assert.equal(sanitizeConfig({ [key]: false })[key], false);
      });
    }
  });

  describe('excludeGlobs', () => {
    it('non-array falls back to the default list', () => {
      for (const bad of ['**/*.ts', 5, null, undefined, {}, true]) {
        assert.deepEqual([...sanitizeConfig({ excludeGlobs: bad }).excludeGlobs], EXPECTED_DEFAULT_GLOBS);
      }
    });

    it('an empty array is valid and stays empty', () => {
      assert.deepEqual(sanitizeConfig({ excludeGlobs: [] }).excludeGlobs, []);
    });

    it('arrays keep only their string entries, in order', () => {
      assert.deepEqual(sanitizeConfig({ excludeGlobs: ['a', 1, null, 'b', undefined, {}, ['c'], 'd'] }).excludeGlobs, ['a', 'b', 'd']);
    });

    it('the returned array is a copy: mutating it never corrupts DEFAULT_CONFIG', () => {
      const c = sanitizeConfig({});
      c.excludeGlobs.push('**/mutated');
      assert.ok(!DEFAULT_CONFIG.excludeGlobs.includes('**/mutated'));
      const d = sanitizeConfig({});
      assert.ok(!d.excludeGlobs.includes('**/mutated'));
    });

    it('does not alias the caller\'s array', () => {
      const input = ['x'];
      const c = sanitizeConfig({ excludeGlobs: input });
      input.push('y');
      assert.deepEqual(c.excludeGlobs, ['x']);
    });
  });

  describe('colours', () => {
    for (const ok of ['#fff', '#FFF', '#3fb950', '#3FB950', '#e3b341', '#ffffff80', '#AbCdEf12', '#000']) {
      it(`accepts ${ok}`, () => {
        assert.equal(sanitizeConfig({ editedColor: ok }).editedColor, ok);
        assert.equal(sanitizeConfig({ referencedColor: ok }).referencedColor, ok);
      });
    }
    for (const bad of ['', 'red', '#ggg', '#12345', '#ffff', '#1234567', '#123456789', 'fff', ' #fff', '#fff ', 'rgb(1,2,3)', '#fff\n', 123, null, undefined, {}, []]) {
      it(`rejects ${JSON.stringify(bad)} -> '' (follow theme)`, () => {
        assert.equal(sanitizeConfig({ editedColor: bad }).editedColor, '');
        assert.equal(sanitizeConfig({ referencedColor: bad }).referencedColor, '');
      });
    }
  });

  describe('fuzz: total, never throws, always in range', () => {
    const junk: unknown[] = [
      undefined,
      null,
      Number.NaN,
      0,
      -0,
      -1,
      1,
      0.5,
      1e308,
      -1e308,
      Number.MAX_SAFE_INTEGER,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '',
      'x',
      '#fff',
      '0',
      'NaN',
      true,
      false,
      [],
      [1, 2],
      ['a'],
      {},
      { a: 1 },
      () => 1,
      Symbol('s'),
      10n,
    ];

    it('every key x every junk value', () => {
      for (const key of KEYS) {
        for (const v of junk) {
          const c = sanitizeConfig({ [key]: v });
          assertValid(c);
        }
      }
    });

    it('all keys junk simultaneously (deterministic pseudo-random combinations)', () => {
      let seed = 12345;
      const rnd = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      for (let n = 0; n < 500; n++) {
        const raw: Record<string, unknown> = {};
        for (const key of KEYS) raw[key] = junk[Math.floor(rnd() * junk.length)];
        assertValid(sanitizeConfig(raw));
      }
    });

    it('does not throw for null-prototype and frozen inputs', () => {
      const np = Object.create(null) as Record<string, unknown>;
      np['maxFiles'] = 10;
      assert.equal(sanitizeConfig(np).maxFiles, 10);
      assert.equal(sanitizeConfig(Object.freeze({ maxFiles: 11 })).maxFiles, 11);
    });

    function assertValid(c: FileShakeConfig): void {
      assert.equal(typeof c.enable, 'boolean');
      assert.equal(typeof c.enableAnimation, 'boolean');
      assert.equal(typeof c.showWhenIdle, 'boolean');
      assert.equal(typeof c.persistUntilNextFile, 'boolean');
      assert.equal(typeof c.decorateFolders, 'boolean');
      assert.equal(typeof c.detectExternalEdits, 'boolean');
      assert.equal(typeof c.showStatusBar, 'boolean');
      assert.ok(Number.isFinite(c.idleTimeoutMs) && c.idleTimeoutMs >= 500 && c.idleTimeoutMs <= 60000);
      assert.ok(Number.isFinite(c.windowMs) && c.windowMs >= 500 && c.windowMs <= 30000);
      assert.ok(Number.isInteger(c.maxFiles) && c.maxFiles >= 5 && c.maxFiles <= 200);
      assert.ok(Number.isFinite(c.sensitivity) && c.sensitivity >= 0.25 && c.sensitivity <= 4);
      assert.ok(Number.isInteger(c.maxFileSizeKb) && c.maxFileSizeKb >= 16 && c.maxFileSizeKb <= 4096);
      assert.ok(Array.isArray(c.excludeGlobs) && c.excludeGlobs.every((g) => typeof g === 'string'));
      assert.match(c.editedColor, /^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))?$/);
      assert.match(c.referencedColor, /^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))?$/);
    }
  });
});

describe('toTrackerOptions', () => {
  it('maps config fields and uses RETAIN_AFTER_IDLE_MS', () => {
    const c = sanitizeConfig({ windowMs: 5000, idleTimeoutMs: 1500, maxFiles: 12, sensitivity: 2, showWhenIdle: true, persistUntilNextFile: false });
    assert.deepEqual(toTrackerOptions(c), {
      windowMs: 5000,
      idleTimeoutMs: 1500,
      retainAfterIdleMs: K.RETAIN_AFTER_IDLE_MS,
      maxFiles: 12,
      sensitivity: 2,
      showWhenIdle: true,
      persist: false,
    });
    assert.equal(toTrackerOptions(sanitizeConfig({ persistUntilNextFile: true })).persist, true);
  });

  it('DEFAULT_TRACKER_OPTIONS equals toTrackerOptions(DEFAULT_CONFIG) except persistence, and the documented numbers', () => {
    // the product default is persistence ON (config); the bare tracker keeps timed removal so its own tests stay timing-based
    assert.deepEqual(toTrackerOptions(DEFAULT_CONFIG), { ...DEFAULT_TRACKER_OPTIONS, persist: true });
    assert.deepEqual(DEFAULT_TRACKER_OPTIONS, {
      windowMs: 3000,
      idleTimeoutMs: 2500,
      retainAfterIdleMs: 4000,
      maxFiles: 40,
      sensitivity: 1,
      showWhenIdle: false,
      persist: false,
    });
  });
});
