/**
 * 十点半 · 参数表（唯一数值来源）
 *
 * 纪律：任何模块不得出现裸数字，一律从这里取。
 * 本文件同时是规则文档的可执行版本 —— 改数值只改这里。
 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    global.PARAMS = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  return {
    /* 设计空间：整页按 750 宽缩放，高度随真机反算 */
    DESIGN_W: 750,
    DESIGN_H: 1624,

    /* ============ 筹码经济（多人轮流坐庄） ============ */
    START_CHIPS: 50,          // 每人起手筹码
    BANK: 20,                 // 上庄注：坐庄时从自己筹码里拿出来当庄池
    BANK_WIN: 20,             // 庄池比上庄时多出这么多 → 赢够下庄
    BET_TIERS: [1, 2, 3],     // 闲家每次只能下这三档，不能多下
    MIN_SEATS: 2,             // 最少 1 庄 + 1 闲
    MAX_SEATS: 4,             // 牌桌最多 4 人（1 庄 + 3 闲）

    /* ============ 牌局 ============ */
    DECK_SIZE: 52,            // 单副去大小王
    BUST_LINE: 10.5,          // 超过即爆
    TEN_HALF: 10.5,           // 压线值
    MAX_CARDS: 5,             // 手牌上限；满 5 张即触发五张牌型 / 五张爆罚则
    FORCE_HIT_MAX: 6,         // 点数 ≤ 此值必须继续要牌，禁止停牌（爆了或满张才免）
    DEAL_TWO: 2,              // 起手张数
    /* 四人局单轮最多用 4×5=20 张，留 2 张余量即安全换堆；
       低于此值才换，避免每局都洗牌 */
    RESHUFFLE_AT: 22,

    /* ============ 赔付倍数（正=闲家赢，负=闲家输） ============ */
    MULT: {
      DEALER_TEN_HALF: 2,     // 庄家十点半并获胜 → 闲家输 2 倍
      FIVE: 3,                // 闲家五张不爆 → 赢 3 倍
      FIVE_TEN_HALF: 6,       // 闲家五张且十点半 → 赢 6 倍
      FIVE_BUST: 3            // 闲家五张爆 → 输 3 倍
    },

    /* ============ AI ============ */
    AI_DEALER_STAND_AT: 8,    // 电脑庄：低于 8 点继续要
    AI_PLAYER_STAND_AT: 8,    // 电脑闲：低于 8 点继续要
    AI_FIFTH_HIT_MAX: 5,      // 已 4 张时，点数 ≤ 此值才敢要第 5 张
    AI_THINK_MS: 460,         // 电脑「思考」的停顿，太快看不清发生了什么

    /* ============ 节奏（毫秒） ============ */
    DEAL_MS: 260,
    DEAL_STAGGER_MS: 130,
    REVEAL_MS: 260,
    SETTLE_DELAY_MS: 340,
    AUTO_ADVANCE_MS: 520,     // 爆牌 / 十点半 / 满张后自动推进的停顿

    /* ============ 牌面尺寸（设计 px） ============ */
    SCREEN_PAD_X: 40,
    CARD_W: 144,
    CARD_H: 196,
    CARD_GAP: 12,
    SEAT_OVERLAP: 0.58,       // 座位区叠压系数：露出 42% 卡宽，牌再多也读得清点数
    SEAT_CARD_W: 108,         // 座位手牌固定宽（多人局）；固定宽 → 发牌时不抖动
    SEAT_CARD_W_WIDE: 124,    // 只有 1 个闲家时放宽一档

    /* ============ 本地留存 ============ */
    HISTORY_MAX: 60
  };
});
