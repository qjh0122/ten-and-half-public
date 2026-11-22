/**
 * 成就目录与判定（纯函数：只吃统计数据，不读 DOM、不读存储）
 *
 * 口径：全部由 stats 的**累计/峰值**字段判定，与 history 的截断无关 ——
 * history 只留最近 N 局，删了旧记录也不该把徽章收回去。
 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    global.Ach = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CATALOG = [
    { id: 'first_win',   name: '首胜',       desc: '赢下第一局',              test: function (s) { return s.wins >= 1; } },
    { id: 'ten_half',    name: '压线',       desc: '拿到一次 10.5',            test: function (s) { return s.tenHalfCount >= 1; } },
    { id: 'five_cards',  name: '五张不倒',   desc: '五张不爆赢一局（3 倍）',    test: function (s) { return s.fiveWinCount >= 1; } },
    { id: 'five_ten',    name: '六倍神牌',   desc: '五张且十点半（6 倍）',      test: function (s) { return s.fiveTenHalfCount >= 1; } },
    { id: 'five_bust',   name: '撑破天',     desc: '五张爆一次（输 3 倍）',     test: function (s) { return s.fiveBustCount >= 1; } },
    { id: 'dealer_bust', name: '气死庄家',   desc: '庄家爆牌一次',             test: function (s) { return s.dealerBustCount >= 1; } },
    { id: 'banker_full', name: '满庄下庄',   desc: '坐庄赢够 20 枚下庄',        test: function (s) { return s.dealerWinTenure >= 1; } },
    { id: 'streak_5',    name: '五连胜',     desc: '连续赢 5 局',              test: function (s) { return s.bestStreak >= 5; } },
    { id: 'clean_5',     name: '稳得住',     desc: '连续 5 局不爆',            test: function (s) { return s.bestClean >= 5; } },
    { id: 'peak_100',    name: '翻倍',       desc: '筹码摸到 100 枚',          test: function (s) { return s.peak >= 100; } },
    { id: 'rounds_50',   name: '常客',       desc: '累计打满 50 局',           test: function (s) { return s.rounds >= 50; } }
  ];

  function byId(id) {
    for (var i = 0; i < CATALOG.length; i++) if (CATALOG[i].id === id) return CATALOG[i];
    return null;
  }

  /** 当前 stats 下应当解锁的全部 id */
  function unlockedIds(stats) {
    var out = [];
    for (var i = 0; i < CATALOG.length; i++) {
      if (CATALOG[i].test(stats)) out.push(CATALOG[i].id);
    }
    return out;
  }

  /** 本次新增的解锁（用于弹提示、播音效） */
  function diffUnlocked(stats, already) {
    var all = unlockedIds(stats);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (!already || !already[all[i]]) out.push(byId(all[i]));
    }
    return out;
  }

  return { CATALOG: CATALOG, TOTAL: CATALOG.length, byId: byId, unlockedIds: unlockedIds, diffUnlocked: diffUnlocked };
});
