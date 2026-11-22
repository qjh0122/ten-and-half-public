/**
 * 本地存储收口：所有键名与读写只在这里出现一次。
 *
 * 纪律（沿用六选五的教训）：
 *   · 读写永不抛 —— 隐私模式 / 存储满 / 数据损坏都退化为「当作没有」
 *   · 键名带版本后缀，将来改结构不必写迁移脚本
 *   · 浏览器上同时挂到 window.LXW.Store，供 js/sfx.js 复用（它按 KEYS.SOUND 存开关）
 */
(function (global, factory) {
  var mod = factory(global);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  }
  if (global) {
    global.LXW = global.LXW || {};
    global.LXW.Store = mod;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (global) {
  'use strict';

  var KEYS = {
    SOUND: 'sd10_sound_v1',
    BGM_LEGACY: 'lxw_bgm_v1',     // sfx.js 会读它做一次性迁移，不是我们的键
    STATS: 'sd10_stats_v1',
    HISTORY: 'sd10_history_v1',
    ACH: 'sd10_ach_v1',
    SETUP: 'sd10_setup_v1',
    SHARE: 'sd10_share_v1'
  };

  function ls() {
    try { return global.localStorage || null; } catch (e) { return null; }
  }

  function readRaw(k) {
    var s = ls();
    if (!s) return null;
    try { return s.getItem(k); } catch (e) { return null; }
  }

  function read(k, fallback) {
    var v = readRaw(k);
    return v == null ? fallback : v;
  }

  function readJSON(k, fallback) {
    var v = readRaw(k);
    if (v == null) return fallback;
    try {
      var o = JSON.parse(v);
      return (o && typeof o === 'object') ? o : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function write(k, v) {
    var s = ls();
    if (!s) return false;
    try {
      s.setItem(k, (typeof v === 'string') ? v : JSON.stringify(v));
      return true;
    } catch (e) {
      return false;   // 写不进去不影响本局游玩
    }
  }

  function remove(k) {
    var s = ls();
    if (!s) return;
    try { s.removeItem(k); } catch (e) {}
  }

  /**
   * 统计数据默认值：所有字段都必须在这里有初值，视图层不许再写 `|| 0` 兜底。
   * 口径统一为「0 号座位（你 / 玩家 1）的视角」，但 0 号坐庄的局单独记在 dealer* 里，
   * 因为坐庄那一局没有「对庄输赢」，只有庄池进出。
   */
  function emptyStats(peak) {
    return {
      rounds: 0, wins: 0, losses: 0,
      tenHalfCount: 0,                 // 拿到十点半的次数
      fiveWinCount: 0,                 // 五张不爆赢（3 倍 / 6 倍）
      fiveTenHalfCount: 0,             // 五张且十点半（6 倍）
      fiveBustCount: 0,                // 五张爆（输 3 倍）
      dealerRounds: 0,                 // 自己坐庄的局数
      dealerWinTenure: 0,              // 赢够 20 下庄的任数
      dealerBustCount: 0,              // 对家坐庄时庄家爆牌的次数
      streak: 0, bestStreak: 0,
      bestWin: 0,                      // 单局最高净胜
      clean: 0, bestClean: 0,          // 连续未爆局数
      peak: peak
    };
  }

  return {
    KEYS: KEYS,
    read: read,
    readJSON: readJSON,
    write: write,
    remove: remove,
    emptyStats: emptyStats
  };
});
