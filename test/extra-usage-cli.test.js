// 추가 사용(번들) 켜기/끄기 — `octopus extra` 가 잠금 안에서 부르는 setExtraUsage (원장 2026-10-30).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setExtraUsage, ConfigOpError } from '../src/config-ops.js';

function makeConfig() {
  return {
    accounts: [
      { name: 'mimath0626@gmail.com', type: 'oauth', accessToken: 't1' },
      { name: '2117math@gmail.com', type: 'oauth', accessToken: 't2' },
      { name: 'bluejin911@gmail.com', type: 'oauth', accessToken: 't3', allowExtraUsage: true },
      { name: 'ai01@2117academy.com', type: 'oauth', source: 'placeholder', placeholder: true, pendingPlan: true, disabled: true },
      { name: 'key', type: 'apikey', apiKey: 'sk-x' },
    ],
  };
}
const flags = c => c.accounts.map(a => a.allowExtraUsage);

test('setExtraUsage all on: 결제 전 빈 줄·API 키 줄은 건너뛰고 나머지는 true', () => {
  const c = makeConfig();
  const r = setExtraUsage(c, 'all', true);
  assert.deepEqual(r.changed, ['mimath0626@gmail.com', '2117math@gmail.com', 'bluejin911@gmail.com']);
  assert.deepEqual(r.skipped, ['ai01@2117academy.com', 'key']);
  assert.deepEqual(flags(c), [true, true, true, undefined, undefined]);
});

test('setExtraUsage 이름 하나 · 짧은 이름(도메인 없이) · 쉼표로 여럿', () => {
  const c = makeConfig();
  assert.deepEqual(setExtraUsage(c, '2117math@gmail.com', true), { changed: ['2117math@gmail.com'], skipped: [] });
  assert.deepEqual(flags(c), [undefined, true, true, undefined, undefined]);
  assert.deepEqual(setExtraUsage(c, 'mimath0626', true).changed, ['mimath0626@gmail.com']);
  assert.equal(c.accounts[0].allowExtraUsage, true);
  const c2 = makeConfig();
  assert.deepEqual(setExtraUsage(c2, 'mimath0626, 2117math', true).changed, ['mimath0626@gmail.com', '2117math@gmail.com']);
});

test('setExtraUsage off 는 키를 지운다(없는 키 = 끔)', () => {
  const c = makeConfig();
  const r = setExtraUsage(c, 'bluejin911', false);
  assert.deepEqual(r, { changed: ['bluejin911@gmail.com'], skipped: [] });
  assert.equal('allowExtraUsage' in c.accounts[2], false);
  setExtraUsage(c, 'all', true);
  setExtraUsage(c, 'all', false);
  assert.ok(c.accounts.every(a => !('allowExtraUsage' in a)));
});

test('setExtraUsage 모르는 이름·빈 이름·on/off 아님은 ConfigOpError, 아무것도 안 바뀜', () => {
  const c = makeConfig();
  assert.throws(() => setExtraUsage(c, 'nobody', true), ConfigOpError);
  assert.throws(() => setExtraUsage(c, 'mimath0626,nobody', true), ConfigOpError);
  assert.deepEqual(flags(c), [undefined, undefined, true, undefined, undefined], '중간에 실패하면 앞 이름도 안 바뀜');
  assert.throws(() => setExtraUsage(c, '', true), ConfigOpError);
  assert.throws(() => setExtraUsage(c, 'all', 'on'), ConfigOpError);
});

test('setExtraUsage 이름만 넣은 줄(placeholder)을 직접 이름으로 골라도 건너뜀', () => {
  const c = makeConfig();
  assert.deepEqual(setExtraUsage(c, 'ai01', true), { changed: [], skipped: ['ai01@2117academy.com'] });
  assert.equal(c.accounts[3].allowExtraUsage, undefined);
});

test('setExtraUsage 짧은 이름이 둘에 맞으면 거부', () => {
  const c = makeConfig();
  c.accounts.push({ name: 'mimath0626@other.com', type: 'oauth', accessToken: 't9' });
  assert.throws(() => setExtraUsage(c, 'mimath0626', true), /2개에 맞습니다/);
});
