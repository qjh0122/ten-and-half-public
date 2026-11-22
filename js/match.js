/**
 * 十点半 · 一局（一场）的经济与轮庄（纯逻辑，零 DOM）
 *
 * 一场 = 若干「任庄」；一任庄 = 若干局牌。
 *   · 每人起手 START_CHIPS
 *   · 坐庄时从自己筹码里拿出 BANK 当庄池
 *   · 庄池输到 0 或赢到 BANK+BANK_WIN → 下庄，池子归自己
 *   · 有人筹码 ≤ 0，或轮到谁坐庄但筹码不够 BANK → 整场结束
 *
 * 这里只管「钱怎么进怎么出、庄怎么换」，牌怎么打由 rules.js 与 game.js 管。
 * 全部函数接收并返回纯数据，Node 可直接跑单测复算。
 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./params.js'));
  } else {
    global.Match = factory(global.PARAMS);
  }
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  var NAMES_AI = ['你', '电脑 A', '电脑 B', '电脑 C'];
  var NAMES_LOCAL = ['玩家 1', '玩家 2', '玩家 3', '玩家 4'];

  /** 造一场：mode = 'ai' | 'local' */
  function create(count, mode) {
    var n = Math.max(P.MIN_SEATS, Math.min(P.MAX_SEATS, count | 0));
    var names = (mode === 'local') ? NAMES_LOCAL : NAMES_AI;
    var players = [];
    for (var i = 0; i < n; i++) {
      players.push({
        i: i,
        name: names[i] || ('玩家 ' + (i + 1)),
        isAI: (mode !== 'local') && i > 0,   // 人机模式：只有 0 号位是真人
        chips: P.START_CHIPS
      });
    }
    return {
      mode: (mode === 'local') ? 'local' : 'ai',
      count: n,
      players: players,
      dealerIdx: 0,
      bank: 0,
      rounds: 0,
      tenures: 0
    };
  }

  /** 坐庄：从庄家筹码扣 BANK 进庄池。调用方负责先确认筹码够。 */
  function beginTenure(m) {
    var d = m.players[m.dealerIdx];
    if (d.chips < P.BANK) return false;
    d.chips -= P.BANK;
    m.bank = P.BANK;
    m.tenures += 1;
    return true;
  }

  /** 下庄：庄池归庄家（可能 0，也可能一把赚满） */
  function endTenure(m) {
    var d = m.players[m.dealerIdx];
    d.chips += m.bank;
    m.bank = 0;
  }

  /** 庄家的下一个座位 */
  function nextSeat(m, idx) {
    return (idx + 1) % m.count;
  }

  /** 换庄（调用前应先 endTenure） */
  function rotate(m) {
    m.dealerIdx = nextSeat(m, m.dealerIdx);
    return m.dealerIdx;
  }

  /** 从庄家下家开始，按座位顺序列出闲家下标 */
  function playerSeats(m) {
    var out = [];
    for (var k = 1; k < m.count; k++) out.push((m.dealerIdx + k) % m.count);
    return out;
  }

  /**
   * 整场是否结束。
   * @param nextDealer 下一任庄家的座位；传 null 表示「庄家继续坐庄」，此时不查上庄能力
   *        （庄家已经把钱放进庄池，手上的筹码本来就少于上庄注）
   * @returns null | 'broke'（有人筹码 ≤0） | 'cannot_bank'（下一任庄家不够上庄）
   */
  function endReason(m, nextDealer) {
    for (var i = 0; i < m.count; i++) {
      if (m.players[i].chips <= 0) return 'broke';
    }
    if (nextDealer == null) return null;
    if (m.players[nextDealer].chips < P.BANK) return 'cannot_bank';
    return null;
  }

  /** 闲家本局可下注的上限：不超过档位上限，也不超过自己筹码 */
  function betCap(player) {
    var top = P.BET_TIERS[P.BET_TIERS.length - 1];
    return Math.max(0, Math.min(top, player.chips));
  }

  /** 按筹码排名（并列同名次） */
  function ranking(m) {
    var list = m.players.map(function (p) {
      return { i: p.i, name: p.name, chips: p.chips, isAI: p.isAI };
    });
    list.sort(function (a, b) { return b.chips - a.chips; });
    return list;
  }

  return {
    NAMES_AI: NAMES_AI,
    NAMES_LOCAL: NAMES_LOCAL,
    create: create,
    beginTenure: beginTenure,
    endTenure: endTenure,
    nextSeat: nextSeat,
    rotate: rotate,
    playerSeats: playerSeats,
    endReason: endReason,
    betCap: betCap,
    ranking: ranking
  };
});
