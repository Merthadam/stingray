import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityVisibility } from '../../electron/core/activity';

function setup(focused = true) {
  const acks: [string, string, number][] = [];
  let visible = focused;
  const v = new ActivityVisibility({ terminals: { list: () => [{ id: 't1' }, { id: 't2' }] },
    activity: { acknowledge: (id, terminalId, revision) => { acks.push([id, terminalId, revision]); } }, isWindowFocusedAndVisible: () => visible });
  return { v, acks, setFocused: (f: boolean) => { visible = f; } };
}

test('unknown terminal ids are ignored; acknowledge needs a focused, visible window and a visible terminal; reset clears', () => {
  const s = setup();
  s.v.setVisible(['t1', 'unknown']);
  s.v.acknowledge('a', 'unknown', 1);
  s.v.acknowledge('a', 't2', 1);
  s.v.acknowledge('a', 't1', 1);
  assert.deepEqual(s.acks, [['a', 't1', 1]]);
  s.setFocused(false); s.v.acknowledge('a', 't1', 2);
  assert.equal(s.acks.length, 1);
  s.setFocused(true); s.v.reset(); s.v.acknowledge('a', 't1', 3);
  assert.equal(s.acks.length, 1);
});
