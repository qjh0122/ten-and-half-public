/**
 * 规则与轮庄的单测 —— 期望值全部按用户口述规则手算，不引用被测常量
 *
 * 手牌口径：A=1，2–10 面值，J/Q/K=0.5，超过 10.5 爆。
 * 五张牌型：
 *   8 + A + K + Q + J = 10.5   → 五张十点半（赢 6 倍）
 *   4 + 2 + A + A + A = 9      → 五张不爆（赢 3 倍）
 *   3 + 2 + A + A + A = 8      → 五张不爆、点数小
 *   4 + 3 + 3 + 2 + 2 = 14     → 五张爆（输 3 倍）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../js/rules.js');
const M = require('../js/match.js');

const c = (rank, suit) => ({ rank, suit: suit || 'spade' });

/* --------- 固定手牌 --------- */
const P_TEN_HALF = [c(10), c(13)];                 // 10.5
const P_NINE = [c(6), c(3)];                       // 9
const P_EIGHT = [c(5), c(3)];                      // 8
const P_BUST = [c(10), c(5)];                      // 15
const P_TWELVE = [c(10), c(2)];                    // 12
const FIVE_TH = [c(8), c(14), c(13), c(12), c(11)];   // 10.5 / 5 张
const FIVE_NINE = [c(4), c(2), c(14), c(14), c(14)];  // 9 / 5 张
const FIVE_EIGHT = [c(3), c(2), c(14), c(14), c(14)]; // 8 / 5 张
const FIVE_BUST = [c(4), c(3), c(3), c(2), c(2)];     // 14 / 5 张

test('点数口径：A=1，2–10 面值，J/Q/K=0.5', () => {
  assert.equal(R.cardPoints(c(14)), 1);
  assert.equal(R.cardPoints(c(10)), 10);
  assert.equal(R.cardPoints(c(2)), 2);
  assert.equal(R.cardPoints(c(11)), 0.5);
  assert.equal(R.cardPoints(c(12)), 0.5);
  assert.equal(R.cardPoints(c(13)), 0.5);
  assert.equal(R.points([c(10), c(13)]), 10.5);
  assert.equal(R.points([c(13), c(12), c(11)]), 1.5);
});

test('爆牌线：超过 10.5 才爆，10.5 本身不爆', () => {
  assert.equal(R.isBust([c(10), c(13)]), false);
  assert.equal(R.isBust([c(10), c(14)]), true);        // 11
  assert.equal(R.isTenHalf([c(10), c(13)]), true);
  assert.equal(R.isTenHalf([c(10), c(14)]), false);
});

test('能不能继续要牌：爆了或满 5 张都不能', () => {
  assert.equal(R.canHit([c(2), c(3)]), true);
  assert.equal(R.canHit([c(10), c(5)]), false);        // 已爆
  assert.equal(R.canHit(FIVE_NINE), false);            // 已满 5 张
  assert.equal(R.canHit([c(2), c(3), c(2), c(3)]), true);
});

test('点数 ≤ 6 必须继续要牌：2 + J = 2.5 不许停', () => {
  const hand = [c(2), c(11)];                          // 用户实测到的漏洞
  assert.equal(R.points(hand), 2.5);
  assert.equal(R.mustHit(hand), true);
  assert.equal(R.canStand(hand), false);
});

test('强制要牌的分界：6 点必须继续，6.5 才能停', () => {
  assert.equal(R.points([c(5), c(14)]), 6);
  assert.equal(R.mustHit([c(5), c(14)]), true);
  assert.equal(R.canStand([c(5), c(14)]), false);

  assert.equal(R.points([c(6), c(11)]), 6.5);
  assert.equal(R.mustHit([c(6), c(11)]), false);
  assert.equal(R.canStand([c(6), c(11)]), true);
});

test('强制要牌的两个豁免：已爆、已满 5 张', () => {
  assert.equal(R.mustHit(P_BUST), false);              // 已爆，停得下来
  assert.equal(R.canStand(P_BUST), true);

  const fiveLow = [c(14), c(14), c(14), c(14), c(2)];  // 5 张 6 点：想停也停不了牌，只能停
  assert.equal(R.points(fiveLow), 6);
  assert.equal(R.mustHit(fiveLow), false);
  assert.equal(R.canStand(fiveLow), true);
});

test('电脑也受强制要牌约束：2.5 点必须继续', () => {
  assert.equal(R.aiPlayerShouldHit([c(2), c(11)]), true);
  assert.equal(R.aiDealerShouldHit([c(2), c(11)]), true);
});

test('比点：闲家大则赢，小则输', () => {
  const win = R.compare(P_NINE, P_EIGHT);
  assert.equal(win.win, true);
  assert.equal(win.mult, 1);
  assert.equal(win.reason, 'points');

  const lose = R.compare(P_EIGHT, P_NINE);
  assert.equal(lose.win, false);
  assert.equal(lose.mult, -1);
});

test('同点庄最大：9 对 9 闲家输', () => {
  const r = R.compare(P_NINE, P_NINE);
  assert.equal(r.win, false);
  assert.equal(r.mult, -1);
  assert.equal(r.reason, 'dealer_tie');
});

test('都是十点半庄最大，且庄家十点半翻倍', () => {
  const r = R.compare(P_TEN_HALF, P_TEN_HALF);
  assert.equal(r.win, false);
  assert.equal(r.mult, -2);
  assert.equal(r.reason, 'both_ten_half');
});

test('都爆了庄最大（两张对两张，不涉及五张罚则）', () => {
  const r = R.compare(P_BUST, P_TWELVE);
  assert.equal(r.win, false);
  assert.equal(r.mult, -1);
  assert.equal(r.reason, 'both_bust');
});

test('庄家爆牌，闲家不爆则赢', () => {
  const r = R.compare(P_EIGHT, P_BUST);
  assert.equal(r.win, true);
  assert.equal(r.mult, 1);
  assert.equal(r.reason, 'dealer_bust');
});

test('闲家普通十点半只算比点，不额外加赔率', () => {
  const r = R.compare(P_TEN_HALF, P_NINE);
  assert.equal(r.win, true);
  assert.equal(r.mult, 1);
  assert.equal(r.reason, 'ten_half');
});

test('闲家五张不爆 → 赢 3 倍', () => {
  const r = R.compare(FIVE_NINE, P_EIGHT);
  assert.equal(r.win, true);
  assert.equal(r.mult, 3);
  assert.equal(r.pFull, true);
});

test('闲家五张且十点半 → 赢 6 倍', () => {
  const r = R.compare(FIVE_TH, P_EIGHT);
  assert.equal(r.win, true);
  assert.equal(r.mult, 6);
});

test('闲家五张爆 → 输 3 倍', () => {
  const r = R.compare(FIVE_BUST, P_EIGHT);
  assert.equal(r.win, false);
  assert.equal(r.mult, -3);
  assert.equal(r.reason, 'five_bust');
});

test('五张爆 + 庄也爆：仍按五张罚则输 3 倍', () => {
  const r = R.compare(FIVE_BUST, P_BUST);
  assert.equal(r.win, false);
  assert.equal(r.mult, -3);
  assert.equal(r.reason, 'both_bust');
});

test('五张不爆遇到庄家十点半：输 2 倍（庄家翻倍优先于闲家牌型）', () => {
  const r = R.compare(FIVE_NINE, P_TEN_HALF);
  assert.equal(r.win, false);
  assert.equal(r.mult, -2);
  assert.equal(r.reason, 'dealer_ten_half');
});

test('五张十点半遇到庄家十点半：庄大，输 2 倍', () => {
  const r = R.compare(FIVE_TH, P_TEN_HALF);
  assert.equal(r.win, false);
  assert.equal(r.mult, -2);
});

test('五张不爆但同点：庄大，只输本金（牌型奖励只在赢时生效）', () => {
  const r = R.compare(FIVE_EIGHT, P_EIGHT);
  assert.equal(r.win, false);
  assert.equal(r.mult, -1);
  assert.equal(r.reason, 'dealer_tie');
});

test('全场结算：赢的从庄池出，输的进庄池', () => {
  const out = R.settleRound(P_EIGHT, [
    { seat: 1, bet: 3, cards: P_TEN_HALF },
    { seat: 2, bet: 2, cards: P_BUST }
  ], 20);

  assert.equal(out.results[0].amount, 3);      // 赢 3 倍 × 注 1？不：普通十点半 ×1
  assert.equal(out.results[1].amount, -2);
  assert.equal(out.bank, 19);                  // 20 − 3 + 2
  assert.equal(out.bankDelta, -1);
});

test('全场结算：庄池赔穿时只赔到 0，且标记 shortPaid', () => {
  const out = R.settleRound(P_EIGHT, [
    { seat: 1, bet: 3, cards: FIVE_TH }        // 应赔 18，庄池只有 3
  ], 3);

  assert.equal(out.results[0].amount, 3);
  assert.equal(out.results[0].shortPaid, true);
  assert.equal(out.bank, 0);
});

test('庄家下庄条件：输完（0）或赢够（比上庄多 20）', () => {
  assert.equal(R.bankerShouldLeave(19), false);
  assert.equal(R.bankerShouldLeave(20), false);
  assert.equal(R.bankerShouldLeave(39), false);
  assert.equal(R.bankerShouldLeave(0), true);
  assert.equal(R.bankerShouldLeave(40), true);
  assert.equal(R.bankerShouldLeave(41), true);
});

test('电脑 AI 决策：点数够就停，满张不开牌', () => {
  assert.equal(R.aiDealerShouldHit([c(2), c(3)]), true);        // 5 点
  assert.equal(R.aiDealerShouldHit([c(5), c(3)]), false);       // 8 点
  assert.equal(R.aiDealerShouldHit(FIVE_NINE), false);          // 满张

  assert.equal(R.aiPlayerShouldHit([c(2), c(3)]), true);        // 5 点，规则强制要
  assert.equal(R.aiPlayerShouldHit([c(5), c(3)]), false);       // 8 点，够了
  assert.equal(R.aiPlayerShouldHit([c(14), c(14), c(14), c(14)]), true);  // 4 张 4 点，必须继续
  assert.equal(R.aiPlayerShouldHit([c(2), c(2), c(2), c(14)]), false);    // 4 张 7 点，怕五张爆
});

/* ================= 轮庄与筹码经济 ================= */

test('开局：每人 50 筹码，人机模式只有 0 号位是真人', () => {
  const m = M.create(3, 'ai');
  assert.equal(m.count, 3);
  assert.deepEqual(m.players.map(p => p.chips), [50, 50, 50]);
  assert.deepEqual(m.players.map(p => p.isAI), [false, true, true]);
  assert.equal(m.dealerIdx, 0);
  assert.equal(m.bank, 0);
});

test('好友模式：全部是真人，名字是玩家 N', () => {
  const m = M.create(4, 'local');
  assert.deepEqual(m.players.map(p => p.isAI), [false, false, false, false]);
  assert.deepEqual(m.players.map(p => p.name), ['玩家 1', '玩家 2', '玩家 3', '玩家 4']);
});

test('上庄：从庄家筹码扣 20 进庄池', () => {
  const m = M.create(3, 'ai');
  assert.equal(M.beginTenure(m), true);
  assert.equal(m.players[0].chips, 30);
  assert.equal(m.bank, 20);
});

test('下庄：庄池归庄家，赢够 20 时筹码 30+40=70', () => {
  const m = M.create(3, 'ai');
  M.beginTenure(m);
  m.bank = 40;
  M.endTenure(m);
  assert.equal(m.players[0].chips, 70);
  assert.equal(m.bank, 0);
});

test('下庄：输光时筹码只剩 30（净亏 20）', () => {
  const m = M.create(3, 'ai');
  M.beginTenure(m);
  m.bank = 0;
  M.endTenure(m);
  assert.equal(m.players[0].chips, 30);
});

test('闲家座位：从庄家下家开始按顺序排', () => {
  const m = M.create(4, 'local');
  assert.deepEqual(M.playerSeats(m), [1, 2, 3]);
  m.dealerIdx = 2;
  assert.deepEqual(M.playerSeats(m), [3, 0, 1]);
});

test('轮庄：0 → 1 → 2 → 回到 0', () => {
  const m = M.create(3, 'ai');
  assert.equal(M.rotate(m), 1);
  assert.equal(M.rotate(m), 2);
  assert.equal(M.rotate(m), 0);
});

test('结束条件：有人筹码为 0 就整场结束', () => {
  const m = M.create(3, 'ai');
  m.players[2].chips = 0;
  assert.equal(M.endReason(m), 'broke');
});

test('结束条件：下一任庄家筹码不够 20 就整场结束', () => {
  const m = M.create(3, 'ai');
  m.dealerIdx = 0;
  m.players[1].chips = 19;
  assert.equal(M.endReason(m, 1), 'cannot_bank');
  m.players[1].chips = 20;
  assert.equal(M.endReason(m, 1), null);
});

test('下注上限：三档封顶，且不超过自己筹码', () => {
  assert.equal(M.betCap({ chips: 50 }), 3);
  assert.equal(M.betCap({ chips: 3 }), 3);
  assert.equal(M.betCap({ chips: 2 }), 2);
  assert.equal(M.betCap({ chips: 0 }), 0);
});

test('不变量：一整任庄打完，总筹码 + 庄池守恒', () => {
  const m = M.create(3, 'ai');
  M.beginTenure(m);
  const total = () => m.players.reduce((s, p) => s + p.chips, 0) + m.bank;
  const before = total();

  /* 庄 8 点；闲 1 下 3 压十点半赢 3；闲 2 下 2 爆牌输 2 */
  const out = R.settleRound(P_EIGHT, [
    { seat: 1, bet: 3, cards: P_TEN_HALF },
    { seat: 2, bet: 2, cards: P_BUST }
  ], m.bank);

  m.bank = out.bank;
  m.players[1].chips += out.results[0].amount;
  m.players[2].chips += out.results[1].amount;

  assert.equal(total(), before);
  assert.equal(m.players[1].chips, 53);
  assert.equal(m.players[2].chips, 48);
});
