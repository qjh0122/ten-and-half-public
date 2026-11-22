/**
 * 十点半 · 主控（视口 / 状态机 / 渲染 / 交互 / 存储 / 音效）
 *
 * 玩法骨架：
 *   开局（选模式与人数）→ 上庄（庄家拿 20 进庄池）→ 闲家逐个下注（1/2/3）
 *   → 逐人发两张 → 闲家按座位依次要牌/停牌 → 庄家翻牌并行动
 *   → 逐人结算（庄池进出）→ 庄池输光或赢够 20 则下庄换人 → 下一局
 *   有人筹码归零、或下一任庄家不够 20 → 本场结束
 *
 * 三条不许破的纪律：
 *   1. **界面壳照抄六选五**：同一份 css/style.css、同一套组件、同一个 Canvas 牌面。
 *   2. **布局全部在文档流里**：动作条不绝对定位，真机上 innerHeight 怎么变都推不出去。
 *   3. **输入门禁靠 phase + busy 双闸**，不靠 disabled 样式；没有任何跨局残留标志。
 */
(function () {
  'use strict';

  var P = window.PARAMS;
  var R = window.Rules;
  var Match = window.Match;
  var CardLib = window.Card;
  var S = window.LXW.Store;
  var Ach = window.Ach;

  function $(id) { return document.getElementById(id); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ============================ 视口 ============================ */
  var viewport, stage;

  function measureSafeArea() {
    var probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:-99999px;top:-99999px;'
      + 'padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);'
      + 'padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);';
    document.body.appendChild(probe);
    var cs = getComputedStyle(probe);
    var out = {
      top: parseFloat(cs.paddingTop) || 0,
      bottom: parseFloat(cs.paddingBottom) || 0,
      left: parseFloat(cs.paddingLeft) || 0,
      right: parseFloat(cs.paddingRight) || 0
    };
    document.body.removeChild(probe);
    return out;
  }

  var resizeRetry = 0;

  function resize() {
    if (!viewport || !stage) return;
    /* 读布局几何而不是 clientHeight：iOS standalone 下 clientHeight 偶尔少一截 */
    var rect = viewport.getBoundingClientRect();
    var vw = Math.round(rect.width) || window.innerWidth;
    var vh = Math.round(rect.height) || window.innerHeight;
    if (!(vw > 0) || !(vh > 0)) {
      if (resizeRetry < 6) { resizeRetry++; setTimeout(resize, 80); }
      return;                                  // 尺寸无效时保留上一次结果，绝不写 scale(0)
    }
    resizeRetry = 0;

    var standalone = (window.navigator.standalone === true) ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

    /* standalone 下用物理屏高校正「报矮了」的读数，两条护栏：只往上修、只修差 ≤18% 的 */
    if (standalone && vw < vh) {
      var sh = (window.screen && window.screen.height) ? Math.round(window.screen.height) : 0;
      if (sh > vh && sh - vh <= Math.round(vh * 0.18)) vh = sh;
    }

    /* html / body / #viewport / #stage 四层统一读 --vp-h，谁也不会裁谁 */
    document.documentElement.style.setProperty('--vp-h', vh + 'px');

    var sa = measureSafeArea();
    var landscape = vw > vh;
    var scale, stageW;
    if (landscape) {
      scale = Math.min(vw / P.DESIGN_W, vh / 1000);
      stageW = vw / scale;
      stage.classList.add('ls');
    } else {
      scale = vw / P.DESIGN_W;
      stageW = P.DESIGN_W;
      stage.classList.remove('ls');
    }
    if (!isFinite(scale) || scale <= 0) return;

    stage.style.setProperty('--pt-scale', scale);
    stage.style.setProperty('--ls-scale', scale);
    stage.style.setProperty('--sa-top', (sa.top / scale) + 'px');
    stage.style.setProperty('--sa-bottom', (sa.bottom / scale) + 'px');
    stage.style.setProperty('--sa-left', (sa.left / scale) + 'px');
    stage.style.setProperty('--sa-right', (sa.right / scale) + 'px');
    if (landscape) stage.style.width = Math.round(stageW) + 'px';

    /* 牌面尺寸随舞台高度自适应：矮屏（16:9）缩一档，保证庄家区 + 座位 + 动作条同屏 */
    var stageH = vh / scale;
    var cardScale = stageH < 1400 ? 0.84 : 1;
    stage.style.setProperty('--card-w', Math.round(P.CARD_W * cardScale) + 'px');
    stage.style.setProperty('--card-h', Math.round(P.CARD_H * cardScale) + 'px');
  }

  /* ============================ 状态 ============================ */
  var st = {
    screen: 'home',
    phase: 'IDLE',        // IDLE | BET | DEAL | ACT | BANKER | SETTLE | OVER
    m: null,              // 本场（Match）
    turn: -1,             // 当前行动/下注的座位
    pick: 1,              // 真人当前选中的下注档
    round: 0,
    deck: [],
    dealerHidden: true,
    busy: false,
    locked: false,        // 自动推进窗口（爆牌/十点半/满张）内的硬锁，谁也点不动
    pendingStand: false,  // 动画期间点了「停牌」：这张发完再兑现，不吞输入
    actQueue: [],
    actPos: 0,
    betQueue: [],
    betPos: 0,
    lastRound: null,
    pendingEnd: null,     // 下一局是否直接结束（'broke' | 'cannot_bank'）
    endReason: null,
    gen: 0,               // 世代号：换了场 / 回首页后，旧的异步回调自动作废
    setup: { mode: 'ai', count: 3 }
  };

  var stats = S.emptyStats(P.START_CHIPS);
  var history = [];
  var unlocked = {};

  /* ============================ 存储 ============================ */
  function loadAll() {
    var raw = S.readJSON(S.KEYS.STATS, null);
    if (raw && typeof raw === 'object') {
      var base = S.emptyStats(P.START_CHIPS);
      for (var k in base) if (raw[k] === undefined) raw[k] = base[k];
      stats = raw;
    }
    var h = S.readJSON(S.KEYS.HISTORY, null);
    history = Array.isArray(h) ? h : [];
    var a = S.readJSON(S.KEYS.ACH, null);
    unlocked = (a && typeof a === 'object') ? a : {};

    var s = S.readJSON(S.KEYS.SETUP, null);
    if (s && typeof s === 'object') {
      if (s.mode === 'ai' || s.mode === 'local') st.setup.mode = s.mode;
      var n = s.count | 0;
      if (n >= P.MIN_SEATS && n <= P.MAX_SEATS) st.setup.count = n;
    }
  }

  function saveStats() { S.write(S.KEYS.STATS, stats); }
  function saveHistory() { S.write(S.KEYS.HISTORY, history.slice(-P.HISTORY_MAX)); }
  function saveAch() { S.write(S.KEYS.ACH, unlocked); }
  function saveSetup() { S.write(S.KEYS.SETUP, st.setup); }

  /* ============================ 牌面 ============================ */
  var imgCache = {};

  function cardSrc(card, w, h) {
    var key = CardLib.cardId(card) + '|' + w + 'x' + h;
    if (!imgCache[key]) imgCache[key] = CardLib.drawCardDataURL(card, w, h);
    return imgCache[key];
  }

  function backSrc(w, h) {
    var key = 'back|' + w + 'x' + h;
    if (!imgCache[key]) imgCache[key] = CardLib.drawCardBackDataURL(w, h);
    return imgCache[key];
  }

  function buildCardEl(card, w, h, faceDown, animate) {
    var img = document.createElement('img');
    img.className = 'card tt-card' + (animate ? ' deal-in' : '') + (faceDown ? ' face-down' : '');
    img.width = w; img.height = h;
    img.style.width = w + 'px';
    img.style.height = h + 'px';
    img.alt = faceDown ? '暗牌' : (CardLib.rankLabel(card.rank) + CardLib.SUIT_SYMBOL[card.suit]);
    img.src = faceDown ? backSrc(w, h) : cardSrc(card, w, h);
    img.draggable = false;
    return img;
  }

  function handSig(cards, extra) {
    return extra + '|' + (cards || []).map(function (c) { return c.rank + c.suit; }).join(',');
  }

  /** 庄家手牌：整宽排布，2–5 张都放得下 */
  function renderDealerCards() {
    var el = $('dCards');
    if (!el) return;
    var d = st.m ? st.m.players[st.m.dealerIdx] : null;
    var cards = (d && d.cards) || [];
    var faceDown = st.dealerHidden && cards.length > 0;
    var sig = handSig(cards, faceDown ? 'back' : 'face') + '|' + (st.m ? st.m.count : 0);
    if (el.dataset.sig === sig) return;
    var first = !el.dataset.sig;
    el.dataset.sig = sig;

    var avail = P.DESIGN_W - P.SCREEN_PAD_X * 2;
    var n = Math.max(cards.length, P.DEAL_TWO);
    var w = Math.min(P.CARD_W, Math.floor((avail - P.CARD_GAP * (n - 1)) / n));
    var h = Math.round(w * (P.CARD_H / P.CARD_W));
    el.innerHTML = '';
    el.style.setProperty('--card-gap', Math.round(P.CARD_GAP * (w / P.CARD_W)) + 'px');

    if (!cards.length) {
      for (var g = 0; g < P.DEAL_TWO; g++) {
        var slot = document.createElement('i');
        slot.className = 'tt-ghost';
        slot.style.width = w + 'px';
        slot.style.height = h + 'px';
        el.appendChild(slot);
      }
      return;
    }
    for (var i = 0; i < cards.length; i++) {
      el.appendChild(buildCardEl(cards[i], w, h, faceDown, !first));
    }
  }

  /**
   * 座位手牌尺寸：座位内宽 ÷ 叠压后的有效张数。
   * 座位宽 = (content − 间隙) / 座位数，内宽再减两侧 padding(8px×2) —— 
   * 少减这一步牌扇就会顶出座位边框（4 人局 5 张牌时最明显）。
   */
  function seatCardSize(seats) {
    var w = (seats <= 1) ? P.SEAT_CARD_W_WIDE : P.SEAT_CARD_W;
    return { w: w, h: Math.round(w * (P.CARD_H / P.CARD_W)) };
  }

  function renderSeatCards(el, cards, seats) {
    if (!el) return;
    var sig = handSig(cards, seats) + '|' + cards.length;
    if (el.dataset.sig === sig) return;
    var first = !el.dataset.sig;
    el.dataset.sig = sig;

    var size = seatCardSize(seats);
    /* 负边距要按「被压掉的比例」算，不是按「露出的比例」：
       想让每张牌前进 w×(1−overlap)，就得压掉 w×overlap。搞反了牌扇会宽出一倍。 */
    var shave = Math.round(size.w * P.SEAT_OVERLAP);
    el.innerHTML = '';
    el.style.minHeight = cards.length ? (size.h + 'px') : '0px';
    /* 第一张按尾对齐，否则叠压方向会让整扇牌偏出座位 */
    for (var i = 0; i < cards.length; i++) {
      var img = buildCardEl(cards[i], size.w, size.h, false, !first);
      if (i > 0) img.style.marginLeft = (-shave) + 'px';
      el.appendChild(img);
    }
  }

  /* ============================ 渲染 ============================ */
  function setStatus(text, tone) {
    var el = $('ttStatus');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'tt-status' + (tone ? ' ' + tone : '');
  }

  function renderTop() {
    $('gBank').textContent = st.m ? st.m.bank : '—';
    $('gRound').textContent = st.round || '—';
    $('gDeck').textContent = st.deck.length;
  }

  function ptsClass(cards) {
    if (!cards || !cards.length) return '';
    if (R.isBust(cards)) return ' bust';
    if (R.isTenHalf(cards)) return ' tenhalf';
    return '';
  }

  function renderDealer() {
    var d = st.m ? st.m.players[st.m.dealerIdx] : null;
    $('dName').textContent = d ? d.name : '—';
    $('dChips').textContent = d ? (d.chips + ' 枚') : '—';

    var el = $('dPts');
    if (!d || !d.cards.length) {
      el.textContent = '';
      el.className = 'tt-pts';
    } else if (st.dealerHidden) {
      el.textContent = '?';
      el.className = 'tt-pts';
    } else {
      el.textContent = R.fmtPoints(R.points(d.cards));
      el.className = 'tt-pts' + ptsClass(d.cards);
    }
    renderDealerCards();
  }

  var seatEls = {};

  function buildSeats() {
    var wrap = $('seats');
    wrap.innerHTML = '';
    seatEls = {};
    if (!st.m) return;
    var seats = Match.playerSeats(st.m);
    for (var k = 0; k < seats.length; k++) {
      var idx = seats[k];
      var el = document.createElement('div');
      el.className = 'seat';
      el.setAttribute('data-seat', String(idx));
      el.innerHTML =
        '<div class="seat-who"><b class="seat-name"></b><span class="seat-chips"></span></div>' +
        '<div class="seat-cards"></div>' +
        '<div class="seat-tally"><b class="seat-pts"></b><span class="seat-bet"></span></div>';
      wrap.appendChild(el);
      seatEls[idx] = {
        root: el,
        name: el.querySelector('.seat-name'),
        chips: el.querySelector('.seat-chips'),
        cards: el.querySelector('.seat-cards'),
        pts: el.querySelector('.seat-pts'),
        bet: el.querySelector('.seat-bet')
      };
    }
  }

  function renderSeats() {
    if (!st.m) return;
    var seats = Match.playerSeats(st.m);
    for (var k = 0; k < seats.length; k++) {
      var idx = seats[k];
      var p = st.m.players[idx];
      var els = seatEls[idx];
      if (!els) continue;

      els.name.textContent = p.name;
      els.chips.textContent = p.chips + ' 枚';
      els.pts.textContent = p.cards.length ? R.fmtPoints(R.points(p.cards)) : '—';
      els.pts.className = 'seat-pts' + ptsClass(p.cards);
      els.bet.textContent = p.bet ? ('注 ' + p.bet) : '未下注';
      els.bet.className = 'seat-bet' + (p.bet ? '' : ' is-empty');

      renderSeatCards(els.cards, p.cards, seats.length);

      els.root.classList.toggle('is-turn',
        (st.phase === 'ACT' || st.phase === 'BET') && st.turn === idx && !p.done);
      els.root.classList.toggle('is-done',
        (st.phase === 'ACT' && p.done) || (st.phase === 'BANKER'));
    }
  }

  function humanActor() {
    if (!st.m) return null;
    if (st.phase === 'ACT') {
      var p = st.m.players[st.turn];
      return (p && !p.isAI) ? p : null;
    }
    if (st.phase === 'BANKER') {
      var d = st.m.players[st.m.dealerIdx];
      return (d && !d.isAI) ? d : null;
    }
    return null;
  }

  function renderBottom() {
    var main = $('btnMain');
    var stand = $('btnStand');
    var row = $('betRow');
    var hint = $('hintLine');
    var betting = st.phase === 'BET';
    var me = (st.m && st.turn >= 0) ? st.m.players[st.turn] : null;
    var humanBet = !!(betting && me && !me.isAI);
    var actor = humanActor();

    row.classList.toggle('is-off', !humanBet);

    /* 停牌键的显隐只在「真人正在行动」时为真 —— 单独算出来，
       不依赖上一次渲染的残留状态（否则它会跨屏留在某个不该出现的界面）。 */
    var showStand = !!actor;
    stand.classList.toggle('hidden', !showStand);
    if (showStand) {
      var permitted = R.canStand(actor.cards);
      stand.disabled = st.busy || st.locked || !permitted;
      stand.classList.toggle('is-locked', !permitted);
    } else {
      stand.disabled = true;
      stand.classList.remove('is-locked');
    }

    if (humanBet) {
      var cap = Match.betCap(me);
      var chips = row.querySelectorAll('.bet-chip');
      for (var i = 0; i < chips.length; i++) {
        var v = parseInt(chips[i].getAttribute('data-bet'), 10);
        var on = v === st.pick;
        chips[i].classList.toggle('is-on', on);
        chips[i].setAttribute('aria-pressed', on ? 'true' : 'false');
        chips[i].disabled = v > cap;
      }
      main.textContent = '确认下注 ' + st.pick;
      main.disabled = st.busy;
      hint.textContent = '只能下 1–3 枚 · 庄家的牌他现在看不见';
      return;
    }

    if (betting) {
      main.textContent = me ? (me.name + ' 下注中…') : '准备发牌…';
      main.disabled = true;
      hint.textContent = '轮流坐庄 · 每人 ' + P.START_CHIPS + ' 枚起步';
      return;
    }

    if (actor) {
      var forced = R.mustHit(actor.cards);
      main.textContent = st.busy ? '发牌中…' : '要牌';
      main.disabled = st.busy || st.locked || !R.canHit(actor.cards);
      hint.textContent = forced
        ? ('点数 ≤ ' + P.FORCE_HIT_MAX + ' 必须继续要牌')
        : '超过 10.5 就爆 · 同点庄赢';
      return;
    }

    if (st.phase === 'DEAL') {
      main.textContent = '发牌中…';
      hint.textContent = '一手定输赢';
    } else if (st.phase === 'BANKER') {
      main.textContent = '庄家行动中…';
      hint.textContent = '庄家低于 ' + P.AI_DEALER_STAND_AT + ' 点继续要牌';
    } else {
      main.textContent = '等待中…';
      hint.textContent = '一手定输赢';
    }
    main.disabled = true;
  }

  function syncStatus() {
    if (!st.m) { setStatus('请选择下注档位'); return; }
    var me = st.turn >= 0 ? st.m.players[st.turn] : null;
    if (st.phase === 'BET') {
      setStatus(me ? ('轮到「' + me.name + '」下注') : '准备发牌…');
    } else if (st.phase === 'DEAL') {
      setStatus('发牌中…');
    } else if (st.phase === 'ACT') {
      if (!me) { setStatus('闲家行动结束'); return; }
      if (me.isAI) setStatus(me.name + ' 正在考虑…');
      else setStatus('轮到「' + me.name + '」要牌或停牌');
    } else if (st.phase === 'BANKER') {
      var d = st.m.players[st.m.dealerIdx];
      setStatus(d.isAI ? '庄家行动中…' : '你是庄家，要牌还是停牌');
    } else if (st.phase === 'SETTLE') {
      setStatus('结算中…');
    }
  }

  function renderHome() {
    var played = stats.wins + stats.losses;
    $('homeRounds').textContent = stats.rounds;
    $('homeRate').textContent = played ? Math.round(stats.wins / played * 100) + '%' : '—';
    $('homeStreak').textContent = stats.bestStreak;
  }

  function renderAll() {
    renderTop();
    renderDealer();
    renderSeats();
    renderBottom();
    renderHome();
    syncStatus();
  }

  /* ============================ 屏幕切换 ============================ */
  var SCREENS = ['home', 'game', 'settle', 'over', 'records', 'ach'];

  function showScreen(name) {
    for (var i = 0; i < SCREENS.length; i++) {
      var el = $('screen-' + SCREENS[i]);
      if (!el) continue;
      el.classList.toggle('hidden', SCREENS[i] !== name);
    }
    st.screen = name;
    var cur = $('screen-' + name);
    if (cur) {
      cur.classList.remove('enter');
      void cur.offsetWidth;               // 强制回流，让动画能重播
      cur.classList.add('enter');
    }
    if (name === 'records') renderRecords();
    if (name === 'ach') renderAch();
    if (name === 'home') renderHome();
  }

  /* ============================ 提示与音效 ============================ */
  var toastTimer = null;

  function toast(msg, warn) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast' + (warn ? ' warn' : '');
    el.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 2000);
  }

  function play(name) {
    try { if (window.Sfx) window.Sfx.play(name); } catch (e) {}
  }

  function syncAudioIcons() {
    var on = true;
    try { on = !window.Sfx || window.Sfx.isSoundEnabled(); } catch (e) { on = true; }
    var btns = document.querySelectorAll('[data-audio-toggle]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('is-off', !on);
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      var a = btns[i].querySelector('.au-on');
      var b = btns[i].querySelector('.au-off');
      if (a) a.classList.toggle('hidden', !on);
      if (b) b.classList.toggle('hidden', on);
    }
    var state = $('soundState');
    if (state) state.textContent = on ? '开' : '关';
    var toggle = $('btnSoundToggle');
    if (toggle) toggle.textContent = on ? '关闭' : '开启';
  }

  function toggleSound() {
    try {
      if (!window.Sfx) return;
      window.Sfx.unlock();
      window.Sfx.setSoundEnabled(!window.Sfx.isSoundEnabled());
    } catch (e) {}
    syncAudioIcons();
  }

  /* ============================ 牌堆 ============================ */
  function ensureDeck() {
    if (st.deck.length < P.RESHUFFLE_AT) {
      var full = CardLib.createDeck().filter(function (c) { return c.suit !== 'joker'; });
      st.deck = CardLib.shuffle(full);
    }
  }

  function drawCard() {
    if (!st.deck.length) ensureDeck();
    return st.deck.pop();
  }

  /* ============================ 开局 ============================ */
  function startMatch() {
    st.gen++;
    st.m = Match.create(st.setup.count, st.setup.mode);
    st.round = 0;
    st.lastRound = null;
    st.pendingEnd = null;
    st.endReason = null;
    st.busy = false;
    st.locked = false;
    st.pendingStand = false;
    saveSetup();

    if (!Match.beginTenure(st.m)) {
      toast('筹码不足，无法上庄', true);
      return;
    }
    buildSeats();
    beginRound();
  }

  function beginRound() {
    var m = st.m;
    m.rounds += 1;
    st.round = m.rounds;
    st.phase = 'BET';
    st.dealerHidden = true;
    st.busy = false;
    st.locked = false;
    st.pendingStand = false;
    st.turn = -1;
    st.pick = P.BET_TIERS[0];
    st.lastRound = null;

    for (var i = 0; i < m.count; i++) {
      m.players[i].cards = [];
      m.players[i].bet = 0;
      m.players[i].done = false;
    }
    ensureDeck();

    st.betQueue = Match.playerSeats(m);
    st.betPos = 0;

    showScreen('game');
    renderAll();
    advanceBet();
  }

  /* ---------- 下注 ---------- */
  function advanceBet() {
    var gen = st.gen;
    while (st.betPos < st.betQueue.length) {
      var idx = st.betQueue[st.betPos];
      var p = st.m.players[idx];
      if (Match.betCap(p) <= 0) { st.betPos++; continue; }

      st.turn = idx;
      if (p.isAI) {
        st.busy = true;
        renderAll();
        setTimeout(function () {
          if (gen !== st.gen || st.phase !== 'BET') return;
          p.bet = aiBet(p);
          play('select');
          st.busy = false;
          st.betPos++;
          renderAll();
          advanceBet();
        }, P.AI_THINK_MS);
        return;
      }
      st.pick = Math.min(P.BET_TIERS[0], Match.betCap(p));
      renderAll();
      return;
    }

    st.turn = -1;
    dealAll();
  }

  function aiBet(p) {
    var cap = Match.betCap(p);
    /* 电脑按筹码紧张程度收手：不够上庄的钱就别猛下 */
    var r = Math.random();
    var want = (p.chips <= P.BANK + 2) ? 1 : (r < 0.45 ? 1 : (r < 0.8 ? 2 : 3));
    return Math.max(1, Math.min(cap, want));
  }

  function chooseBet(v) {
    if (st.phase !== 'BET') return;
    var p = st.m.players[st.turn];
    if (!p || p.isAI) return;
    if (v > Match.betCap(p)) { toast('筹码不够下这一档', true); return; }
    st.pick = v;
    play('select');
    renderBottom();
  }

  function confirmBet() {
    if (st.phase !== 'BET' || st.busy) return;
    var p = st.m.players[st.turn];
    if (!p || p.isAI) return;
    if (st.pick > Match.betCap(p)) { toast('筹码不够下这一档', true); return; }

    p.bet = st.pick;
    play('submit');
    st.betPos++;
    renderAll();
    advanceBet();
  }

  /* ---------- 发牌 ---------- */
  async function dealAll() {
    var gen = st.gen;
    st.phase = 'DEAL';
    st.busy = true;
    renderAll();
    setStatus('发牌中…');

    var order = Match.playerSeats(st.m).concat([st.m.dealerIdx]);
    for (var r = 0; r < P.DEAL_TWO; r++) {
      for (var k = 0; k < order.length; k++) {
        if (gen !== st.gen) return;
        var p = st.m.players[order[k]];
        p.cards.push(drawCard());
        play('deal');
        renderAll();
        await wait(P.DEAL_STAGGER_MS);
      }
    }
    if (gen !== st.gen) return;
    await wait(P.DEAL_MS);
    if (gen !== st.gen) return;

    st.busy = false;
    st.phase = 'ACT';
    st.actQueue = Match.playerSeats(st.m);
    st.actPos = 0;
    renderAll();
    nextActor();
  }

  /* ---------- 闲家行动 ---------- */
  function nextActor() {
    var gen = st.gen;
    while (st.actPos < st.actQueue.length) {
      var idx = st.actQueue[st.actPos];
      var p = st.m.players[idx];
      if (p.done) { st.actPos++; continue; }

      st.turn = idx;
      if (p.isAI) { renderAll(); aiAct(p, gen); return; }
      renderAll();
      return;
    }
    st.turn = -1;
    renderAll();
    startBanker();
  }

  async function aiAct(p, gen) {
    st.busy = true;
    renderAll();
    await wait(P.AI_THINK_MS);
    if (gen !== st.gen) return;

    if (!R.aiPlayerShouldHit(p.cards)) {
      st.busy = false;
      finishActor(p);
      return;
    }
    st.busy = false;
    await pushCard(p, gen);
    if (gen !== st.gen) return;
    if (afterCard(p, gen)) return;          // 判定为「本座结束」
    aiAct(p, gen);
  }

  /** 发一张给某人，返回 Promise（动画结束） */
  async function pushCard(p, gen) {
    p.cards.push(drawCard());
    play('deal');
    st.busy = true;
    renderAll();
    await wait(P.DEAL_MS);
    if (gen !== st.gen) return;
    st.busy = false;
    renderAll();
  }

  /**
   * 一张牌落下后的收尾判定。返回 true 表示「这一座已经结束，该换人」。
   * 爆牌、十点半、满张都自动结束 —— 不给玩家留没有决策空间的按钮。
   */
  function afterCard(p, gen) {
    /* 进入「自动推进」窗口时把输入锁上：
       否则十点半 / 爆牌之后的那 500ms 里还能再点一次要牌，牌局会被推成第二个结果。 */
    function auto(msg, tone, snd) {
      st.busy = true;
      st.locked = true;
      setStatus(msg, tone);
      if (snd) play(snd);
      renderAll();
      setTimeout(function () {
        if (gen !== st.gen) return;
        finishActor(p);
      }, P.AUTO_ADVANCE_MS);
    }

    if (R.isBust(p.cards)) {
      auto(p.name + ' 爆牌了', 'danger', 'settle');
      return true;
    }
    if (R.isTenHalf(p.cards)) {
      auto(p.name + ' 十点半！', 'hot', 'win');
      return true;
    }
    if (R.isFull(p.cards)) {
      auto(p.name + ' 满 ' + P.MAX_CARDS + ' 张，自动停牌', 'hot', null);
      return true;
    }
    renderAll();
    return false;
  }

  /** 结束某人的行动：闲家推进到下一位，庄家进入结算 */
  function finishActor(p) {
    st.busy = false;
    st.locked = false;
    st.pendingStand = false;

    if (st.phase === 'ACT') {
      p.done = true;
      st.actPos++;
      renderAll();
      nextActor();
      return;
    }
    if (st.phase === 'BANKER') {
      renderAll();
      finishRound();
    }
  }

  /* ---------- 要牌 / 停牌 ---------- */
  async function hit() {
    if (st.busy || st.locked) return;
    var p = humanActor();
    if (!p) return;
    if (!R.canHit(p.cards)) return;

    var gen = st.gen;
    var phase = st.phase;
    await pushCard(p, gen);
    if (gen !== st.gen || st.phase !== phase) return;
    if (afterCard(p, gen)) return;
    /* 停牌意图在动画期间按下：这里兑现 */
    if (st.pendingStand) {
      st.pendingStand = false;
      stand();
    }
  }

  function stand() {
    if (st.locked) return;              // 爆牌/十点半/满张的自动推进窗口：不接受停牌
    var p = humanActor();
    if (!p) return;
    if (st.busy) {
      st.pendingStand = true;
      setStatus('这张发完就停牌', 'hot');
      return;
    }
    if (!R.canStand(p.cards)) {
      toast('点数 ≤ ' + P.FORCE_HIT_MAX + ' 必须继续要牌', true);
      return;
    }
    play('select');
    finishActor(p);
  }

  /* ---------- 庄家 ---------- */
  async function startBanker() {
    var gen = st.gen;
    st.phase = 'BANKER';
    st.dealerHidden = false;              // 亮牌
    st.busy = false;
    renderAll();
    play('select');
    await wait(P.REVEAL_MS);
    if (gen !== st.gen) return;

    var d = st.m.players[st.m.dealerIdx];
    if (!d.isAI) { renderAll(); return; }  // 真人庄家自己点

    while (R.aiDealerShouldHit(d.cards)) {
      d.cards.push(drawCard());
      play('deal');
      renderAll();
      await wait(P.DEAL_MS + 40);
      if (gen !== st.gen) return;
    }
    await wait(P.SETTLE_DELAY_MS);
    if (gen !== st.gen) return;
    finishRound();
  }

  /* ============================ 结算 ============================ */
  function finishRound() {
    var m = st.m;
    var d = m.players[m.dealerIdx];
    var entries = Match.playerSeats(m).map(function (idx) {
      return { seat: idx, bet: m.players[idx].bet, cards: m.players[idx].cards };
    });

    var bankBefore = m.bank;
    var out = R.settleRound(d.cards, entries, bankBefore);
    m.bank = out.bank;
    for (var i = 0; i < out.results.length; i++) {
      m.players[out.results[i].seat].chips += out.results[i].amount;
    }

    var left = R.bankerShouldLeave(m.bank);
    var bankAfter = m.bank;
    if (left) Match.endTenure(m);          // 庄池归庄家，m.bank → 0

    st.pendingEnd = Match.endReason(m, left ? Match.nextSeat(m, m.dealerIdx) : null);
    st.lastRound = {
      results: out.results,
      dealer: m.dealerIdx,
      dealerCards: d.cards.slice(),
      dealerPts: R.points(d.cards),
      bankBefore: bankBefore,
      bankAfter: bankAfter,
      bankDelta: bankAfter - bankBefore,
      dealerLeft: left
    };

    updateStats(st.lastRound);
    pushHistory(st.lastRound);

    st.phase = 'SETTLE';
    renderSettle();
    showScreen('settle');
    play(st.lastRound.bankDelta > 0 ? 'win' : 'settle');
    checkAchievements();
  }

  function mySeat() { return 0; }

  function myResult(lr) {
    if (!lr) return null;
    if (lr.dealer === mySeat()) {
      return { asDealer: true, amount: lr.bankDelta, win: lr.bankDelta > 0, bet: 0 };
    }
    for (var i = 0; i < lr.results.length; i++) {
      if (lr.results[i].seat === mySeat()) {
        var r = lr.results[i];
        return { asDealer: false, amount: r.amount, win: r.win, bet: r.bet, res: r };
      }
    }
    return null;
  }

  function renderSettle() {
    var lr = st.lastRound;
    var m = st.m;
    var me = myResult(lr);
    var badge = $('stBadge');
    var net = $('stNet');

    var myCards = m.players[mySeat()].cards;
    var isTH = R.isTenHalf(myCards);
    var amt = me ? me.amount : 0;
    badge.textContent = isTH ? '十点半' : (amt > 0 ? '胜' : amt < 0 ? '负' : '平');
    badge.className = 'st-badge ' + (isTH ? 'tenhalf' : (amt > 0 ? 'win' : amt < 0 ? 'lose' : 'push'));

    net.textContent = (amt > 0 ? '+' : '') + amt;
    net.className = 'st-net ' + (amt > 0 ? 'pos' : amt < 0 ? 'neg' : 'zero');

    var sub;
    if (me && me.asDealer) {
      sub = lr.dealerLeft
        ? (lr.bankAfter >= P.BANK + P.BANK_WIN ? '赢够 ' + P.BANK_WIN + ' 枚 · 下庄' : '庄池输光 · 下庄')
        : '坐庄中 · 庄池 ' + lr.bankAfter;
    } else if (me && me.res) {
      sub = R.REASON_TEXT[me.res.reason] || '';
      var mt = R.multText(me.res.mult);
      if (mt) sub += ' · ' + mt;
      if (me.res.shortPaid) sub += '（庄池不够，只赔到 ' + me.amount + '）';
    } else {
      sub = '';
    }
    $('stSub').textContent = sub;

    /* 逐人明细：庄家一行 + 每个闲家一行 */
    var list = $('rsList');
    list.innerHTML = '';

    var d = m.players[lr.dealer];
    list.appendChild(settleRow({
      name: d.name,
      isDealer: true,
      pts: R.fmtPoints(lr.dealerPts),
      ptsClass: ptsClass(lr.dealerCards),
      tag: '庄',
      net: lr.bankDelta
    }));

    for (var i = 0; i < lr.results.length; i++) {
      var r = lr.results[i];
      var p = m.players[r.seat];
      list.appendChild(settleRow({
        name: p.name,
        isDealer: false,
        pts: R.fmtPoints(r.pPts),
        vs: R.fmtPoints(r.dPts),
        ptsClass: ptsClass(p.cards),
        win: r.win,
        mult: r.mult,
        net: r.amount
      }));
    }

    $('stBank').textContent = lr.bankBefore + ' → ' + lr.bankAfter;
    $('stDealer').textContent = lr.dealerLeft
      ? ('下庄 · 换 ' + m.players[Match.nextSeat(m, lr.dealer)].name + ' 坐庄')
      : '继续坐庄';
    $('stChips').textContent = m.players[mySeat()].chips;

    var next = $('btn-next');
    if (st.pendingEnd) {
      next.textContent = '本场结束';
    } else {
      next.textContent = '下一局';
    }
  }

  function settleRow(o) {
    var row = document.createElement('div');
    row.className = 'rs-row' + (o.isDealer ? ' is-dealer' : '');

    var name = document.createElement('b');
    name.className = 'rs-name';
    var nm = document.createElement('span');
    nm.textContent = o.name;
    name.appendChild(nm);
    if (o.isDealer) {
      var tag = document.createElement('i');
      tag.className = 'rs-tag-mini';
      tag.textContent = '庄';
      name.appendChild(tag);
    }
    row.appendChild(name);

    var pts = document.createElement('span');
    pts.className = 'rs-pts';
    pts.innerHTML = '<b class="' + (o.ptsClass || '').trim() + '">' + o.pts + '</b>'
      + (o.vs ? ' : ' + o.vs : '');
    row.appendChild(pts);

    var tagEl = document.createElement('span');
    if (o.isDealer) {
      tagEl.className = 'rs-tag ' + (o.net > 0 ? 'win' : o.net < 0 ? 'lose' : '');
      tagEl.textContent = '庄池';
    } else {
      tagEl.className = 'rs-tag ' + (o.win ? 'win' : 'lose');
      tagEl.textContent = (o.win ? '胜' : '负') + R.multText(o.mult);
    }
    row.appendChild(tagEl);

    var net = document.createElement('b');
    net.className = 'rs-net ' + (o.net > 0 ? 'pos' : o.net < 0 ? 'neg' : 'zero');
    net.textContent = (o.net > 0 ? '+' : '') + o.net;
    row.appendChild(net);

    return row;
  }

  function nextRound() {
    var m = st.m;
    if (!m) { showScreen('home'); return; }
    if (st.pendingEnd) { endMatch(st.pendingEnd); return; }

    if (st.lastRound && st.lastRound.dealerLeft) {
      Match.rotate(m);
      if (!Match.beginTenure(m)) { endMatch('cannot_bank'); return; }
    }
    beginRound();
  }

  function endMatch(reason) {
    var m = st.m;
    if (m.bank > 0) Match.endTenure(m);     // 庄池归庄家，排名按真实筹码
    st.phase = 'OVER';
    st.endReason = reason;
    renderOver(reason);
    showScreen('over');
    play('settle');
  }

  function renderOver(reason) {
    var m = st.m;
    var txt = {
      broke: '有人筹码用尽，本场结束',
      cannot_bank: '轮到坐庄的人筹码不够 ' + P.BANK + ' 枚，本场结束'
    };
    $('ovReason').textContent = txt[reason] || '本场结束';

    var list = $('ovList');
    list.innerHTML = '';
    var rank = Match.ranking(m);
    for (var i = 0; i < rank.length; i++) {
      var row = document.createElement('div');
      row.className = 'rs-row' + (rank[i].i === 0 ? ' is-dealer' : '');

      var tag = document.createElement('span');
      tag.className = 'ov-rank' + (i === 0 ? ' top' : '');
      tag.textContent = String(i + 1);
      row.appendChild(tag);

      var name = document.createElement('b');
      name.className = 'rs-name';
      var nm = document.createElement('span');
      nm.textContent = rank[i].name + (rank[i].i === 0 ? '（你）' : '');
      name.appendChild(nm);
      row.appendChild(name);

      var net = document.createElement('b');
      net.className = 'rs-net ' + (rank[i].chips > P.START_CHIPS ? 'pos' : rank[i].chips < P.START_CHIPS ? 'neg' : 'zero');
      net.textContent = rank[i].chips + ' 枚';
      row.appendChild(net);
      list.appendChild(row);
    }
  }

  /* ============================ 统计与成就 ============================ */
  function updateStats(lr) {
    var m = st.m;
    var me = myResult(lr);
    var myCards = m.players[mySeat()].cards;

    stats.rounds += 1;

    if (me && me.win) {
      stats.wins += 1;
      stats.streak += 1;
      if (stats.streak > stats.bestStreak) stats.bestStreak = stats.streak;
    } else {
      stats.losses += 1;
      stats.streak = 0;
    }

    if (R.isTenHalf(myCards)) stats.tenHalfCount += 1;

    if (me && !me.asDealer && me.res) {
      var r = me.res;
      if (r.pFull && !r.pBust && r.win) {
        stats.fiveWinCount += 1;
        if (r.pTenHalf) stats.fiveTenHalfCount += 1;
      }
      if (r.pBust && r.pFull) stats.fiveBustCount += 1;
      if (r.dBust) stats.dealerBustCount += 1;
    }
    if (me && me.asDealer) {
      stats.dealerRounds += 1;
      if (lr.dealerLeft && lr.bankAfter >= P.BANK + P.BANK_WIN) stats.dealerWinTenure += 1;
    }

    var amt = me ? me.amount : 0;
    if (amt > stats.bestWin) stats.bestWin = amt;

    var p0 = m.players[mySeat()].chips;
    if (p0 > stats.peak) stats.peak = p0;

    if (!R.isBust(myCards)) {
      stats.clean += 1;
      if (stats.clean > stats.bestClean) stats.bestClean = stats.clean;
    } else {
      stats.clean = 0;
    }

    saveStats();
  }

  function pushHistory(lr) {
    var m = st.m;
    var me = myResult(lr);
    history.push({
      t: Date.now(),
      asDealer: !!(me && me.asDealer),
      bet: me ? me.bet : 0,
      outcome: (me && me.win) ? 'win' : 'lose',
      reason: (me && me.res) ? me.res.reason : (me && me.asDealer ? 'banker' : ''),
      p: (me && me.res) ? me.res.pPts : lr.dealerPts,
      d: lr.dealerPts,
      delta: me ? me.amount : 0,
      chips: m.players[mySeat()].chips,
      tenHalf: R.isTenHalf(m.players[mySeat()].cards)
    });
    history = history.slice(-P.HISTORY_MAX);
    saveHistory();
  }

  function checkAchievements() {
    var newly = Ach.diffUnlocked(stats, unlocked);
    var box = $('stAch');
    if (!newly.length) {
      if (box) { box.textContent = ''; box.classList.add('hidden'); }
      return;
    }
    for (var i = 0; i < newly.length; i++) unlocked[newly[i].id] = Date.now();
    saveAch();

    /* 成就提示写在结算卡里，而不是弹 toast：
       toast 固定在底部 180px，正好压住「下一局」按钮 —— 玩家最想点的地方被挡住。 */
    if (box) {
      box.textContent = '解锁成就：' + newly[0].name
        + (newly.length > 1 ? ' 等 ' + newly.length + ' 个' : '');
      box.classList.remove('hidden');
    }
  }

  /* ============================ 战绩 ============================ */
  function fmtTime(ts) {
    try {
      var d = new Date(ts);
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    } catch (e) { return '--:--'; }
  }

  function renderRecords() {
    var played = stats.wins + stats.losses;
    $('rpPeakBig').textContent = stats.peak;
    $('rpGames').textContent = stats.rounds;
    $('rpWinrate').textContent = played ? Math.round(stats.wins / played * 100) + '%' : '0%';
    $('rpWins').textContent = stats.wins;
    $('rpLosses').textContent = stats.losses;
    $('rpTenHalf').textContent = stats.tenHalfCount;
    $('rpStreak').textContent = stats.bestStreak;
    $('rpBestWin').textContent = stats.bestWin;
    $('rpFive').textContent = stats.fiveWinCount;
    $('achEntryNum').textContent = Ach.unlockedIds(stats).length + '/' + Ach.TOTAL;

    var list = $('rpList');
    list.innerHTML = '';
    var rows = history.slice().reverse();
    $('rpListCount').textContent = rows.length + ' 局';

    if (!rows.length) {
      list.innerHTML = '<li class="rp-row"><div class="rp-row-left">'
        + '<span class="rp-time" style="color:rgba(255,247,232,.5)">还没有记录</span>'
        + '<span class="rp-people">打一局就有</span></div><span class="rp-net">—</span></li>';
      return;
    }

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var li = document.createElement('li');
      li.className = 'rp-row';

      var left = document.createElement('div');
      left.className = 'rp-row-left';

      var res = document.createElement('span');
      res.className = 'rp-time';
      res.textContent = r.asDealer ? '坐庄' : (r.tenHalf ? '十点半' : (r.outcome === 'win' ? '胜' : '负'));
      left.appendChild(res);

      var meta = document.createElement('span');
      meta.className = 'rp-people';
      meta.textContent = fmtTime(r.t) + (r.asDealer ? ' · 庄池' : ' · 注 ' + r.bet);
      left.appendChild(meta);

      var net = document.createElement('span');
      net.className = 'rp-net ' + (r.delta > 0 ? 'pos' : r.delta < 0 ? 'neg' : '');
      net.textContent = (r.delta > 0 ? '+' : '') + r.delta;

      li.appendChild(left);
      li.appendChild(net);
      list.appendChild(li);
    }
  }

  /* ============================ 成就 ============================ */
  function renderAch() {
    var grid = $('achGrid');
    grid.innerHTML = '';
    var got = Ach.unlockedIds(stats);
    $('achUnlocked').textContent = got.length;
    $('achTotal').textContent = Ach.TOTAL;

    for (var i = 0; i < Ach.CATALOG.length; i++) {
      var a = Ach.CATALOG[i];
      var isOk = got.indexOf(a.id) >= 0;
      var li = document.createElement('li');
      li.className = 'ach-card' + (isOk ? ' is-ok' : '');
      li.innerHTML =
        '<div class="ach-card-top">' +
        '<span class="ach-badge">' + (isOk ? '★' : '☆') + '</span>' +
        '<span class="ach-rarity">' + (isOk ? '已解锁' : '未解锁') + '</span>' +
        '</div>' +
        '<div class="ach-name">' + a.name + '</div>' +
        '<p class="ach-desc">' + a.desc + '</p>';
      grid.appendChild(li);
    }
  }

  /* ============================ 弹窗 ============================ */
  function openModal(id) {
    var el = $(id);
    if (!el) return;
    el.classList.remove('hidden');
    if (stage) stage.classList.add('modal-open');
  }

  function closeModal(id) {
    var el = $(id);
    if (!el) return;
    el.classList.add('hidden');
    if (stage) stage.classList.remove('modal-open');
  }

  /* ============================ 安装与网络 ============================ */
  function isStandalone() {
    return (window.navigator.standalone === true) ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  }

  function isIOS() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function updateInstallBar() {
    var bar = $('install-bar');
    if (!bar) return;
    if (isStandalone()) { bar.classList.add('hidden'); return; }
    if (window.__sdInstallPrompt) {
      bar.classList.remove('hidden');
      $('install-text').textContent = '添加到桌面，下次一点就开';
      $('install-go').textContent = '安装';
      return;
    }
    if (isIOS()) {
      bar.classList.remove('hidden');
      $('install-text').textContent = '添加到主屏幕，离线也能玩';
      $('install-go').textContent = '看步骤';
    }
  }

  function doInstall() {
    var p = window.__sdInstallPrompt;
    if (p && p.prompt) {
      p.prompt();
      p.userChoice && p.userChoice.then(function () {
        window.__sdInstallPrompt = null;
        updateInstallBar();
      });
      return;
    }
    var steps = $('install-steps');
    if (steps) {
      steps.classList.remove('hidden');
      steps.textContent = 'Safari：点底部「分享」→「添加到主屏幕」→ 添加。';
    }
  }

  function syncNet() {
    var off = !navigator.onLine;
    var banner = $('net-banner');
    if (!banner) return;
    banner.classList.toggle('hidden', !off);
    document.body.classList.toggle('has-net-banner', off);
  }

  /* ============================ 开局弹窗 ============================ */
  function renderSetup() {
    var segMode = $('segMode');
    var segCount = $('segCount');
    var btns = segMode.querySelectorAll('.seg-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('is-on', btns[i].getAttribute('data-mode') === st.setup.mode);
    }
    var cb = segCount.querySelectorAll('.seg-btn');
    for (var j = 0; j < cb.length; j++) {
      cb[j].classList.toggle('is-on', parseInt(cb[j].getAttribute('data-count'), 10) === st.setup.count);
    }
    var aiCount = st.setup.count - 1;
    $('setupNote').textContent = st.setup.mode === 'local'
      ? (st.setup.count + ' 人同屏 · 一台手机轮流操作 · 每人 ' + P.START_CHIPS + ' 枚 · 轮流坐庄')
      : ('你 + ' + aiCount + ' 位电脑 · 每人 ' + P.START_CHIPS + ' 枚 · 轮流坐庄');
  }

  /* ============================ 绑定 ============================ */
  function bind() {
    $('btn-start').addEventListener('click', function () {
      renderSetup();
      openModal('modal-setup');
    });

    $('segMode').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.seg-btn') : null;
      if (!b) return;
      st.setup.mode = b.getAttribute('data-mode');
      play('select');
      renderSetup();
    });

    $('segCount').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.seg-btn') : null;
      if (!b) return;
      st.setup.count = parseInt(b.getAttribute('data-count'), 10);
      play('select');
      renderSetup();
    });

    $('btnSetupGo').addEventListener('click', function () {
      play('submit');
      closeModal('modal-setup');
      startMatch();
    });

    $('btnMain').addEventListener('click', function () {
      if (st.phase === 'BET') confirmBet();
      else if (st.phase === 'ACT' || st.phase === 'BANKER') hit();
    });

    $('btnStand').addEventListener('click', stand);

    $('betRow').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.bet-chip') : null;
      if (!btn) return;
      chooseBet(parseInt(btn.getAttribute('data-bet'), 10));
    });

    $('btn-next').addEventListener('click', nextRound);
    $('btn-again').addEventListener('click', function () {
      renderSetup();
      openModal('modal-setup');
    });

    $('btn-settle-records').addEventListener('click', function () { showScreen('records'); });
    $('btn-settle-home').addEventListener('click', function () {
      st.gen++;
      showScreen('home');
    });
    $('btn-over-records').addEventListener('click', function () { showScreen('records'); });
    $('btn-over-home').addEventListener('click', function () {
      st.gen++;
      showScreen('home');
    });

    /* 牌局进行中按返回：先按「停牌」把这局结算完，再让玩家走。
       直接切回首页会把已下的注静默吞掉 —— 那不是「退出」，是「白扣一次筹码」。 */
    $('btn-game-home').addEventListener('click', function () {
      if (st.phase === 'BET') { st.gen++; showScreen('home'); return; }
      if (st.phase === 'ACT' && humanActor()) {
        toast('先按停牌把这局结算完');
        stand();
        return;
      }
      toast('这一局还没结算完，稍等一下');
    });

    $('btn-records-home').addEventListener('click', function () { showScreen('records'); });
    $('btn-records-back').addEventListener('click', function () { showScreen('home'); });
    $('btn-ach-home').addEventListener('click', function () { showScreen('ach'); });
    $('btn-ach-back').addEventListener('click', function () { showScreen('home'); });
    $('btn-ach-from-records').addEventListener('click', function () { showScreen('ach'); });

    $('btn-rules').addEventListener('click', function () { openModal('modal-rules'); });
    $('btn-settings').addEventListener('click', function () { openModal('modal-settings'); });

    document.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-close]') : null;
      if (t) { closeModal(t.getAttribute('data-close')); return; }
      if (e.target.classList && e.target.classList.contains('modal')) {
        closeModal(e.target.id);
      }
    });

    var soundBtns = document.querySelectorAll('[data-audio-toggle]');
    for (var i = 0; i < soundBtns.length; i++) {
      soundBtns[i].addEventListener('click', toggleSound);
    }
    $('btnSoundToggle').addEventListener('click', toggleSound);

    $('btnClearData').addEventListener('click', function () {
      $('dataState').textContent = '将清空 ' + stats.rounds + ' 局记录与全部成就';
      openModal('modal-clear');
    });

    $('btnClearConfirm').addEventListener('click', function () {
      S.remove(S.KEYS.STATS);
      S.remove(S.KEYS.HISTORY);
      S.remove(S.KEYS.ACH);
      stats = S.emptyStats(P.START_CHIPS);
      history = [];
      unlocked = {};
      closeModal('modal-clear');
      closeModal('modal-settings');
      toast('已清空本机数据');
      showScreen('home');
      renderHome();
    });

    $('btn-install').addEventListener('click', doInstall);
    $('btn-install-x').addEventListener('click', function () {
      $('install-bar').classList.add('hidden');
    });

    window.addEventListener('online', syncNet);
    window.addEventListener('offline', syncNet);
    window.addEventListener('beforeinstallprompt', function () { updateInstallBar(); });

    /* 首次手势解锁音频（浏览器自动播放策略） */
    function unlockOnce() {
      try { if (window.Sfx) { window.Sfx.unlock(); window.Sfx.startBgm(); } } catch (e) {}
      document.removeEventListener('touchstart', unlockOnce, true);
      document.removeEventListener('mousedown', unlockOnce, true);
    }
    document.addEventListener('touchstart', unlockOnce, true);
    document.addEventListener('mousedown', unlockOnce, true);

    /* 双指/双击缩放拦截：牌桌已整体缩放，再叠浏览器缩放会让牌看不清 */
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); }, { passive: false });
    document.addEventListener('dblclick', function (e) { e.preventDefault(); }, { passive: false });

    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', function () { setTimeout(resize, 120); });
    if (window.visualViewport && window.visualViewport.addEventListener) {
      window.visualViewport.addEventListener('resize', resize);
    }
  }

  /* ============================ 启动 ============================ */
  function boot() {
    viewport = $('viewport');
    stage = $('stage');

    loadAll();
    ensureDeck();
    resize();
    syncNet();
    syncAudioIcons();
    updateInstallBar();
    showScreen('home');
    renderAll();
    bind();

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js').catch(function () {});
      });
    }

    /* 诊断口：探针与真机排查用，只读 + 一个测试缝 */
    window.SD = {
      snapshot: function () {
        var m = st.m;
        return {
          screen: st.screen,
          phase: st.phase,
          round: st.round,
          turn: st.turn,
          busy: st.busy,
          pendingStand: st.pendingStand,
          dealerHidden: st.dealerHidden,
          bank: m ? m.bank : 0,
          dealer: m ? m.dealerIdx : -1,
          endReason: st.endReason,
          pendingEnd: st.pendingEnd,
          deck: st.deck.length,
          players: m ? m.players.map(function (p) {
            return {
              name: p.name, isAI: p.isAI, chips: p.chips, bet: p.bet,
              done: p.done, cards: p.cards.slice(),
              pts: R.points(p.cards), bust: R.isBust(p.cards),
              five: R.isFull(p.cards), canStand: R.canStand(p.cards)
            };
          }) : [],
          lastRound: st.lastRound ? {
            bankBefore: st.lastRound.bankBefore,
            bankAfter: st.lastRound.bankAfter,
            dealerLeft: st.lastRound.dealerLeft,
            results: st.lastRound.results.map(function (r) {
              return { seat: r.seat, bet: r.bet, amount: r.amount, win: r.win, mult: r.mult, reason: r.reason };
            })
          } : null
        };
      },
      stats: function () { return JSON.parse(JSON.stringify(stats)); },
      ach: function () { return Ach.unlockedIds(stats); },
      /* 测试缝：探针用它固定住手牌，才能确定性地验证「点数 ≤6 停不了」这类规则。
         只在调试脚本里调用，正常游玩不会走到。 */
      debug: {
        setHand: function (seat, ranks) {
          var m = st.m;
          if (!m || !m.players[seat]) return false;
          m.players[seat].cards = ranks.map(function (r) {
            return { rank: r, suit: 'spade' };
          });
          var el = seat === m.dealerIdx ? $('dCards') : (seatEls[seat] ? seatEls[seat].cards : null);
          if (el) el.dataset.sig = '';
          renderAll();
          return true;
        }
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
