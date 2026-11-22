/**
 * 音效模块（真实音频文件 assets/audio/*.mp3 + WebAudio 三层合成兜底）
 *
 * - 移动端自动播放限制：必须在用户首次触摸手势内解锁（unlock）。
 *   ★ BGM 的创建与首次 play 都在手势栈里同步完成，不再放进 150ms setTimeout；
 *     play() 的 Promise 拒绝不能被吞掉，而是挂一次性手势重试监听。
 * - 若音频文件缺失/加载失败，按事件名落到 SYNTH_SPECS 合成兜底。
 * - 混音：按优先级打断（只管 WebAudio 声）+ BGM duck 包络 + 结果音互斥 + 元素池。
 *
 * ★ audio-impl-1（2026-11-20，参数唯一来源 docs/audio-diagnosis-2026-11-20.md）：
 *   §4.1 每个 one-shot = 瞬态噪声层 + 材质层（振荡器 + BiquadFilter lowpass）
 *                       + 情绪层（结果音两音以上 + linearRamp 真 release）；
 *   §4.1 硬规则：gain 必须 setValueAtTime(0,t) → linearRampToValueAtTime(peak,t+A)
 *                 → exponentialRampToValueAtTime(0.0001,t+A+D)。禁止零起音。
 *   §二 / §3.1 / §3.2 VOL 表逐事件落地；远场 ×0.5 + 1.2 kHz 低通（§4.2）；
 *   §4.2 结果音互斥 / error-select 60ms / 元素池；§4.3 三组变体轮转；
 *   §5.1 masterGain 0.9 → Compressor(-12/6/4/3ms/120ms) → destination；
 *   §5.2 duck 120ms attack → 250ms hold → 500ms release（HTMLAudio 无法用 AudioParam
 *         直接 ramp，故用分步 setTimeout 逼近包络，不用 createMediaElementSource）。
 *
 * 关于那个开关的语义：**它是「声音」总开关，不是「背景音乐」开关。**
 * 早先它只 pause 了 BGM，play() 却完全不看开关——于是玩家在房间页点了「关」，
 * 一进牌桌发牌声/选牌声/提示声照旧全响，看起来就是「关了还有声」。
 *
 * ⚠ 资产边界：未生成任何新 mp3。FILES/SFX_NAMES 仍只有原有 5 SFX + 1 BGM。
 * 第 3/4 步（BGM 真资产、deal×3、champion/win/lose）推迟；听感未验收，
 * 本文件只保证结构改造到位，不宣称「好听」。
 */
(function (global) {
  'use strict';

  var FILES = {
    deal: 'assets/audio/sfx_deal.mp3',
    select: 'assets/audio/sfx_select.mp3',
    submit: 'assets/audio/sfx_submit.mp3',
    win: 'assets/audio/sfx_win.mp3',
    settle: 'assets/audio/sfx_settle.mp3',
    bgm: 'assets/audio/bgm_room_loop.mp3'
  };
  var SFX_NAMES = ['deal', 'select', 'submit', 'win', 'settle'];

  /* §二 整体音量基准 / §5.2 duck 包络（原来的 0.12 / 0.04 / 900ms 硬台阶已废弃）。 */
  var BGM_VOL = 0.14;
  var DUCK_VOL = 0.05;
  var DUCK_HOLD_MS = 250;
  var DUCK_ATTACK_MS = 120;
  var DUCK_RELEASE_MS = 500;
  var MASTER_GAIN = 0.9;
  var FAR_LOWPASS = 1200;

  /* 优先级（规格 §6.4）：数字小的可打断数字大的；同级不互相打断。 */
  var PRIORITY = {
    error: 0, veto: 0, split_timeout: 0,
    win: 1, lose: 1, champion_fanfare: 1, achievement: 1, settle: 1, countdown_go: 1,
    deal: 2, submit: 2, ready: 2, split_tick: 2,
    select: 3, hint_guide: 3, spectator: 3, emoji_receive: 3, emoji_send: 3,
    peer_submit: 3, room_enter: 3, room_leave: 3
  };
  /* 远场（-6 dB + 1.2 kHz 低通）：他人动作，诊断 §1.2 P1-11 / §4.2。 */
  var FAR_FIELD = {
    room_enter: 1, room_leave: 1, peer_submit: 1, emoji_receive: 1
  };
  /* 语义化音高：不许被随机抖动改掉（大牌型/入槽/撤牌/战绩导出）。 */
  var SEMANTIC_PITCH = [1.12, 1.03, 0.97];
  /* P1-12 / §4.2：倒计时的 1.02/1.04 与 split 的 1.02–1.08 不再用音高表达递进，
   * 改由「滤波亮度」表达；这些值同样不参与 ±3% 抖动，否则 1.04 会抖到 1.01。 */
  var BRIGHTNESS_CUTOFF = { '1': 2000, '1.02': 3000, '1.04': 4000, '1.06': 4000, '1.08': 4000 };
  /* §3.2 split_tick 0.28→0.40 逐秒提亮，同样走亮度通道而不是音高。 */
  var BRIGHTNESS_VOL = { '1.02': 0.28, '1.04': 0.32, '1.06': 0.36, '1.08': 0.40 };

  /* §二 / §3.1 / §3.2 目标音量表（线性 gain）。hint_guide = UI 0.26 再低 4 dB（§3.3）。 */
  var VOL = {
    deal: 0.45, select: 0.32, submit: 0.50, win: 0.62, settle: 0.42,
    error: 0.38, lose: 0.50, countdown_tick: 0.30, countdown_go: 0.55,
    split_tick: 0.28, split_timeout: 0.42, peer_submit: 0.26,
    room_enter: 0.28, room_leave: 0.28, ready: 0.34, veto: 0.40,
    spectator: 0.20, emoji_receive: 0.26, emoji_send: 0.20,
    achievement: 0.68, champion_fanfare: 0.70, hint_guide: 0.16
  };

  /* §4.3 三组变体：失谐量 / 滤波截止 / 瞬态 seed。合成事件靠这组轮转出「音色变体」，
   * 不再只靠 VARIANTS 的 ±3% 音高（诊断 P1-8：那点差异听不出来）。 */
  var VARIANTS = [0.97, 1, 1.03];
  var VARIANT_PROFILES = [
    { detune: 0.985, cutoff: 0.85, seed: 101 },
    { detune: 1.000, cutoff: 1.00, seed: 202 },
    { detune: 1.015, cutoff: 1.18, seed: 303 }
  ];
  var POOL_SIZE = 2;   /* §4.2 元素池：每事件 2 个 Audio 轮转，替代 currentTime=0 硬抢占 */
  /* §4.2 互斥窗口（ms）：win 1.6 s 内不叠；settle 与 win 错开 ≥250 ms；
   * error 抢占同帧 select（60 ms）；远场同一秒最多 1 次；同一终局结果音 2 s 内不重播。 */
  var MUTEX = { win: 1600, settleOffset: 250, errorSelect: 60, far: 1000, terminal: 2000 };

  /* 合成规格：freq/type 是材质层主体；a/d/r/s 是 §3.1/§3.2 的 ADSR（ms，S 为比例）；
   * trans 是瞬态噪声层毫秒数；band 是噪声带通区间；cut 是材质层 lowpass；
   * tones 是情绪层的音程（ratio / level / delay / type），无 tones 时只有单主体音。 */
  var SYNTH_SPECS = {
    /* §3.1 / §1.5：140 Hz thud + 8 ms 粉噪，唯一低频「啪」，无 sweep（与 error 分频段） */
    deal:              { freq: 140,  dur: 0.093, type: 'triangle', gain: VOL.deal,   vol: VOL.deal,   a: 3,  d: 90,  r: 0,   s: 0,    trans: 8,  band: [1200, 3500], cut: 1200 },
    /* §3.1 / §1.5：760 Hz 单点击「嘀」，与 split_tick 靠双连击节奏区分 */
    select:            { freq: 760,  dur: 0.057, type: 'sine',     gain: VOL.select, vol: VOL.select, a: 2,  d: 55,  r: 0,   s: 0,    trans: 3,  band: [1200, 3000], cut: 3000 },
    /* §3.1 / §4.4 B：440→495 小幅上行 + 140 Hz×30 ms body（盖章），与阻断类上行区分 */
    submit:            { freq: 440,  dur: 0.163, type: 'triangle', gain: VOL.submit, vol: VOL.submit, a: 3,  d: 160, r: 0,   s: 0,    trans: 3,  band: [1200, 3500], cut: 3000, sweep: 1.125, body: { freq: 140, ms: 30, level: 0.25 } },
    /* §3.1 / §1.5：三音 1–1.25–1.5（60 ms 间隔）+ 100 Hz×60 ms body，与 achievement 的 1–1.5–2 铃簇区分 */
    win:               { freq: 880,  dur: 0.716, type: 'triangle', gain: VOL.win,    vol: VOL.win,    a: 6,  d: 180, r: 350, s: 0.45, trans: 6,  band: [1200, 3500], cut: 6000, body: { freq: 100, ms: 60, level: 0.3 },
                         tones: [{ ratio: 1, level: 1, delay: 0, type: 'triangle' }, { ratio: 1.25, level: 0.7, delay: 60, type: 'triangle' }, { ratio: 1.5, level: 0.5, delay: 120, type: 'triangle' }] },
    /* §3.1：中性合账，一记低木/纸夹，缩到 0.8–1.2 s */
    settle:            { freq: 300,  dur: 0.644, type: 'triangle', gain: VOL.settle, vol: VOL.settle, a: 4,  d: 240, r: 400, s: 0.35, trans: 4,  band: [1200, 2500], cut: 1200 },
    /* §3.1 / §4.4 B：560→520 小二度 + 双振荡器 ±4 cents + 180 Hz×25 ms body，lowpass 1.5 kHz */
    error:             { freq: 560,  dur: 0.123, type: 'triangle', gain: VOL.error,  vol: VOL.error,  a: 3,  d: 120, r: 0,   s: 0,    trans: 2,  band: [1200, 3500], cut: 1500, sweep: 0.929, detuneTone: 1.006, body: { freq: 180, ms: 25, level: 0.25 } },
    /* §3.1 / §4.4 B：下行小二度 + 1.2 kHz 低通 + 100 Hz body，落空专用走向 */
    lose:              { freq: 440,  dur: 0.708, type: 'triangle', gain: VOL.lose,   vol: VOL.lose,   a: 8,  d: 220, r: 480, s: 0.4,  trans: 6,  band: [1200, 3500], cut: 1200, sweep: 0.944, body: { freq: 100, ms: 60, level: 0.3 },
                         tones: [{ ratio: 1, level: 1, delay: 0, type: 'triangle' }, { ratio: 0.944, level: 0.6, delay: 70, type: 'triangle' }] },
    /* §3.2：主体 880 Hz，递进改滤波亮度，不用音高 */
    countdown_tick:    { freq: 880,  dur: 0.072, type: 'sine',     gain: VOL.countdown_tick, vol: VOL.countdown_tick, a: 2, d: 70,  r: 0, s: 0, trans: 2, band: [1200, 3500], cut: 2000 },
    /* §3.2 / §1.5：1046 Hz 五度长音（40 ms 叠音），放行信号，与 emoji 二音铃簇区分 */
    countdown_go:      { freq: 1046, dur: 0.223, type: 'triangle', gain: VOL.countdown_go,   vol: VOL.countdown_go,   a: 3, d: 220, r: 0, s: 0, trans: 3, band: [1200, 3500], cut: 4000,
                         tones: [{ ratio: 1, level: 1, delay: 0, type: 'triangle' }, { ratio: 1.5, level: 0.6, delay: 40, type: 'triangle' }] },
    /* §3.2 / §1.5：720 Hz 同音双连击（25 ms）+ 逐秒提亮，不用锯齿；与 select 单点击区分 */
    split_tick:        { freq: 720,  dur: 0.090, type: 'sine',     gain: VOL.split_tick, vol: VOL.split_tick, a: 2, d: 60,  r: 0, s: 0, trans: 2, band: [1200, 3500], cut: 2000,
                         tones: [{ ratio: 1, level: 1, delay: 0, type: 'sine' }, { ratio: 1, level: 0.7, delay: 25, type: 'sine' }] },
    /* §3.2 / §1.5：420 Hz 下行三度两音（90 ms），不用 sweep；与 error 小二度 / veto 单音区分 */
    split_timeout:     { freq: 420,  dur: 0.400, type: 'triangle', gain: VOL.split_timeout, vol: VOL.split_timeout, a: 4, d: 300, r: 0, s: 0, trans: 4, band: [1200, 2500], cut: 1200,
                         tones: [{ ratio: 1, level: 1, delay: 0, type: 'triangle' }, { ratio: 0.84, level: 0.7, delay: 90, type: 'triangle' }] },
    /* §3.2：与 submit 同材质，低通 + 远场 */
    peer_submit:       { freq: 440,  dur: 0.163, type: 'triangle', gain: VOL.peer_submit, vol: VOL.peer_submit, a: 3, d: 160, r: 0, s: 0, trans: 3, band: [1200, 3000], cut: 1200, sweep: 1.125 },
    /* §3.2 / §1.5：560 Hz 上行两音 1–1.26（有人来了），与 room_leave 下行两音区分 */
    room_enter:        { freq: 560,  dur: 0.220, type: 'sine',     gain: VOL.room_enter, vol: VOL.room_enter, a: 4, d: 170, r: 0, s: 0, trans: 4, band: [1200, 3000], cut: 1200,
                         tones: [{ ratio: 1, level: 1, delay: 0, type: 'sine' }, { ratio: 1.26, level: 0.6, delay: 45, type: 'sine' }] },
    /* 520 Hz 下行两音 1–0.84（有人走了） */
    room_leave:        { freq: 520,  dur: 0.220, type: 'sine',     gain: VOL.room_leave, vol: VOL.room_leave, a: 4, d: 170, r: 0, s: 0, trans: 4, band: [1200, 3000], cut: 1200,
                         tones: [{ ratio: 1, level: 1, delay: 0, type: 'sine' }, { ratio: 0.84, level: 0.6, delay: 45, type: 'sine' }] },
    /* §3.2：轻快确认，两音上行小三度 */
    ready:             { freq: 680,  dur: 0.123, type: 'triangle', gain: VOL.ready, vol: VOL.ready, a: 3, d: 120, r: 0, s: 0, trans: 3, band: [1200, 3000], cut: 3000,
                         tones: [{ ratio: 1, level: 1, delay: 0, type: 'triangle' }, { ratio: 1.189, level: 0.6, delay: 45, type: 'triangle' }] },
    /* §3.2 / §1.5：480 Hz 单 sine + 900 Hz 闷低通 + 180 Hz body；波形与 error 的 triangle 失谐双音区分 */
    veto:              { freq: 480,  dur: 0.214, type: 'sine',     gain: VOL.veto, vol: VOL.veto, a: 4, d: 210, r: 0, s: 0, trans: 3, band: [1200, 2500], cut: 900, body: { freq: 180, ms: 25, level: 0.25 } },
    /* §3.2 / §1.5：300 Hz 低频低存在感，不再挤 600 Hz 中频「咚」 */
    spectator:         { freq: 300,  dur: 0.154, type: 'sine',     gain: VOL.spectator, vol: VOL.spectator, a: 4, d: 150, r: 0, s: 0, trans: 2, band: [1200, 3000], cut: 900 },
    /* §3.2 / §1.5：1046 Hz + 1.26 二音铃簇（30 ms），远场低通；与 countdown_go 五度长音区分 */
    emoji_receive:     { freq: 1046, dur: 0.135, type: 'sine',     gain: VOL.emoji_receive, vol: VOL.emoji_receive, a: 2, d: 100, r: 0, s: 0, trans: 2, band: [1200, 3500], cut: 3500,
                         tones: [{ ratio: 1, level: 1, delay: 0, type: 'sine' }, { ratio: 1.26, level: 0.6, delay: 30, type: 'sine' }] },
    /* 发送版 1318 Hz（再升小三度）同铃簇，更轻；与 receive 靠频段 + 远场区分 */
    emoji_send:        { freq: 1318, dur: 0.135, type: 'sine',     gain: VOL.emoji_send,    vol: VOL.emoji_send,    a: 2, d: 100, r: 0, s: 0, trans: 2, band: [1200, 3500], cut: 3500,
                         tones: [{ ratio: 1, level: 1, delay: 0, type: 'sine' }, { ratio: 1.26, level: 0.6, delay: 30, type: 'sine' }] },
    /* §3.2 / §1.5：1046 Hz 高亮铃簇 1–1.5–2（45 ms），6 kHz；与 win 的 triangle 三和弦区分 */
    achievement:       { freq: 1046, dur: 0.708, type: 'sine',     gain: VOL.achievement, vol: VOL.achievement, a: 8, d: 200, r: 500, s: 0.5, trans: 6, band: [1200, 3500], cut: 6000,
                         tones: [{ ratio: 1, level: 1, delay: 0, type: 'sine' }, { ratio: 1.5, level: 0.7, delay: 45, type: 'sine' }, { ratio: 2, level: 0.5, delay: 90, type: 'sine' }] },
    /* §3.2 / §1.5：659 Hz 四音号角 1–1.125–1.25–1.5（70 ms 慢间隔）+ 120 Hz body，慢于 win */
    champion_fanfare:  { freq: 659,  dur: 0.900, type: 'sine',     gain: VOL.champion_fanfare, vol: VOL.champion_fanfare, a: 10, d: 240, r: 650, s: 0.6, trans: 8, band: [1200, 3500], cut: 6000, body: { freq: 120, ms: 60, level: 0.3 },
                         tones: [{ ratio: 1, level: 1, delay: 0, type: 'sine' }, { ratio: 1.125, level: 0.65, delay: 70, type: 'triangle' }, { ratio: 1.25, level: 0.55, delay: 140, type: 'triangle' }, { ratio: 1.5, level: 0.4, delay: 210, type: 'triangle' }] },
    /* §3.3：复用 select 的 ADSR，但音量再低 4 dB，引导出现时不打断阅读 */
    hint_guide:        { freq: 700,  dur: 0.057, type: 'sine',     gain: VOL.hint_guide, vol: VOL.hint_guide, a: 2, d: 55, r: 0, s: 0, trans: 2, band: [1200, 3000], cut: 2400 },
    /* §1.5 ready ↔ hold_toggle 撞车组：hold_toggle 是死条目（§3.3 实际走 ready(0.9/1.1)），
     * 直接删除第二套同音参数，不再给 audioMap 留一个「撞车幽灵」。 */
  };
  var DEFAULT_SPEC = { freq: 600, dur: 0.08, type: 'sine', gain: 0.10, vol: 0.10, a: 2, d: 60, r: 0, s: 0, trans: 2, band: [1200, 3000], cut: 2400 };

  var audioPool = {};   // name -> Array<Audio|null>（每事件 2 个轮转）
  var poolCursor = {};  // name -> 下一个要用的元素下标
  var bgm = null;
  var ST = (global.LXW && global.LXW.Store) || null;
  /* Node 测试里没有 window.LXW，就 require 同一份实现（跑的是同一段代码，
   * 只是 backing 由测试塞进来）—— 不是再造一个假存储。 */
  if (!ST && typeof require === 'function') {
    try { ST = require('./storage.js'); } catch (e) { ST = null; }
  }
  var SOUND_KEY = ST ? ST.KEYS.SOUND : 'lxw_sound_v1';              // 新键：声音总开关
  var LEGACY_BGM_KEY = ST ? ST.KEYS.BGM_LEGACY : 'lxw_bgm_v1';      // 老键：当时只管背景音乐，值要迁移

  /* 记住开关：默认开着，关过一次以后每次进来都别再吵人。 */
  function readSoundPref() {
    var v = ST ? ST.read(SOUND_KEY, '') : '';
    if (v === '0') return false;
    if (v === '1') return true;
    var old = ST ? ST.read(LEGACY_BGM_KEY, '') : '';
    return old !== '0';
  }
  function writeSoundPref(on) {
    if (ST) ST.write(SOUND_KEY, on ? '1' : '0');
  }

  var soundEnabled = readSoundPref();
  var unlocked = false;
  var ctx = null;       // 合成回退用 AudioContext
  var masterBus = null; // { ctx, node }：masterGain → compressor → destination
  var noiseCache = {};  // seed -> AudioBuffer（每个 seed 一份，变体靠 seed 区分）
  var bgmRetryArmed = false;
  var duckTimer = null;
  var duckRampTimers = [];
  var activeVoices = [];
  var variantCursor = 0;
  var recent = {};      // 事件 -> 最近一次 play 的时间戳，结果音互斥用
  var diagnostics = { last: null, gestureBgm: true, retryCount: 0, duckCount: 0, suppressedCount: 0 };

  function nowMs() { return (global.Date && global.Date.now) ? global.Date.now() : 0; }

  function makeAudio(src, loop, volume) {
    try {
      var a = new global.Audio(src);
      a.loop = !!loop;
      a.preload = 'auto';
      if (volume != null) a.volume = volume;
      return a;
    } catch (e) { return null; }
  }

  /* ---------- 初始化：每事件 POOL_SIZE 个 Audio 元素 ---------- */
  (function init() {
    SFX_NAMES.forEach(function (name) {
      var arr = [];
      for (var i = 0; i < POOL_SIZE; i++) {
        var a = makeAudio(FILES[name], false, VOL[name]);
        if (!a) { arr.push(null); continue; }
        (function (el, idx) {
          el.addEventListener('error', function () { audioPool[name][idx] = null; });
        })(a, i);
        arr.push(a);
      }
      audioPool[name] = arr;
    });
  })();

  /* ---------- Web Audio 合成回退 ---------- */
  function ensureCtx() {
    if (!ctx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    return ctx;
  }
  function jitter(amount) { return 1 + (Math.random() * 2 - 1) * amount; }
  function nextVariantIndex() {
    var i = variantCursor % VARIANT_PROFILES.length;
    variantCursor += 1;
    return i;
  }
  function isSemanticPitch(p) {
    for (var i = 0; i < SEMANTIC_PITCH.length; i++) {
      if (Math.abs((p || 1) - SEMANTIC_PITCH[i]) < 0.001) return true;
    }
    return false;
  }
  function isBrightnessPitch(p) {
    if (p == null) return false;
    return Object.prototype.hasOwnProperty.call(BRIGHTNESS_CUTOFF, String(Number(p.toFixed(2))));
  }
  /* countdown_tick / split_tick 的 1/1.02/1.04/1.06/1.08 走这条：
   * 不改音高，改低通截止（和 split 的音量）。P1-12 的语义白名单问题在此关闭。 */
  function brightnessInfo(name, pitch) {
    if (name !== 'countdown_tick' && name !== 'split_tick') return null;
    if (pitch == null) return null;
    var key = String(Number(pitch.toFixed(2)));
    if (!Object.prototype.hasOwnProperty.call(BRIGHTNESS_CUTOFF, key)) return null;
    return { cutoff: BRIGHTNESS_CUTOFF[key], vol: BRIGHTNESS_VOL[key] || null };
  }
  function setParamValue(p, v) { if (p) { try { p.value = v; } catch (e) {} } }

  /* §5.1 MASTER：masterGain 0.9 → Compressor(-12/6/4/0.003/0.12) → destination。
   * 老浏览器/测试假上下文没有 compressor 时降级为 masterGain → destination，不抛。 */
  function ensureBus(c) {
    if (masterBus && masterBus.ctx === c) return masterBus.node;
    try {
      var g = c.createGain();
      setParamValue(g.gain, MASTER_GAIN);
      if (typeof c.createDynamicsCompressor === 'function') {
        var comp = c.createDynamicsCompressor();
        setParamValue(comp.threshold, -12);
        setParamValue(comp.knee, 6);
        setParamValue(comp.ratio, 4);
        setParamValue(comp.attack, 0.003);
        setParamValue(comp.release, 0.12);
        g.connect(comp);
        comp.connect(c.destination);
      } else {
        g.connect(c.destination);
      }
      masterBus = { ctx: c, node: g };
      return g;
    } catch (e) {
      return c.destination;
    }
  }

  /* 瞬态层：带通粉噪 buffer，2 ms 起 / 8–12 ms 落。零资产，不依赖任何 mp3。 */
  function noiseBuffer(c, seed) {
    if (!c.createBuffer) return null;
    var key = String(seed);
    if (noiseCache[key]) return noiseCache[key];
    var rate = c.sampleRate || 44100;
    var len = Math.max(1, Math.floor(rate * 0.03));
    var buf = c.createBuffer(1, len, rate);
    if (buf.getChannelData) {
      var ch = buf.getChannelData(0);
      var s = seed >>> 0;
      for (var i = 0; i < len; i++) {
        s = (Math.imul ? Math.imul(s, 1664525) : s * 1664525) + 1013904223 >>> 0;
        ch[i] = (s / 4294967296) * 2 - 1;
      }
    }
    noiseCache[key] = buf;
    return buf;
  }
  function addTransient(c, bus, t, spec, profile, peak, nodes) {
    if (!c.createBufferSource || !c.createBiquadFilter || !c.createGain) return;
    var buf = noiseBuffer(c, profile.seed);
    if (!buf) return;
    try {
      var src = c.createBufferSource();
      if (nodes) nodes.push(src);
      src.buffer = buf;
      var bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      var band = spec.band || [1200, 3500];
      setParamValue(bp.frequency, ((band[0] + band[1]) / 2) * profile.cutoff);
      setParamValue(bp.Q, 0.8);
      var g = c.createGain();
      var dec = Math.max(0.008, (spec.trans || 3) / 1000);
      /* §4.1 硬规则：零起音 → linear ramp → 指数落。这里 lin 2 ms，落 8–12 ms。 */
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak * 0.5, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
      src.connect(bp); bp.connect(g); g.connect(bus);
      src.start(t); src.stop(t + dec + 0.005);
    } catch (e) { /* 音频节点不可用时降级为纯材质层，不让一次 UI 点击抛到界面上 */ }
  }

  /* 材质层 / 情绪层：每音一个 oscillator + lowpass BiquadFilter + 独立 gain 包络。
   * 有 spec.r 的结果音走 linearRamp 到 sustain 再指数 release（真 release）。 */
  function addTone(c, bus, t, spec, tone, freq, peak, cutoff, stopAtOut, nodes) {
    var osc = c.createOscillator();
    if (nodes) nodes.push(osc);
    var g = c.createGain();
    var a = Math.max(0.002, spec.a / 1000);
    var d = Math.max(0.02, spec.d / 1000);
    var onset = t + (tone.delay || 0) / 1000;
    osc.type = tone.type || spec.type;
    osc.frequency.setValueAtTime(freq, onset);
    if (spec.sweep) osc.frequency.exponentialRampToValueAtTime(freq * spec.sweep, onset + a + d);
    var filter = null;
    if (c.createBiquadFilter) {
      filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      setParamValue(filter.frequency, cutoff);
      setParamValue(filter.Q, 0.7);
    }
    var peakTone = peak * (tone.level == null ? 1 : tone.level);
    var end;
    if (spec.r && spec.s != null) {
      var r = spec.r / 1000;
      g.gain.setValueAtTime(0, onset);
      g.gain.linearRampToValueAtTime(peakTone, onset + a);
      g.gain.linearRampToValueAtTime(peakTone * spec.s, onset + a + d);
      g.gain.exponentialRampToValueAtTime(0.0001, onset + a + d + r);
      end = onset + a + d + r + 0.02;
    } else {
      /* 禁止把峰值在 t 直接赋值的零起音写法：所有 one-shot 都必须有 ≥2 ms 的 attack ramp。 */
      g.gain.setValueAtTime(0, onset);
      g.gain.linearRampToValueAtTime(peakTone, onset + a);
      g.gain.exponentialRampToValueAtTime(0.0001, onset + a + d);
      end = onset + a + d + 0.02;
    }
    if (filter) { osc.connect(filter); filter.connect(g); } else { osc.connect(g); }
    g.connect(bus);
    osc.start(onset); osc.stop(end);
    if (end > stopAtOut.value) stopAtOut.value = end;
  }

  /* §4.4 B 的 body 层：绝对低频（100–180 Hz）+ 25–60 ms 短尾，给「打点」重量，
   * 不参与变调，也不参与频段撞车（它固定在低频，主体走各自频段）。 */
  function addBody(c, bus, t, body, peak, nodes) {
    if (!body || !c.createOscillator || !c.createGain) return;
    try {
      var osc = c.createOscillator();
      if (nodes) nodes.push(osc);
      var g = c.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(body.freq, t);
      var a = 0.002;
      var d = Math.max(0.02, body.ms / 1000);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak * body.level, t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
      osc.connect(g); g.connect(bus);
      osc.start(t); osc.stop(t + a + d + 0.02);
    } catch (e) { /* body 是增强层，节点不可用就退回主体音，不让界面抛错 */ }
  }

  function rememberVoice(entry, ms) {
    activeVoices.push(entry);
    if (typeof setTimeout === 'function') {
      setTimeout(function () {
        var i = activeVoices.indexOf(entry);
        if (i >= 0) activeVoices.splice(i, 1);
      }, ms || 2000);
    }
  }
  function interruptBelow(level) {
    activeVoices.slice().forEach(function (v) {
      if (v.level <= level) return;   // 同级不打断，只有更高优先级才抢占
      try { v.stop(); } catch (e) {}
      var i = activeVoices.indexOf(v);
      if (i >= 0) activeVoices.splice(i, 1);
    });
    /* 资产层不做优先级打断（§5.1 明确二选一）：只做互斥 + 元素池，
     * 不留下「有优先级但不管主音源」的中间态。 */
  }
  function stopVoicesFor(name) {
    activeVoices.slice().forEach(function (v) {
      if (v.name !== name) return;
      try { v.stop(); } catch (e) {}
      var i = activeVoices.indexOf(v);
      if (i >= 0) activeVoices.splice(i, 1);
    });
    (audioPool[name] || []).forEach(function (a) {
      if (!a) return;
      try { a.pause(); a.currentTime = 0; } catch (e) {}
    });
  }

  function synth(name, pitch, variantIndex, far, opts) {
    var c = ensureCtx();
    if (!c) return null;
    if (c.state === 'suspended') { try { c.resume(); } catch (e) {} }
    var spec = SYNTH_SPECS[name] || DEFAULT_SPEC;
    opts = opts || {};
    try {
      var t = c.currentTime;
      var bus = ensureBus(c);
      var profile = VARIANT_PROFILES[variantIndex % VARIANT_PROFILES.length];
      var peak = (opts.vol == null ? spec.vol : opts.vol) * (far ? 0.5 : 1) * jitter(0.05);
      var cutoff = (opts.cutoff == null ? spec.cut : opts.cutoff) * profile.cutoff;
      if (far) cutoff = Math.min(cutoff, FAR_LOWPASS);
      /* 频率不随「亮度递进」变；语义音高（1.12/1.03/0.97）仍照常变调。 */
      var freqPitch = opts.brightness ? 1 : (opts.rate == null ? 1 : opts.rate);
      var baseFreq = spec.freq * (variantIndex >= 0 ? VARIANTS[variantIndex % VARIANTS.length] : 1)
        * profile.detune * freqPitch;
      var stopAt = { value: t + spec.dur + 0.05 };
      var nodes = [];
      addTransient(c, bus, t, spec, profile, peak * 0.5, nodes);
      var tones = spec.tones || [{ ratio: 1, level: 1, delay: 0, type: spec.type }];
      tones.forEach(function (tone) {
        addTone(c, bus, t, spec, tone, baseFreq * tone.ratio, peak, cutoff, stopAt, nodes);
      });
      if (spec.detuneTone) {
        addTone(c, bus, t, spec, { ratio: spec.detuneTone, level: 0.5, delay: 0, type: spec.type },
          baseFreq * spec.detuneTone, peak, cutoff, stopAt, nodes);
      }
      addBody(c, bus, t, spec.body, peak, nodes);
      /* 抢占时把这一声的所有 source/oscillator 停掉，不只停主振荡器。 */
      var voice = {
        name: name,
        level: PRIORITY[name] == null ? 3 : PRIORITY[name],
        at: nowMs(),
        stop: function () {
          nodes.forEach(function (n) { try { n.stop(); } catch (e) {} });
        }
      };
      rememberVoice(voice, Math.round((stopAt.value - t) * 1000) + 100);
      return voice;
    } catch (e) { return null; }
  }

  /* ---------- BGM：手势内首次 play + 一次性重试 + duck 包络 ---------- */
  function bgmVolume(v) {
    if (!bgm) return;
    try { bgm.volume = v; } catch (e) {}
  }
  function clearDuckTimers() {
    if (duckTimer && typeof clearTimeout === 'function') clearTimeout(duckTimer);
    duckTimer = null;
    duckRampTimers.forEach(function (id) { if (typeof clearTimeout === 'function') clearTimeout(id); });
    duckRampTimers = [];
  }
  /* <audio>.volume 不是 AudioParam，不能用 linearRampToValueAtTime；
   * 用分步 setTimeout 逼近 §5.2 的 120 ms attack / 500 ms release（不引入 createMediaElementSource）。 */
  function rampBgmVolume(to, durMs, stepMs) {
    if (!bgm) return;
    var from = (function () { try { return bgm.volume; } catch (e) { return BGM_VOL; } })();
    var n = Math.max(1, Math.round(durMs / stepMs));
    for (var i = 1; i <= n; i++) {
      (function (k) {
        var id = setTimeout(function () {
          var j = duckRampTimers.indexOf(id);
          if (j >= 0) duckRampTimers.splice(j, 1);
          bgmVolume(from + (to - from) * (k / n));
        }, (durMs / n) * k);
        duckRampTimers.push(id);
      })(i);
    }
  }
  function duckBgm() {
    if (!soundEnabled || !bgm) return;
    if (duckTimer) return;   /* §5.2 hold 期间不再重置 */
    diagnostics.duckCount += 1;
    clearDuckTimers();
    rampBgmVolume(DUCK_VOL, DUCK_ATTACK_MS, 20);
    duckTimer = typeof setTimeout === 'function' ? setTimeout(function () {
      duckTimer = null;
      rampBgmVolume(BGM_VOL, DUCK_RELEASE_MS, 50);
    }, DUCK_HOLD_MS) : null;
  }
  function disarmBgmRetry() {
    var doc = global.document;
    if (!bgmRetryArmed || !doc || !doc.removeEventListener) return;
    doc.removeEventListener('touchstart', onBgmRetryGesture, true);
    doc.removeEventListener('mousedown', onBgmRetryGesture, true);
    bgmRetryArmed = false;
  }
  function armBgmRetry() {
    var doc = global.document;
    if (bgmRetryArmed || !doc || !doc.addEventListener) return;
    bgmRetryArmed = true;
    diagnostics.retryCount += 1;
    doc.addEventListener('touchstart', onBgmRetryGesture, { capture: true, passive: true });
    doc.addEventListener('mousedown', onBgmRetryGesture, { capture: true, passive: true });
  }
  function onBgmRetryGesture() {
    if (!soundEnabled) return;
    disarmBgmRetry();
    startBgmInGesture();
  }
  function startBgmInGesture() {
    if (!soundEnabled) return;
    if (!bgm) bgm = makeAudio(FILES.bgm, true, BGM_VOL);
    if (!bgm) return;
    bgmVolume(BGM_VOL);
    try {
      bgm.muted = true;
      var p = bgm.play();
      if (p && typeof p.then === 'function') {
        p.then(function () {
          if (bgm) { bgm.muted = false; bgmVolume(BGM_VOL); }
          disarmBgmRetry();
        }).catch(function () {
          armBgmRetry();
        });
      } else {
        bgm.muted = false;
        disarmBgmRetry();
      }
    } catch (e) {
      armBgmRetry();
    }
  }

  /* ---------- 首次用户手势解锁 ---------- */
  function unlockSfxElement(name) {
    (audioPool[name] || []).forEach(function (a) {
      if (!a) return;
      try {
        a.muted = true;
        var p = a.play();
        function settle() {
          if (!a) return;
          try { a.pause(); a.currentTime = 0; } catch (e) {}
          a.muted = false;
        }
        if (p && typeof p.then === 'function') p.then(settle, settle);
        else settle();
      } catch (e) {
        try { a.muted = false; } catch (e2) {}
      }
    });
  }
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    var c = ensureCtx();
    if (c && c.state === 'suspended') { try { c.resume(); } catch (e) {} }
    SFX_NAMES.forEach(unlockSfxElement);
    /* 创建 + 首次 play 都在手势栈内同步完成；定时器里首次 play 就是 B2 的根因。 */
    startBgmInGesture();
  }
  function startBgm() { startBgmInGesture(); }

  /* ---------- 结果音互斥 / 去重（§4.2，全部在 sfx.js 内部，不改调用点） ---------- */
  function isTerminal(name) { return name === 'champion_fanfare' || name === 'lose'; }
  function shouldSuppress(name, t) {
    if (isTerminal(name)) return !!(recent[name] && t - recent[name] < MUTEX.terminal);
    if (name === 'win') {
      var lastTerminal = Math.max(recent.champion_fanfare || 0, recent.lose || 0);
      return !!(lastTerminal && t - lastTerminal < MUTEX.win)
        || !!(recent.win && t - recent.win < MUTEX.win);
    }
    if (name === 'settle') return !!(recent.win && t - recent.win < MUTEX.settleOffset);
    if (name === 'select') return !!(recent.error && t - recent.error < MUTEX.errorSelect);
    if (FAR_FIELD[name]) return !!(recent[name] && t - recent[name] < MUTEX.far);
    return false;
  }
  function nextPoolElement(name) {
    var arr = audioPool[name] || [];
    if (!arr.length) return null;
    var start = poolCursor[name] || 0;
    for (var k = 0; k < arr.length; k++) {
      var idx = (start + k) % arr.length;
      if (arr[idx]) {
        poolCursor[name] = (idx + 1) % arr.length;
        return arr[idx];
      }
    }
    poolCursor[name] = (start + 1) % arr.length;
    return null;
  }

  /* ---------- 播放 ---------- */
  function play(name, pitch) {
    if (!unlocked) return;
    if (!soundEnabled) return;
    var t = nowMs();
    if (shouldSuppress(name, t)) {
      diagnostics.suppressedCount += 1;
      diagnostics.last = { name: name, suppressed: true, at: t };
      return;
    }
    recent[name] = t;
    var bright = brightnessInfo(name, pitch);
    var fixed = isSemanticPitch(pitch) || !!bright;
    var jittered = fixed ? 1 : jitter(0.03);
    var rate = (pitch || 1) * jittered;
    var vi = nextVariantIndex();
    var profile = VARIANT_PROFILES[vi];
    var level = PRIORITY[name] == null ? 3 : PRIORITY[name];
    var far = !!FAR_FIELD[name];
    var vol = bright && bright.vol != null ? bright.vol : (VOL[name] == null ? 0.3 : VOL[name]);
    var cutoff = bright ? bright.cutoff : (SYNTH_SPECS[name] ? SYNTH_SPECS[name].cut : 2400);

    /* §4.2：终局结果音抢占幕内 win；error 抢占同帧 select。 */
    if (isTerminal(name)) stopVoicesFor('win');
    if (name === 'error') stopVoicesFor('select');
    interruptBelow(level);
    if (level <= 1) duckBgm();

    var a = nextPoolElement(name);
    if (a) {
      try {
        a.currentTime = 0;
        /* 真资产没有 3 条不同录音（本轮不产资产）：用 profile.detune 做极轻微变调 +
         * 元素池轮转，诚实标注为「无资产时的近似变体」，不冒充诊断 §4.3 的 3 录音。 */
        a.playbackRate = rate * profile.detune;
        a.volume = vol * (far ? 0.5 : 1) * jitter(0.05);
        var p = a.play();
        if (p && p.catch) p.catch(function () {
          synth(name, rate, vi, far, { vol: vol, cutoff: cutoff, rate: rate, brightness: !!bright });
        });
      } catch (e) {
        synth(name, rate, vi, far, { vol: vol, cutoff: cutoff, rate: rate, brightness: !!bright });
      }
    } else {
      synth(name, rate, vi, far, { vol: vol, cutoff: cutoff, rate: rate, brightness: !!bright });
    }
    diagnostics.last = {
      name: name, pitch: rate, jitter: jittered, variant: VARIANTS[vi],
      variantIndex: vi, detune: profile.detune, filterSeed: profile.seed,
      priority: level, far: far, fixed: fixed, suppressed: false,
      vol: vol, cutoffBase: cutoff,
      cutoff: far ? Math.min(cutoff * profile.cutoff, FAR_LOWPASS) : cutoff * profile.cutoff,
      brightness: !!bright
    };
  }

  global.Sfx = {
    unlock: unlock,
    play: play,
    startBgm: startBgm,
    /** 声音总开关：BGM 和音效一起受控 */
    setSoundEnabled: function (on) {
      soundEnabled = !!on;
      writeSoundPref(soundEnabled);
      if (!soundEnabled) {
        if (bgm) { try { bgm.pause(); } catch (e) {} }
        clearDuckTimers();
        /* 元素池里正在响的那一下也要掐掉——否则「点完关它还响一下」观感不变。 */
        SFX_NAMES.forEach(function (n) {
          (audioPool[n] || []).forEach(function (a) {
            if (!a) return;
            try { a.pause(); a.currentTime = 0; } catch (e) {}
          });
        });
        activeVoices.slice().forEach(function (v) { try { v.stop(); } catch (e) {} });
        activeVoices = [];
        disarmBgmRetry();
      } else {
        startBgm();
      }
      return soundEnabled;
    },
    isSoundEnabled: function () { return soundEnabled; },
    setBgmEnabled: function (on) { return global.Sfx.setSoundEnabled(on); },
    isBgmEnabled: function () { return soundEnabled; },
    isUnlocked: function () { return unlocked; },
    /* 只读诊断口：测试用它验接线，不是第二套 API。 */
    diagnostics: function () {
      return {
        last: diagnostics.last,
        gestureBgm: diagnostics.gestureBgm,
        retryArmed: bgmRetryArmed,
        retryCount: diagnostics.retryCount,
        duckCount: diagnostics.duckCount,
        suppressedCount: diagnostics.suppressedCount,
        bgmMuted: bgm ? !!bgm.muted : null,
        bgmVolume: bgm ? bgm.volume : null,
        activeVoices: activeVoices.length,
        poolSize: POOL_SIZE
      };
    },
    /** 事件 → 兜底参数 / 优先级 / 音量，供静态门禁逐事件核对（不产生声音）。 */
    audioMap: function () {
      var out = {};
      Object.keys(SYNTH_SPECS).forEach(function (k) {
        out[k] = {
          priority: PRIORITY[k] == null ? 3 : PRIORITY[k],
          far: !!FAR_FIELD[k],
          asset: !!FILES[k],
          vol: VOL[k] == null ? 0.10 : VOL[k],
          spec: SYNTH_SPECS[k]
        };
      });
      return out;
    }
  };
})(typeof self !== 'undefined' ? self : this);
