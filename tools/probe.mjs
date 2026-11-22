/**
 * 真实浏览器验收探针（Edge headless + CDP）
 *
 * 这一版必须验的东西（都是「HTTP 200 证明不了」的）：
 *   ① 首页 → 开局弹窗 → 选玩法/人数 → 进牌桌
 *   ② 牌桌上真的画出 人数−1 个闲家座位，庄池 = 20
 *   ③ 下注档位矩形在可视区内（上一版真机「空的」就是这条挂了）
 *   ④ 好友同玩 3 人：逐人下注 → 逐人要牌/停牌 → 逐人结算，行数对得上
 *   ⑤ 筹码守恒：所有人筹码 + 庄池 = 50 × 人数
 *   ⑥ 点数 ≤ 6 时停牌键必须禁用，且真点击不生效（用户实测到的漏洞）
 *   ⑦ 人机 3 人：电脑能自己下注和行动，一局能走完
 *   ⑧ 离线冷启动 + 能开局
 *
 * 跑法：node tools/probe.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = process.env.PROBE_URL || 'http://127.0.0.1:18888/index.html';
const PORT = 9333;
const OUT = 'tmp-shots';

const results = [];
function note(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

let msgId = 0;
const pending = new Map();
let ws;
const pageErrors = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
    }, 15000);
  });
}

async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('JS 异常: ' + (r.exceptionDetails.text || ''));
  return r.result.value;
}

async function shot(name) {
  await sleep(420);        // 等 .screen.enter 的 320ms 转场跑完，否则截到半张牌桌
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const p = `${OUT}/${name}.png`;
  writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}

/** 取元素中心点，并断言它在可视区内 */
async function rectOf(sel) {
  return evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { x: r.x, y: r.y, w: r.width, h: r.height,
             cx: r.x + r.width / 2, cy: r.y + r.height / 2,
             vis: cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05,
             disabled: !!el.disabled,
             vh: window.innerHeight, vw: window.innerWidth };
  })()`);
}

async function click(sel, label) {
  const r = await rectOf(sel);
  if (!r) throw new Error('找不到元素: ' + sel);
  if (!r.vis) throw new Error(`${label || sel} 不可见`);
  if (r.cy < 0 || r.cy > r.vh || r.cx < 0 || r.cx > r.vw) {
    throw new Error(`${label || sel} 在可视区外: cx=${Math.round(r.cx)} cy=${Math.round(r.cy)} vh=${r.vh}`);
  }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: r.cx, y: r.cy, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0
    });
    await sleep(30);
  }
  await sleep(120);
  return r;
}

async function waitFor(expr, timeout = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evalJs(expr)) return true;
    await sleep(110);
  }
  return false;
}

const snap = () => evalJs('window.SD.snapshot()');

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的 page target');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      pageErrors.push((d.exception && d.exception.description) || d.text || 'exception');
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      /* net::ERR_* 是断网测试的预期产物（导航先走网络、失败再回退 SW 缓存），
         真正的资源缺失会以「404 / 500」的形式出现，不会被这条过滤掉。 */
      if (!/net::ERR_/.test(m.params.entry.text)) pageErrors.push(m.params.entry.text);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
}

async function openSetup(mode, count) {
  await click('#btn-start', '开始游戏');
  const opened = await waitFor(`!document.getElementById('modal-setup').classList.contains('hidden')`, 2500);
  await click(`#segMode .seg-btn[data-mode="${mode}"]`, '选玩法');
  await click(`#segCount .seg-btn[data-count="${count}"]`, '选人数');
  await click('#btnSetupGo', '开始');
  return opened;
}

/**
 * 驱动所有「真人」回合，直到结算。
 * 每一步都读一次 snapshot 再决定点哪个键，所以它对 AI 停留、动画长度都不敏感。
 */
async function driveHumans(deadlineMs, onBet) {
  const deadline = Date.now() + deadlineMs;
  let betSeen = false;
  while (Date.now() < deadline) {
    const s = await snap();
    if (s.phase === 'SETTLE' || s.phase === 'OVER') return { ok: true, betSeen };

    if (s.phase === 'BET') {
      const p = s.players[s.turn];
      if (p && !p.isAI) {
        if (!betSeen && onBet) { betSeen = await onBet(); }
        else {
          await click('.bet-chip[data-bet="1"]', '下注 1').catch(() => {});
          await click('#btnMain', '确认下注').catch(() => {});
          betSeen = true;
        }
      }
    } else if (s.phase === 'ACT') {
      const p = s.players[s.turn];
      if (p && !p.isAI) {
        if (p.canStand) await click('#btnStand', '停牌').catch(() => {});
        else await click('#btnMain', '要牌').catch(() => {});
      }
    } else if (s.phase === 'BANKER') {
      const d = s.players[s.dealer];
      if (d && !d.isAI) {
        if (d.canStand) await click('#btnStand', '庄家停牌').catch(() => {});
        else await click('#btnMain', '庄家要牌').catch(() => {});
      }
    }
    await sleep(150);
  }
  return { ok: false, betSeen };
}

/* ==================== 场景 A：好友同玩 3 人 ==================== */
async function sceneLocal(width, height) {
  const tag = `local-${width}x${height}`;
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 2, mobile: true, screenWidth: width, screenHeight: height
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: BASE });
  await sleep(900);
  await waitFor('!!window.SD', 8000);

  const home = await rectOf('#btn-start');
  note(`${tag} ① 首页「开始游戏」可见`, !!home && home.vis && home.h > 40,
    home ? `h=${Math.round(home.h)} cy=${Math.round(home.cy)}/${home.vh}` : '元素缺失');
  await shot(`${tag}-home`);

  const opened = await openSetup('local', 3);
  note(`${tag} ② 开局弹窗可选玩法与人数`, opened);
  await shot(`${tag}-setup`).catch(() => {});

  const inGame = await waitFor(`window.SD.snapshot().phase === 'BET'`, 4000);
  const s0 = await snap();
  note(`${tag} ③ 进入牌桌且庄池 = 20`, inGame && s0.bank === 20,
    `phase=${s0.phase} bank=${s0.bank} 庄=${s0.players[s0.dealer] && s0.players[s0.dealer].name}`);

  const seatCount = await evalJs(`document.querySelectorAll('#seats .seat').length`);
  note(`${tag} ④ 闲家座位数 = 人数−1`, seatCount === 2, `seats=${seatCount}`);

  const chips = await evalJs(`(() => Array.from(document.querySelectorAll('.bet-chip')).map((el) => {
    const r = el.getBoundingClientRect();
    return { v: el.dataset.bet, y: Math.round(r.y), h: Math.round(r.height),
             cy: Math.round(r.y + r.height / 2), w: Math.round(r.width),
             disp: getComputedStyle(el).display };
  }))()`);
  const vh = await evalJs('window.innerHeight');
  const chipsOk = chips.length === 3 && chips.every((c) => c.h >= 40 && c.cy > 0 && c.cy < vh && c.w > 40);
  note(`${tag} ⑤ 三档下注在首屏内且可点`, chipsOk,
    chips.map((c) => `${c.v}@${c.y}/${c.h}x${c.w}`).join(' ') + ` vh=${vh}`);
  await shot(`${tag}-bet`);

  /* 逐人下注：两个人各点一次 1 档 + 确认 */
  const firstBet = await driveHumans(20000, async () => {
    const before = await snap();
    const bettor = before.players[before.turn];
    await click('.bet-chip[data-bet="1"]', '下注 1');
    const picked = await snap();
    await click('#btnMain', '确认下注');
    const after = await waitFor(`window.SD.snapshot().turn !== ${before.turn} || window.SD.snapshot().phase !== 'BET'`, 3000);
    note(`${tag} ⑥ 逐人下注生效`, after && picked.turn === before.turn,
      `${bettor ? bettor.name : '?'} 下注 → 轮到下一位`);
    return true;
  });
  note(`${tag} ⑦ 下注阶段走完`, firstBet.ok && firstBet.betSeen, `betSeen=${firstBet.betSeen}`);

  const settled = await driveHumans(30000);
  const s1 = await snap();
  note(`${tag} ⑧ 一局能打到结算`, settled.ok && s1.phase === 'SETTLE',
    `phase=${s1.phase} 结果=${s1.lastRound ? s1.lastRound.results.length : 0} 条`);
  note(`${tag} ⑨ 结算页可见`, await evalJs(`!document.getElementById('screen-settle').classList.contains('hidden')`));

  const rows = await evalJs(`document.querySelectorAll('#rsList .rs-row').length`);
  note(`${tag} ⑩ 结算逐人列出（庄 + 2 闲 = 3 行）`, rows === 3, `rows=${rows}`);
  await shot(`${tag}-settle`);

  const total = s1.players.reduce((a, p) => a + p.chips, 0) + s1.bank;
  note(`${tag} ⑪ 筹码守恒（总筹码 + 庄池 = 150）`, total === 150,
    `${s1.players.map((p) => p.name + ':' + p.chips).join(' ')} + 庄池 ${s1.bank} = ${total}`);
  note(`${tag} ⑫ 庄池结算在 0–40 之间`, s1.lastRound.bankAfter >= 0 && s1.lastRound.bankAfter <= 40,
    `${s1.lastRound.bankBefore} → ${s1.lastRound.bankAfter}${s1.lastRound.dealerLeft ? '（下庄）' : ''}`);

  await click('#btn-next', '下一局');
  const back = await waitFor(`['BET','OVER'].includes(window.SD.snapshot().phase)`, 4000);
  const s2 = await snap();
  note(`${tag} ⑬ 下一局可继续（或本场结束）`, back,
    `phase=${s2.phase}${s2.pendingEnd ? ' 待结束=' + s2.pendingEnd : ''}`);
}

/* ==================== 场景 B：点数 ≤6 停不了（用户实测漏洞） ==================== */
async function sceneForceHit() {
  const tag = 'force-hit';
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844
  });
  await send('Page.navigate', { url: BASE });
  await sleep(900);
  await waitFor('!!window.SD', 8000);

  /* 2 人局：0 号位（你）第一局就是庄家，等电脑闲家行动完就轮到真人庄家决策 */
  await openSetup('ai', 2);
  await waitFor(`window.SD.snapshot().phase === 'BET'`, 4000);
  const s0 = await snap();
  note(`${tag} ① 2 人局你先坐庄`, s0.dealer === 0, `dealer=${s0.dealer} bank=${s0.bank}`);

  const bankerTurn = await waitFor(`window.SD.snapshot().phase === 'BANKER'`, 20000);
  note(`${tag} ② 轮到庄家决策（电脑闲家已自动行动）`, bankerTurn,
    `phase=${(await snap()).phase}`);

  /* 注入 2 + J = 2.5 点 */
  await evalJs(`window.SD.debug.setHand(0, [2, 11])`);
  await sleep(200);
  const low = await snap();
  const standBtn = await rectOf('#btnStand');
  note(`${tag} ③ 2.5 点时「停牌」被禁用`, low.players[0].pts === 2.5 && low.players[0].canStand === false && !!standBtn && standBtn.disabled,
    `pts=${low.players[0].pts} canStand=${low.players[0].canStand} 按钮disabled=${standBtn ? standBtn.disabled : 'none'}`);
  await shot(`${tag}-locked`);

  /* 真点击一次：状态不能变 */
  const before = await snap();
  if (standBtn && standBtn.vis) {
    await click('#btnStand', '2.5 点强行停牌').catch(() => {});
  }
  await sleep(500);
  const after = await snap();
  note(`${tag} ④ 真点击「停牌」也不生效`,
    after.phase === before.phase && after.players[0].cards.length === before.players[0].cards.length,
    `phase ${before.phase}→${after.phase} 手牌 ${before.players[0].cards.length}→${after.players[0].cards.length}`);

  /* 换成 6 点也同样禁止；6.5 才放开 */
  await evalJs(`window.SD.debug.setHand(0, [5, 14])`);
  await sleep(200);
  const six = await snap();
  note(`${tag} ⑤ 正好 6 点也必须继续要牌`, six.players[0].canStand === false, `pts=${six.players[0].pts}`);

  await evalJs(`window.SD.debug.setHand(0, [6, 11])`);
  await sleep(200);
  const sixHalf = await snap();
  const btn2 = await rectOf('#btnStand');
  note(`${tag} ⑥ 6.5 点可以停牌`, sixHalf.players[0].canStand === true && !!btn2 && btn2.disabled === false,
    `pts=${sixHalf.players[0].pts} disabled=${btn2 ? btn2.disabled : 'none'}`);

  await click('#btnStand', '6.5 点停牌');
  const settled = await waitFor(`window.SD.snapshot().phase === 'SETTLE'`, 8000);
  note(`${tag} ⑦ 停牌后正常结算`, settled, `phase=${(await snap()).phase}`);
}

/* ==================== 场景 C：人机 3 人（电脑自己会玩） ==================== */
async function sceneAI() {
  const tag = 'ai-3';
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844
  });
  await send('Page.navigate', { url: BASE });
  await sleep(900);
  await waitFor('!!window.SD', 8000);

  await openSetup('ai', 3);
  const inGame = await waitFor(`window.SD.snapshot().phase === 'BET'`, 4000);
  const s0 = await snap();
  note(`${tag} ① 人机 3 人开局`, inGame && s0.players.length === 3 && s0.players.filter((p) => p.isAI).length === 2,
    `players=${s0.players.length} AI=${s0.players.filter((p) => p.isAI).length}`);

  const done = await driveHumans(35000);
  const s1 = await snap();
  note(`${tag} ② 电脑能自己下注并走完一局`, done.ok && s1.phase === 'SETTLE', `phase=${s1.phase}`);
  const bets = s1.lastRound ? s1.lastRound.results.filter((r) => r.bet > 0).length : 0;
  note(`${tag} ③ 每个闲家都下了注`, bets === 2, `注数=${bets}`);
  await shot(`${tag}-settle`);
}

async function main() {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  /* 每次用全新 profile：否则上一轮的 Service Worker 缓存会把旧 CSS/JS 喂回来，
     探针就变成在测旧版本（本地开发时极容易误判成「改了没生效」）。 */
  const profile = process.cwd() + '/.probe-profile';
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  if (!existsSync(EDGE)) throw new Error('找不到 Edge: ' + EDGE);

  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    let ok = false;
    for (let i = 0; i < 40; i++) {
      try { await fetch(`http://127.0.0.1:${PORT}/json/version`); ok = true; break; } catch { await sleep(200); }
    }
    if (!ok) throw new Error('调试端口未就绪');

    await connect();

    for (const vp of [[390, 844], [360, 640], [412, 915]]) {
      await sceneLocal(vp[0], vp[1]);
    }

    await sceneForceHit();
    await sceneAI();

    /* 离线：断网重载，SW 必须能撑起一局 */
    await send('Network.enable');
    await send('Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0
    });
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Page.navigate', { url: BASE });
    await sleep(1300);
    const offlineBoot = await waitFor('!!window.SD', 8000);
    const startRect = await rectOf('#btn-start').catch(() => null);
    note('⑭ 离线冷启动可进首页', offlineBoot && !!startRect && startRect.h > 30,
      startRect ? `btn h=${Math.round(startRect.h)}` : '首页未渲染');
    if (offlineBoot) {
      await openSetup('ai', 2);
      const betPhase = await waitFor(`window.SD.snapshot().phase === 'BET'`, 5000);
      const dealt = await driveHumans(25000);
      note('⑭b 离线能打到结算', betPhase && dealt.ok, `phase=${(await snap()).phase}`);
      await shot('offline-settle');
    }
    await send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
    });

    note('页面无 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

    const failed = results.filter((r) => !r.ok);
    console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
    writeFileSync(`${OUT}/probe-report.json`, JSON.stringify({ results, pageErrors }, null, 2));
    process.exitCode = failed.length ? 1 : 0;
  } catch (e) {
    console.error('PROBE ERROR:', e.message);
    note('探针执行完成', false, e.message);
    writeFileSync(`${OUT}/probe-report.json`, JSON.stringify({ results, pageErrors }, null, 2));
    process.exitCode = 1;
  } finally {
    try { child.kill(); } catch {}
  }
}

main();
