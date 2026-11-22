/**
 * 整场经济模拟：不碰浏览器，直接把「轮庄 → 下注 → 发牌 → 要牌 → 结算 → 换庄」跑成百上千场
 *
 * 这层测试抓的是浏览器探针抓不到的东西：
 *   · 庄池会不会被赔成负数
 *   · 筹码在「庄池 ↔ 各家」之间搬来搬去之后还守恒吗
 *   · 整场会不会不收敛
 *   · 「输光下庄」到底会不会真的发生（实测只占 1%，见下）
 *
 * 随机数用固定种子，失败可复现。
 *
 * 关于局数上限（曾经写死 4000 导致 2 人局误报「不收敛」）：
 * 2 人局的筹码转移是标准赌徒破产过程，期望局数约为 n₁·n₁ / 每局单位注，
 * 50 对 50、每局动 1–3 枚时，实测中位数 1400 局、最长 13716 局。
 * 所以 2 人局的 guard 必须是 20000，4 人局几百局内就有人出局。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../js/rules.js');
const M = require('../js/match.js');
const P = require('../js/params.js');

/** mulberry32：小而稳的可复现 PRNG */
function rngFrom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function freshDeck() {
  const suits = ['spade', 'heart', 'club', 'diamond'];
  const out = [];
  for (const s of suits) for (let r = 2; r <= 14; r++) out.push({ rank: r, suit: s });
  return out;
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 一手牌打到停：真人策略也用 AI 策略代替（这层只验经济，不验策略） */
function playHand(deck) {
  const hand = [deck.pop(), deck.pop()];
  while (R.aiPlayerShouldHit(hand)) {
    if (!deck.length) break;
    hand.push(deck.pop());
  }
  return hand;
}

/** 每局开始前按 game.js 的口径补牌：不足 RESHUFFLE_AT 就整副重洗 */
function readyDeck(deck, rng) {
  return deck.length < P.RESHUFFLE_AT ? shuffle(freshDeck(), rng) : deck;
}

/**
 * 打一整场。
 * @param cap 局数上限（2 人局要放大，见文件头注释）
 * @returns {{reason:string|null, stats:object, m:object}} reason=null 表示撞到 cap 仍未结束
 */
function simulateMatch(count, mode, rng, cap) {
  const m = M.create(count, mode);
  assert.equal(M.beginTenure(m), true, '开局上庄应当成功');

  const totalAtStart = m.players.reduce((s, p) => s + p.chips, 0) + m.bank;
  let deck = shuffle(freshDeck(), rng);
  let guard = 0;

  const stats = { rounds: 0, tenures: 1, maxBank: 0, minBank: 0, winOut: 0, loseOut: 0 };

  while (guard < cap) {
    guard += 1;
    deck = readyDeck(deck, rng);

    /* 下注：1..cap 之间随机，绝不超过三档上限，也绝不超自己筹码 */
    const entries = M.playerSeats(m).map((seat) => {
      const p = m.players[seat];
      const bcap = M.betCap(p);
      assert.ok(bcap >= 1, `闲家 ${p.name} 筹码 ${p.chips} 却仍需下注`);
      const bet = 1 + Math.floor(rng() * Math.min(3, bcap));
      assert.ok(bet >= 1 && bet <= 3, '下注必须在 1–3 档内');
      return { seat, bet, cards: playHand(deck) };
    });

    const dealerCards = playHand(deck);
    const bankBefore = m.bank;
    const out = R.settleRound(dealerCards, entries, bankBefore);

    assert.ok(out.bank >= 0, `庄池被赔成负数：${out.bank}`);
    assert.ok(out.bank <= bankBefore + 3 * m.count * 3 + 40, `庄池异常膨胀：${out.bank}`);

    m.bank = out.bank;
    for (const r of out.results) m.players[r.seat].chips += r.amount;
    m.rounds += 1;
    stats.rounds += 1;
    stats.maxBank = Math.max(stats.maxBank, m.bank);
    stats.minBank = Math.min(stats.minBank, m.bank);

    /* 每一步都必须守恒：所有人的筹码 + 庄池 = 开局总量 */
    const total = m.players.reduce((s, p) => s + p.chips, 0) + m.bank;
    assert.equal(total, totalAtStart, `第 ${stats.rounds} 局后筹码不守恒`);

    if (R.bankerShouldLeave(m.bank)) {
      const bank = m.bank;
      if (bank === 0) stats.loseOut += 1; else stats.winOut += 1;
      M.endTenure(m);
      assert.equal(m.bank, 0, '下庄后庄池应归零');
      assert.ok(bank === 0 || bank >= P.BANK + P.BANK_WIN, '下庄只应发生在输光或赢够时');

      const next = M.nextSeat(m, m.dealerIdx);
      const reason = M.endReason(m, next);
      if (reason) return { reason, stats, m };
      assert.equal(M.rotate(m), next);
      assert.equal(M.beginTenure(m), true, '换了庄却上不了庄');
      stats.tenures += 1;
    } else {
      const reason = M.endReason(m, null);
      if (reason) return { reason, stats, m };
    }
  }

  return { reason: null, stats, m };
}

test('整场模拟：3 人 200 场，全部收敛、筹码守恒、庄池不为负', () => {
  const reasons = {};
  let rounds = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const { reason, stats } = simulateMatch(3, 'ai', rngFrom(seed), 4000);
    assert.ok(reason, '3 人局应当在 4000 局内结束');
    reasons[reason] = (reasons[reason] || 0) + 1;
    rounds += stats.rounds;
  }
  assert.ok(reasons.broke > 0, '应当出现「有人筹码归零」的结束方式');
  assert.ok(reasons.cannot_bank > 0, '应当出现「下一任庄家上不了庄」的结束方式');
  assert.ok(rounds > 200, '平均每场至少一局');
});

test('整场模拟：4 人 60 场收敛', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const { reason, stats } = simulateMatch(4, 'local', rngFrom(seed * 7 + 4), 4000);
    assert.ok(reason === 'broke' || reason === 'cannot_bank', `4 人局异常结束原因：${reason}`);
    assert.ok(stats.rounds >= 1);
  }
});

test('整场模拟：2 人 20 场收敛（破产过程长，guard 放到 20000）', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const { reason, stats } = simulateMatch(2, 'local', rngFrom(seed * 7 + 2), 20000);
    assert.ok(reason === 'broke' || reason === 'cannot_bank', `2 人局异常结束原因：${reason}`);
    assert.ok(stats.rounds >= 1);
  }
});

test('下庄条件覆盖：赢够下庄占多数，输光下庄真的会发生', () => {
  let winOut = 0;
  let loseOut = 0;
  let tenures = 0;

  for (let seed = 1; seed <= 2000; seed++) {
    const rng = rngFrom(seed * 13);
    const m = M.create(3, 'ai');
    M.beginTenure(m);
    let deck = shuffle(freshDeck(), rng);
    tenures += 1;

    for (let guard = 0; guard < 500; guard++) {
      deck = readyDeck(deck, rng);
      const entries = M.playerSeats(m).map((seat) => ({
        seat, bet: 1 + Math.floor(rng() * 3), cards: playHand(deck)
      }));
      const out = R.settleRound(playHand(deck), entries, m.bank);
      assert.ok(out.bank >= 0, `庄池被赔成负数：${out.bank}`);
      m.bank = out.bank;
      for (const r of out.results) m.players[r.seat].chips += r.amount;

      if (R.bankerShouldLeave(m.bank)) {
        if (m.bank === 0) loseOut++; else winOut++;
        break;
      }
    }
  }

  assert.equal(winOut + loseOut, tenures, '每一任庄都必须以下庄收场（500 局内）');
  assert.ok(winOut > 0, '应当出现「赢够 20 下庄」');
  assert.ok(loseOut > 0, '应当出现「庄池输光下庄」');
  assert.ok(winOut > loseOut, '同点归庄 → 庄家应当明显更容易赢够下庄');
  /* 实测约 99% / 1%，比例剧烈变化说明比牌或赔付口径被动过了 */
  assert.ok(loseOut / tenures < 0.1, `输光下庄占比异常偏高：${(loseOut / tenures * 100).toFixed(1)}%`);
});

test('庄家优势：单局净收益为正（同点归庄的直接后果，也是「赢够下庄」占多数的原因）', () => {
  const rng = rngFrom(99);
  let deck = shuffle(freshDeck(), rng);
  const N = 8000;
  let sum = 0;

  for (let i = 0; i < N; i++) {
    deck = readyDeck(deck, rng);
    const entries = [1, 2, 3].map((k) => ({ seat: k, bet: 2, cards: playHand(deck) }));
    const out = R.settleRound(playHand(deck), entries, 1000000);   // 庄池放到无限大，只测口径
    sum += out.bankDelta;
  }

  const mean = sum / N;
  /* 3 人各下 2、总注 6，实测约 +1.5 筹码/局（≈ 25%） */
  assert.ok(mean > 0.5, `庄家单局净收益应当为正，实测 ${mean.toFixed(3)}`);
});
