/**
 * 十点半 · 规则内核（纯逻辑，零 DOM、零随机）
 *
 * 牌模型与六选五一致（复用 js/card.js 的 52 张牌）：
 *   card = { suit: 'spade'|'heart'|'club'|'diamond', rank: 2..14 }
 *   rank 11=J  12=Q  13=K  14=A
 *
 * 点数口径：A = 1；2–10 按面值；J/Q/K = 0.5 点；合计 > 10.5 爆牌；恰好 10.5 为十点半。
 *
 * 比牌口径（庄家优先，平局全部归庄）：
 *   ① 都爆 → 庄赢        ② 同点 → 庄赢      ③ 都是十点半 → 庄赢
 *   ④ 闲家爆 → 庄赢      ⑤ 庄家爆 → 闲赢    ⑥ 其余比点数，大者胜
 *
 * 赔付倍数：
 *   庄家十点半并获胜        → 闲家输 2 倍
 *   闲家五张不爆            → 闲家赢 3 倍
 *   闲家五张不爆且十点半    → 闲家赢 6 倍
 *   闲家五张爆              → 闲家输 3 倍（罚则优先，不再叠加庄家十点半翻倍）
 *
 * 所有函数只吃参数、不读全局，Node 与浏览器都能跑（供单测独立复算）。
 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./params.js'));
  } else {
    global.Rules = factory(global.PARAMS);
  }
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  var EPS = 1e-9;

  /** 单张牌的点数 */
  function cardPoints(card) {
    if (!card) return 0;
    var r = card.rank;
    if (r === 14) return 1;            // A
    if (r >= 11) return 0.5;           // J / Q / K
    return r;                          // 2..10
  }

  /** 合计点数（只到 0.5 档，二进制精确，仍留容差） */
  function points(cards) {
    var sum = 0;
    for (var i = 0; i < (cards || []).length; i++) sum += cardPoints(cards[i]);
    return Math.round(sum * 2) / 2;
  }

  /** 爆牌：严格大于爆牌线 */
  function isBust(cards) {
    return points(cards) > P.BUST_LINE + EPS;
  }

  /** 十点半：恰好压线（爆牌不算） */
  function isTenHalf(cards) {
    return !isBust(cards) && Math.abs(points(cards) - P.TEN_HALF) < EPS;
  }

  /** 满张：手牌达到上限张数 */
  function isFull(cards) {
    return (cards || []).length >= P.MAX_CARDS;
  }

  /** 还能要牌吗：未爆、未满张 */
  function canHit(cards) {
    return !isBust(cards) && !isFull(cards);
  }

  /**
   * 必须继续要牌吗：点数 ≤ FORCE_HIT_MAX 时不许停牌。
   * 爆了（已定局）和满 5 张（要不了）是仅有的两个豁免。
   * 例：起手 2 + J = 2.5 点，虽然远没到 10.5，也必须继续要，不能停。
   */
  function mustHit(cards) {
    if (isBust(cards)) return false;
    if (isFull(cards)) return false;
    return points(cards) <= P.FORCE_HIT_MAX + EPS;
  }

  /** 能不能停牌：与 mustHit 互斥 */
  function canStand(cards) {
    return !mustHit(cards);
  }

  /**
   * 单人比牌：闲家 vs 庄家
   * @returns {{win:boolean, mult:number, reason:string, ...}}  mult 带符号（+3 = 赢 3 倍）
   */
  function compare(playerCards, dealerCards) {
    var pPts = points(playerCards);
    var dPts = points(dealerCards);
    var pBust = pPts > P.BUST_LINE + EPS;
    var dBust = dPts > P.BUST_LINE + EPS;
    var pTH = !pBust && Math.abs(pPts - P.TEN_HALF) < EPS;
    var dTH = !dBust && Math.abs(dPts - P.TEN_HALF) < EPS;
    var pFull = isFull(playerCards);

    var win;
    var reason;

    if (pBust && dBust) {
      win = false; reason = 'both_bust';              // 都爆了庄最大
    } else if (pBust) {
      win = false; reason = pFull ? 'five_bust' : 'player_bust';
    } else if (dBust) {
      win = true; reason = 'dealer_bust';
    } else if (pPts > dPts + EPS) {
      win = true; reason = pTH ? 'ten_half' : 'points';
    } else if (pTH && dTH) {
      win = false; reason = 'both_ten_half';          // 都是十点半庄最大
    } else if (Math.abs(pPts - dPts) < EPS) {
      win = false; reason = 'dealer_tie';             // 同点庄最大
    } else {
      win = false; reason = dTH ? 'dealer_ten_half' : 'dealer_points';
    }

    /* 倍数只由「闲家自己的牌型」与「庄家十点半」决定，与 reason 正交，
       所以五张爆的罚则不会因为庄家十点半而再叠一层 2 倍。 */
    var mult;
    if (win) {
      mult = pFull ? (pTH ? P.MULT.FIVE_TEN_HALF : P.MULT.FIVE) : 1;
    } else if (pBust && pFull) {
      mult = -P.MULT.FIVE_BUST;
    } else {
      mult = dTH ? -P.MULT.DEALER_TEN_HALF : -1;
    }

    return {
      win: win,
      mult: mult,
      reason: reason,
      pPts: pPts,
      dPts: dPts,
      pBust: pBust,
      dBust: dBust,
      pTenHalf: pTH,
      dTenHalf: dTH,
      pFull: pFull
    };
  }

  /**
   * 一局全场结算：庄家 vs 若干闲家，含庄池赔付能力限制。
   *
   * @param dealerCards 庄家手牌
   * @param entries [{ seat, bet, cards }]
   * @param bankStart 本局开始时的庄池
   * @returns {{ results, bank, bankDelta, busted }}
   *   results[i].amount 是本局该闲家**实际**的筹码变化（+赢/−输）。
   *   庄池不足时按剩余额度赔（赔穿即下庄），不会出现负庄池 —— 
   *   这是庄家「输完下庄」在数据上的落点。
   */
  function settleRound(dealerCards, entries, bankStart) {
    var bank = bankStart;
    var results = [];

    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var r = compare(e.cards, dealerCards);
      var amount;

      if (r.win) {
        var due = e.bet * r.mult;
        var paid = Math.min(due, Math.max(bank, 0));
        bank -= paid;
        amount = paid;
      } else {
        var loss = e.bet * (-r.mult);
        bank += loss;
        amount = -loss;
      }

      results.push({
        seat: e.seat,
        bet: e.bet,
        amount: amount,
        win: r.win,
        mult: r.mult,
        reason: r.reason,
        pPts: r.pPts,
        dPts: r.dPts,
        pBust: r.pBust,
        dBust: r.dBust,
        pTenHalf: r.pTenHalf,
        dTenHalf: r.dTenHalf,
        pFull: r.pFull,
        shortPaid: r.win && amount < e.bet * r.mult   // 庄池不够，赔少了
      });
    }

    return {
      results: results,
      bank: bank,
      bankDelta: bank - bankStart
    };
  }

  /** 本局结束后庄家该不该下庄：输完 或 赢够 */
  function bankerShouldLeave(bank) {
    return bank <= 0 || bank >= P.BANK + P.BANK_WIN;
  }

  /** 电脑闲家要不要继续要牌 */
  function aiPlayerShouldHit(cards) {
    if (!canHit(cards)) return false;
    if (mustHit(cards)) return true;                 // 规则强制，电脑也一样
    var pts = points(cards);
    if ((cards || []).length >= P.MAX_CARDS - 1) return pts <= P.AI_FIFTH_HIT_MAX;
    return pts < P.AI_PLAYER_STAND_AT;
  }

  /** 电脑庄家要不要继续要牌 */
  function aiDealerShouldHit(cards) {
    if (!canHit(cards)) return false;
    if (mustHit(cards)) return true;                 // 规则强制
    return points(cards) < P.AI_DEALER_STAND_AT;
  }

  /** 展示用：10 → "10"，10.5 → "10.5" */
  function fmtPoints(n) {
    var v = Math.round(n * 2) / 2;
    return (v % 1 === 0) ? String(v) : v.toFixed(1);
  }

  /** 结算文案（UI 与测试共用一份口径，避免两处各写一套） */
  var REASON_TEXT = {
    points: '比点胜出',
    ten_half: '十点半压线',
    dealer_bust: '庄家爆牌',
    player_bust: '爆牌',
    five_bust: '五张爆牌',
    both_bust: '都爆了 · 庄大',
    both_ten_half: '都是十点半 · 庄大',
    dealer_tie: '同点 · 庄大',
    dealer_ten_half: '庄家十点半',
    dealer_points: '庄家点数更大'
  };

  /** 倍数徽标文案：1 倍不显示，特殊牌型才标出来 */
  function multText(mult) {
    var a = Math.abs(mult);
    if (a === 1) return '';
    return '×' + a;
  }

  return {
    cardPoints: cardPoints,
    points: points,
    isBust: isBust,
    isTenHalf: isTenHalf,
    isFull: isFull,
    canHit: canHit,
    mustHit: mustHit,
    canStand: canStand,
    compare: compare,
    settleRound: settleRound,
    bankerShouldLeave: bankerShouldLeave,
    aiPlayerShouldHit: aiPlayerShouldHit,
    aiDealerShouldHit: aiDealerShouldHit,
    fmtPoints: fmtPoints,
    REASON_TEXT: REASON_TEXT,
    multText: multText
  };
});
