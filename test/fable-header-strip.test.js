// Opus 응답에서 Fable 주간 헤더를 빼는지(원장 2026-10-27).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isForeignFableQuotaHeader as drop } from '../src/server.js';

test('Opus 요청: 7d_oi 헤더와 seven_day_oi representative-claim 은 뺀다', () => {
  assert.equal(drop('anthropic-ratelimit-unified-7d_oi-status', 'rejected', 'claude-opus-5-5'), true);
  assert.equal(drop('Anthropic-Ratelimit-Unified-7d_oi-Utilization', '1.0', 'claude-opus-5-5'), true);
  assert.equal(drop('anthropic-ratelimit-unified-representative-claim', 'seven_day_oi', 'claude-opus-5-5'), true);
});

test('Opus 요청: 5h·7d·전체 상태는 그대로', () => {
  assert.equal(drop('anthropic-ratelimit-unified-5h-utilization', '0.3', 'claude-opus-5-5'), false);
  assert.equal(drop('anthropic-ratelimit-unified-7d-utilization', '0.4', 'claude-opus-5-5'), false);
  assert.equal(drop('anthropic-ratelimit-unified-status', 'allowed', 'claude-opus-5-5'), false);
  assert.equal(drop('anthropic-ratelimit-unified-representative-claim', 'five_hour', 'claude-opus-5-5'), false);
});

test('Fable 요청: 아무것도 빼지 않는다', () => {
  assert.equal(drop('anthropic-ratelimit-unified-7d_oi-status', 'allowed', 'claude-fable-5-1'), false);
  assert.equal(drop('anthropic-ratelimit-unified-representative-claim', 'seven_day_oi', 'claude-fable-5-1'), false);
});

test('모델 이름을 모르면 아무것도 빼지 않는다', () => {
  assert.equal(drop('anthropic-ratelimit-unified-7d_oi-status', 'rejected', 'x'), false);
  assert.equal(drop('anthropic-ratelimit-unified-7d_oi-status', 'rejected', null), false);
});
