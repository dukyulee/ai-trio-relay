import test from 'node:test';
import assert from 'node:assert/strict';
import { PRECISION, assertNumber } from '../src/types.js';

test('계약: PRECISION은 2', () => {
  assert.equal(PRECISION, 2);
});

test('계약: assertNumber는 숫자가 아니면 던진다', () => {
  assert.throws(() => assertNumber('1', 'a'), TypeError);
  assert.throws(() => assertNumber(Infinity, 'a'), TypeError);
  assert.doesNotThrow(() => assertNumber(1.5, 'a'));
});
