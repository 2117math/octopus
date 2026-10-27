// 클라이언트 사용량 조회(/api/oauth/usage)를 풀 계정 기준으로 답할 계정 고르기(원장 2026-10-27).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickUsageAccount } from '../src/server.js';

const a = (name, quota, extra = {}) => ({ name, index: 0, type: 'oauth', credential: 't', status: 'active', quota, ...extra });

test('5시간·주간·Fable 중 가장 높은 값이 가장 낮은 계정을 고른다', () => {
  const pick = pickUsageAccount([
    a('spent-fable', { unified5h: 0.1, unified7d: 0.2, unified7dFable: 1 }),
    a('hot-5h', { unified5h: 0.99, unified7d: 0.1, unified7dFable: 0.1 }),
    a('roomy', { unified5h: 0.4, unified7d: 0.5, unified7dFable: 0.3 }),
  ]);
  assert.equal(pick.name, 'roomy');
});

test('끈 계정·오류 계정·API 키 계정은 고르지 않는다', () => {
  const pick = pickUsageAccount([
    a('off', {}, { disabled: true }),
    a('err', {}, { status: 'error' }),
    a('key', {}, { type: 'apikey' }),
    a('ok', { unified5h: 0.9 }),
  ]);
  assert.equal(pick.name, 'ok');
  assert.equal(pickUsageAccount([a('off', {}, { disabled: true })]), null);
});
