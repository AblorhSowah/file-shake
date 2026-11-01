import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, parseHostMessage, parseWebviewMessage } from '../../src/core/protocol';
import { snapshotOf, viewRow } from '../support/builders';
import { must } from '../support/fixtures';

type Json = Record<string, unknown>;

function validMessage(): Json {
  const snapshot = snapshotOf(
    [
      viewRow('/ws/src/a.ts'),
      viewRow('/ws/src/b.ts', { role: 'referenced', source: null, refCount: 5, badge: '×5 refs', tooltip: 'Referenced 5× by a.ts', intensity: 0.5124, shake: { amp: 2.29, dur: 109, rot: 0.71 } }),
    ],
    { seq: 7, colors: { edited: '#112233', referenced: '' } },
  );
  return { type: 'snapshot', snapshot: JSON.parse(JSON.stringify(snapshot)) as Json };
}

/** Deep clone then apply `mutate` and return the message. */
interface Mutable {
  snapshot: Json & { rows: Json[]; colors: Json };
}
function mutated(mutate: (m: Mutable) => void): unknown {
  const m = validMessage() as unknown as Mutable;
  mutate(m);
  return m;
}
/** Untyped view of the snapshot so tests may delete or retype required fields. */
const loose = (m: Mutable): Json => m.snapshot;

describe('PROTOCOL_VERSION', () => {
  it('is 1', () => assert.equal(PROTOCOL_VERSION, 1));
});

describe('parseHostMessage: valid input', () => {
  it('accepts a well-formed snapshot and returns an equal structure', () => {
    const msg = validMessage();
    const parsed = parseHostMessage(msg);
    assert.ok(parsed);
    assert.equal(parsed.type, 'snapshot');
    assert.deepEqual(parsed.snapshot, msg['snapshot']);
  });

  it('accepts an empty row list, enabled=false, animate=false', () => {
    const parsed = parseHostMessage({ type: 'snapshot', snapshot: { v: 1, seq: 0, enabled: false, animate: false, colors: { edited: '', referenced: '' }, rows: [] } });
    assert.ok(parsed);
    assert.equal(parsed.snapshot.rows.length, 0);
    assert.equal(parsed.snapshot.enabled, false);
  });

  it('accepts exactly 500 rows and rejects 501', () => {
    const row = JSON.parse(JSON.stringify(viewRow('/ws/a.ts'))) as Json;
    const make = (n: number): unknown => ({
      type: 'snapshot',
      snapshot: { v: 1, seq: 1, enabled: true, animate: true, colors: { edited: '', referenced: '' }, rows: Array.from({ length: n }, (_, i) => ({ ...row, id: `/ws/f${i}.ts` })) },
    });
    assert.ok(parseHostMessage(make(500)));
    assert.equal(parseHostMessage(make(501)), null);
  });

  it('accepts #rgb, #rrggbb and #rrggbbaa colours and the empty string', () => {
    for (const c of ['', '#fff', '#FFFFFF', '#3fb950', '#3fb95080']) {
      assert.ok(parseHostMessage(mutated((m) => (m.snapshot.colors['edited'] = c))), JSON.stringify(c));
    }
  });

  it('accepts hostile text in names (they are data, rendered as text later) and unicode', () => {
    const m = mutated((x) => {
      x.snapshot.rows = [{ ...(x.snapshot.rows[0] as Json), name: '<img src=x onerror=alert(1)>', dir: '"quoted" \'q\'', id: '/ws/日本語/😀.ts' }];
    });
    const parsed = parseHostMessage(m);
    assert.ok(parsed);
    assert.equal(must(parsed.snapshot.rows[0]).name, '<img src=x onerror=alert(1)>');
  });

  it('does not alias the input object (returns fresh data)', () => {
    const msg = validMessage();
    const parsed = must(parseHostMessage(msg));
    (msg['snapshot'] as Json)['seq'] = 999;
    assert.equal(parsed.snapshot.seq, 7);
  });
});

describe('parseHostMessage: malformed input -> null, never throws', () => {
  it('non-objects and wrong envelopes', () => {
    for (const bad of [undefined, null, 0, 1, '', 'snapshot', true, false, [], [validMessage()], () => 1, Symbol('x'), {}, { type: 'snapshot' }, { type: 'Snapshot', snapshot: {} }, { type: 'ready' }, { snapshot: validMessage()['snapshot'] }, { type: 'snapshot', snapshot: null }, { type: 'snapshot', snapshot: [] }, { type: 'snapshot', snapshot: 'x' }]) {
      assert.equal(parseHostMessage(bad), null, String(bad));
    }
  });

  const snapshotMutations: Array<[string, (m: Mutable) => void]> = [
    ['v is 2', (m) => (m.snapshot['v'] = 2)],
    ['v missing', (m) => delete m.snapshot['v']],
    ['v is a string', (m) => (m.snapshot['v'] = '1')],
    ['seq missing', (m) => delete m.snapshot['seq']],
    ['seq is a string', (m) => (m.snapshot['seq'] = '7')],
    ['seq is NaN', (m) => (m.snapshot['seq'] = Number.NaN)],
    ['seq is Infinity', (m) => (m.snapshot['seq'] = Number.POSITIVE_INFINITY)],
    ['enabled missing', (m) => delete m.snapshot['enabled']],
    ['enabled is 1', (m) => (m.snapshot['enabled'] = 1)],
    ['enabled is "true"', (m) => (m.snapshot['enabled'] = 'true')],
    ['animate missing', (m) => delete m.snapshot['animate']],
    ['animate is null', (m) => (m.snapshot['animate'] = null)],
    ['colors missing', (m) => delete loose(m)['colors']],
    ['colors is a string', (m) => (loose(m)['colors'] = '#fff')],
    ['colors.edited missing', (m) => delete m.snapshot.colors['edited']],
    ['colors.edited is a name', (m) => (m.snapshot.colors['edited'] = 'red')],
    ['colors.edited has 4 digits', (m) => (m.snapshot.colors['edited'] = '#ffff')],
    ['colors.edited has 5 digits', (m) => (m.snapshot.colors['edited'] = '#fffff')],
    ['colors.edited has bad hex', (m) => (m.snapshot.colors['edited'] = '#gggggg')],
    ['colors.edited is css injection', (m) => (m.snapshot.colors['edited'] = 'red; background: url(http://x)')],
    ['colors.referenced is a number', (m) => (m.snapshot.colors['referenced'] = 0xff0000)],
    ['colors.referenced missing', (m) => delete m.snapshot.colors['referenced']],
    ['rows missing', (m) => delete loose(m)['rows']],
    ['rows is an object', (m) => (loose(m)['rows'] = {})],
    ['rows is a string', (m) => (loose(m)['rows'] = 'rows')],
  ];
  for (const [label, mutate] of snapshotMutations) {
    it(label, () => assert.equal(parseHostMessage(mutated(mutate)), null));
  }

  const rowMutations: Array<[string, (row: Json) => void]> = [
    ['row is null', () => undefined], // replaced below
    ['id missing', (r) => delete r['id']],
    ['id is a number', (r) => (r['id'] = 5)],
    ['uri missing', (r) => delete r['uri']],
    ['uri is null', (r) => (r['uri'] = null)],
    ['name is undefined', (r) => (r['name'] = undefined)],
    ['name is an object', (r) => (r['name'] = { toString: 'x' })],
    ['dir is a number', (r) => (r['dir'] = 1)],
    ['badge is an array', (r) => (r['badge'] = ['x'])],
    ['tooltip is a number', (r) => (r['tooltip'] = 3)],
    ['folderPath missing', (r) => delete r['folderPath']],
    ['folderPath is a string', (r) => (r['folderPath'] = 'src/lib')],
    ['folderPath contains a number', (r) => (r['folderPath'] = ['src', 5])],
    ['folderPath contains null', (r) => (r['folderPath'] = [null])],
    ['role is unknown', (r) => (r['role'] = 'other')],
    ['role missing', (r) => delete r['role']],
    ['actor is unknown', (r) => (r['actor'] = 'robot')],
    ['actor missing', (r) => delete r['actor']],
    ['actor is null (only source may be null)', (r) => (r['actor'] = null)],
    ['phase is unknown', (r) => (r['phase'] = 'paused')],
    ['phase missing', (r) => delete r['phase']],
    ['source is unknown', (r) => (r['source'] = 'robot')],
    ['source is undefined', (r) => delete r['source']],
    ['intensity is a string', (r) => (r['intensity'] = '0.5')],
    ['intensity is NaN', (r) => (r['intensity'] = Number.NaN)],
    ['intensity is Infinity', (r) => (r['intensity'] = Number.POSITIVE_INFINITY)],
    ['intensity is negative', (r) => (r['intensity'] = -0.01)],
    ['intensity is above 1', (r) => (r['intensity'] = 1.0001)],
    ['intensity missing', (r) => delete r['intensity']],
    ['shake missing', (r) => delete r['shake']],
    ['shake is a number', (r) => (r['shake'] = 4)],
    ['shake.amp is NaN', (r) => (r['shake'] = { amp: Number.NaN, dur: 100, rot: 1 })],
    ['shake.dur is a string', (r) => (r['shake'] = { amp: 1, dur: '100', rot: 1 })],
    ['shake.rot is Infinity', (r) => (r['shake'] = { amp: 1, dur: 100, rot: Number.POSITIVE_INFINITY })],
    ['shake.rot missing', (r) => (r['shake'] = { amp: 1, dur: 100 })],
    ['refCount is a string', (r) => (r['refCount'] = '5')],
    ['refCount is NaN', (r) => (r['refCount'] = Number.NaN)],
  ];
  for (const [label, mutate] of rowMutations) {
    it(`a row where ${label}`, () => {
      const m = mutated((x) => {
        const row = x.snapshot.rows[0] as Json;
        if (label === 'row is null') x.snapshot.rows[0] = null as unknown as Json;
        else mutate(row);
      });
      assert.equal(parseHostMessage(m), null);
    });
  }

  it('one bad row among many invalidates the whole snapshot', () => {
    const m = mutated((x) => {
      x.snapshot.rows.push({ ...(x.snapshot.rows[0] as Json), role: 'nope' });
    });
    assert.equal(parseHostMessage(m), null);
  });

  it('rows that are not objects', () => {
    for (const row of [1, 'a', [], true, undefined, null]) {
      assert.equal(parseHostMessage(mutated((x) => x.snapshot.rows.push(row as unknown as Json))), null);
    }
  });

  it('deeply nested / cyclic input does not blow the stack or throw', () => {
    const cyc: Json = { type: 'snapshot' };
    cyc['snapshot'] = cyc;
    assert.equal(parseHostMessage(cyc), null);
    const deep: Json = { type: 'snapshot', snapshot: {} };
    let cur = deep['snapshot'] as Json;
    for (let i = 0; i < 20000; i++) {
      const next: Json = {};
      cur['x'] = next;
      cur = next;
    }
    assert.equal(parseHostMessage(deep), null);
  });

  it('hostile objects (throwing getters, proxies) never make it throw', () => {
    const getter: Json = {};
    Object.defineProperty(getter, 'type', {
      get() {
        throw new Error('boom');
      },
    });
    assert.doesNotThrow(() => parseHostMessage(getter));
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error('proxy boom');
        },
        has() {
          throw new Error('proxy boom');
        },
        ownKeys() {
          throw new Error('proxy boom');
        },
      },
    );
    assert.doesNotThrow(() => parseHostMessage(proxy));
    assert.equal(parseHostMessage(proxy), null);
  });

  it('prototype-pollution style keys are harmless', () => {
    const polluted = JSON.parse('{"type":"snapshot","__proto__":{"polluted":true},"snapshot":{"v":1,"seq":1,"enabled":true,"animate":true,"colors":{"edited":"","referenced":""},"rows":[],"__proto__":{"polluted":true}}}') as unknown;
    parseHostMessage(polluted);
    assert.equal(({} as Json)['polluted'], undefined);
  });

  it('fuzz: JSON-ish garbage never throws', () => {
    let seed = 20240607;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const atoms: unknown[] = [null, undefined, 0, -1, 1, 1e308, Number.NaN, '', 'x', true, false, [], {}, 'snapshot', 'ready', 'open'];
    const gen = (depth: number): unknown => {
      const r = rnd();
      if (depth <= 0 || r < 0.4) return atoms[Math.floor(rnd() * atoms.length)];
      if (r < 0.7) return Array.from({ length: Math.floor(rnd() * 4) }, () => gen(depth - 1));
      const o: Json = {};
      for (const k of ['type', 'snapshot', 'v', 'seq', 'rows', 'colors', 'enabled', 'animate', 'id', 'message']) if (rnd() < 0.5) o[k] = gen(depth - 1);
      return o;
    };
    for (let i = 0; i < 2000; i++) {
      const v = gen(4);
      assert.doesNotThrow(() => parseHostMessage(v));
      assert.doesNotThrow(() => parseWebviewMessage(v));
    }
  });
});

describe('parseWebviewMessage', () => {
  it('ready', () => assert.deepEqual(parseWebviewMessage({ type: 'ready' }), { type: 'ready' }));

  it('open carries the id verbatim (it is only ever a lookup key on the host)', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'open', id: '/ws/a.ts' }), { type: 'open', id: '/ws/a.ts' });
    assert.deepEqual(parseWebviewMessage({ type: 'open', id: 'file:///etc/passwd' }), { type: 'open', id: 'file:///etc/passwd' });
  });

  it('open without a string id is rejected', () => {
    for (const bad of [{ type: 'open' }, { type: 'open', id: 5 }, { type: 'open', id: null }, { type: 'open', id: {} }, { type: 'open', id: ['a'] }]) {
      assert.equal(parseWebviewMessage(bad), null, JSON.stringify(bad));
    }
  });

  it('error messages pass through and are truncated to 500 characters', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'error', message: 'boom' }), { type: 'error', message: 'boom' });
    const exactly = 'x'.repeat(500);
    assert.equal((parseWebviewMessage({ type: 'error', message: exactly }) as { message: string }).message.length, 500);
    const long = parseWebviewMessage({ type: 'error', message: 'y'.repeat(100_000) }) as { type: string; message: string };
    assert.equal(long.type, 'error');
    assert.equal(long.message.length, 500);
    assert.ok(long.message.split('').every((c) => c === 'y'));
  });

  it('error without a string message is rejected', () => {
    for (const bad of [{ type: 'error' }, { type: 'error', message: 5 }, { type: 'error', message: null }]) {
      assert.equal(parseWebviewMessage(bad), null, JSON.stringify(bad));
    }
  });

  it('unknown types and non-objects are rejected', () => {
    for (const bad of [undefined, null, 0, '', 'ready', true, [], [{ type: 'ready' }], {}, { type: 'READY' }, { type: 'snapshot' }, { type: 'exec', cmd: 'rm -rf /' }, { type: 5 }]) {
      assert.equal(parseWebviewMessage(bad), null, String(bad));
    }
  });
});
