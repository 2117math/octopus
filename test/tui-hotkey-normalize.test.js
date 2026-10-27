// 단축키는 한/영·Shift 상태와 상관없이 먹는다(원장 2026-10-27).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHotkey } from '../src/tui.js';

test('normalizeHotkey: 두벌식 자모는 그 자리의 영문 소문자로', () => {
  assert.equal(normalizeHotkey('ㄱ'), 'r');
  assert.equal(normalizeHotkey('ㄲ'), 'r');
  assert.equal(normalizeHotkey('ㅂ'), 'q');
  assert.equal(normalizeHotkey('ㄹ'), 'f');
  assert.equal(normalizeHotkey('ㅎ'), 'g');
  assert.equal(normalizeHotkey('ㅌ'), 'x');
  assert.equal(normalizeHotkey('ㅡ'), 'm');
});

test('normalizeHotkey: 대문자는 소문자로, 그 밖은 그대로', () => {
  assert.equal(normalizeHotkey('R'), 'r');
  assert.equal(normalizeHotkey('Q'), 'q');
  assert.equal(normalizeHotkey('r'), 'r');
  assert.equal(normalizeHotkey('up'), 'up');
  assert.equal(normalizeHotkey('esc'), 'esc');
  assert.equal(normalizeHotkey(' '), ' ');
});
