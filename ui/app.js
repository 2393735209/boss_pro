/**
 * 界面逻辑
 *
 * 职责：创建内嵌浏览器 → 触发扫描 → 把结果画到左侧面板
 * 注意：这里【没有任何点击 BOSS 页面的代码】，干跑阶段就是要保证这一点。
 */

const BOSS_LIST_URL = 'https://www.zhipin.com/web/geek/job';

const el = {
  host: document.getElementById('host'),
  conn: document.getElementById('conn'),
  connText: document.getElementById('connText'),
  notice: document.getElementById('notice'),
  noticeIcon: document.getElementById('noticeIcon'),
  noticeText: document.getElementById('noticeText'),
  scanBtn: document.getElementById('scanBtn'),
  autoScan: document.getElementById('autoScan'),
  minSalary: document.getElementById('minSalary'),
  excludeWords: document.getElementById('excludeWords'),
  excludeCompanies: document.getElementById('excludeCompanies'),
  filterMeta: document.getElementById('filterMeta'),
  stats: document.getElementById('stats'),
  cacheRow: document.getElementById('cacheRow'),
  cacheText: document.getElementById('cacheText'),
  statTotal: document.getElementById('statTotal'),
  statOk: document.getElementById('statOk'),
  statSkip: document.getElementById('statSkip'),
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
  diagList: document.getElementById('diagList'),
  diagBadge: document.getElementById('diagBadge'),
  exportBtn: document.getElementById('exportBtn'),
  urlBar: document.getElementById('urlBar'),
  backBtn: document.getElementById('backBtn'),
  reloadBtn: document.getElementById('reloadBtn'),
  gotoListBtn: document.getElementById('gotoListBtn'),

  // 投递控制
  batchCount: document.getElementById('batchCount'),
  batchRange: document.getElementById('batchRange'),
  minusCount: document.getElementById('minusCount'),
  plusCount: document.getElementById('plusCount'),
  startBtn: document.getElementById('startBtn'),
  startBtnText: document.getElementById('startBtnText'),
  dbHint: document.getElementById('dbHint'),
  dbToday: document.getElementById('dbToday'),

  // 进度球
  floatBall: document.getElementById('floatBall'),
  ballRing: document.getElementById('ballRing'),
  ballText: document.getElementById('ballText'),

  // 日志
  logPanel: document.getElementById('logPanel'),
  logBody: document.getElementById('logBody'),
  logBadge: document.getElementById('logBadge'),
  logToggle: document.getElementById('logToggle'),
  logClear: document.getElementById('logClear'),
};

let wv = null;
let ready = false;
let lastScanAt = 0;
let scanTimer = null;

const state = {
  cards: [],
  todayDate: '',
  todayCount: 0,
  busy: false,
  jobCache: [],              // 从接口捞到的真实职位数据（含明文薪资）
  jobCacheMap: new Map(),
  deliveredIds: [],          // 已投递过的职位 ID（防重复）
  batchCount: 10,            // 本次投递数量设置
  batch: {
    running: false,
    stop: false,
    total: 0,
    done: 0,
  },
};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// 运行日志
// ---------------------------------------------------------------------------
let logCount = 0;

function log(msg, kind) {
  const d = new Date();
  const time = [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');

  const line = document.createElement('div');
  line.className = 'log-line' + (kind ? ' ' + kind : '');
  line.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${esc(msg)}</span>`;
  el.logBody.appendChild(line);

  while (el.logBody.children.length > 400) {
    el.logBody.removeChild(el.logBody.firstChild);
  }
  el.logBody.scrollTop = el.logBody.scrollHeight;

  logCount += 1;
  el.logBadge.hidden = false;
  el.logBadge.textContent = logCount;
}

// ---------------------------------------------------------------------------
// 投递进度球
// ---------------------------------------------------------------------------
function updateBall() {
  const { total, done } = state.batch;
  el.ballText.textContent = `${done}/${total}`;

  const C = 2 * Math.PI * 18;
  const ratio = total > 0 ? Math.min(done / total, 1) : 0;
  el.ballRing.style.strokeDasharray = String(C);
  el.ballRing.style.strokeDashoffset = String(C * (1 - ratio));
}

function showBall(show) {
  el.floatBall.hidden = !show;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setConn(state, text) {
  el.conn.className = 'conn' + (state ? ' is-' + state : '');
  el.connText.textContent = text;
}

function showNotice(kind, text) {
  if (!text) { el.notice.hidden = true; return; }
  el.notice.hidden = false;
  el.notice.className = 'notice' + (kind ? ' is-' + kind : '');
  el.noticeIcon.textContent = kind === 'info' ? 'i' : kind === 'ok' ? '✓' : '!';
  el.noticeText.textContent = text;
}

function parseList(s) {
  return String(s || '')
    .split(/[,，、\n;；]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
function readForm() {
  return {
    minSalary: Number(el.minSalary.value) || 0,
    excludeWords: parseList(el.excludeWords.value),
    excludeCompanies: parseList(el.excludeCompanies.value),
  };
}

let saveTimer = null;
function updateFilterMeta() {
  const cfg = readForm();
  const bits = [];
  if (cfg.minSalary > 0) bits.push('≥' + cfg.minSalary + 'K');
  if (cfg.excludeWords.length) bits.push('排除 ' + cfg.excludeWords.length + ' 词');
  if (cfg.excludeCompanies.length) bits.push('排除 ' + cfg.excludeCompanies.length + ' 司');
  el.filterMeta.textContent = bits.length ? bits.join(' · ') : '未设置';
}

async function persistConfig() {
  try {
    await window.bridge.saveConfig({
      ...readForm(),
      autoScan: el.autoScan.checked,
      todayDate: state.todayDate,
      todayCount: state.todayCount,
      deliveredIds: state.deliveredIds,
      batchCount: state.batchCount,
    });
  } catch (e) {
    console.warn('保存配置失败', e);
  }
}

function scheduleSave() {
  updateFilterMeta();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistConfig, 400);
}

async function loadConfig() {
  try {
    const cfg = await window.bridge.loadConfig();
    el.minSalary.value = cfg.minSalary > 0 ? cfg.minSalary : '';
    el.excludeWords.value = (cfg.excludeWords || []).join(', ');
    el.excludeCompanies.value = (cfg.excludeCompanies || []).join(', ');
    el.autoScan.checked = cfg.autoScan !== false;
    state.todayDate = cfg.todayDate || '';
    state.todayCount = cfg.todayCount || 0;
    state.deliveredIds = Array.isArray(cfg.deliveredIds) ? cfg.deliveredIds : [];
    state.batchCount = cfg.batchCount > 0 ? Math.min(cfg.batchCount, 200) : 100;
    el.batchCount.value = String(state.batchCount);
    el.batchRange.value = String(state.batchCount);

    // 跨天自动清零
    const today = todayStr();
    if (state.todayDate !== today) {
      state.todayDate = today;
      state.todayCount = 0;
    }

    updateFilterMeta();
  } catch (e) {
    console.warn('读取配置失败', e);
  }
}

// ---------------------------------------------------------------------------
// 接口数据合并（BOSS 把页面薪资用私有字体混淆了，只能从接口拿明文）
// ---------------------------------------------------------------------------
function mergeJobs(jobs) {
  let added = 0;
  for (const j of jobs) {
    if (!j || !j.salaryDesc) continue;
    const key = (j.jobName || '') + '|' + (j.brandName || '');
    if (key === '|') continue;
    if (!state.jobCacheMap.has(key)) added += 1;
    state.jobCacheMap.set(key, j);
  }
  if (added) {
    state.jobCache = Array.from(state.jobCacheMap.values());
    updateCacheInfo(true);
  }
}

function updateCacheInfo(hookInstalled) {
  const n = state.jobCache.length;

  if (n > 0) {
    el.cacheRow.hidden = false;
    el.cacheRow.className = 'cache-row';
    el.cacheText.textContent = `已从接口捕获 ${n} 条明文薪资`;
    return;
  }

  if (hookInstalled === false) {
    el.cacheRow.hidden = false;
    el.cacheRow.className = 'cache-row is-bad';
    el.cacheText.textContent = '接口钩子没装上，薪资会显示成 0 —— 告诉我，我来修';
    return;
  }

  if (hookInstalled === true) {
    el.cacheRow.hidden = false;
    el.cacheRow.className = 'cache-row is-wait';
    el.cacheText.textContent = '钩子已就位但还没抓到数据（试试刷新页面 / 翻页）';
    return;
  }

  el.cacheRow.hidden = true;
}

// ---------------------------------------------------------------------------
// 创建内嵌浏览器
// ---------------------------------------------------------------------------
async function createWebview() {
  // webview 的 preload 必须在创建时设置，用来钩住 BOSS 的接口响应
  let preloadUrl = '';
  try {
    const p = await window.bridge.appPaths();
    if (p && p.webviewPreload) {
      preloadUrl = 'file:///' + encodeURI(p.webviewPreload.replace(/\\/g, '/'));
    }
  } catch (e) {
    console.warn('拿不到 webview preload 路径', e);
  }

  wv = document.createElement('webview');
  if (preloadUrl) wv.setAttribute('preload', preloadUrl);
  // persist: 前缀 = 登录态存本地，关掉程序再开还在，不用每次扫码
  wv.setAttribute('partition', 'persist:boss');
  wv.setAttribute('src', BOSS_LIST_URL);
  // 用主进程设好的标准 Chrome UA，抹掉 Electron 标识
  wv.setAttribute('useragent', navigator.userAgent);
  wv.setAttribute('allowpopups', 'false');

  // 接口钩子把职位数据发过来
  wv.addEventListener('ipc-message', (e) => {
    if (e.channel !== 'boss-jobs') return;
    const payload = e.args && e.args[0];
    if (payload && Array.isArray(payload.jobs)) mergeJobs(payload.jobs);
  });

  wv.addEventListener('dom-ready', () => {
    ready = true;
    setConn('ready', '页面就绪');
    updateUrl();
  });

  wv.addEventListener('did-start-loading', () => {
    setConn('busy', '加载中');
  });

  wv.addEventListener('did-stop-loading', () => {
    setConn(ready ? 'ready' : '', ready ? '页面就绪' : '等待页面');
    updateUrl();
  });

  wv.addEventListener('did-finish-load', () => {
    updateUrl();
    if (el.autoScan.checked) scheduleScan(1200);
  });

  wv.addEventListener('did-navigate-in-page', () => {
    updateUrl();
    if (el.autoScan.checked) scheduleScan(2200);
  });

  wv.addEventListener('did-navigate', updateUrl);

  wv.addEventListener('did-fail-load', (e) => {
    if (e.isMainFrame === false) return;
    setConn('', '加载失败');
    showNotice('danger', `页面加载失败（${e.errorDescription || e.errorCode}）。检查网络，或点「职位列表」重试。`);
  });

  wv.addEventListener('render-process-gone', () => {
    ready = false;
    setConn('', '页面崩溃');
    showNotice('danger', '页面进程崩了。点「职位列表」重新加载。');
  });

  el.host.appendChild(wv);
}

function updateUrl() {
  try {
    const u = wv.getURL();
    el.urlBar.textContent = u || 'about:blank';
    el.urlBar.title = u || '';
    el.backBtn.disabled = !wv.canGoBack();
  } catch {
    /* webview 还没初始化完，忽略 */
  }
}

function scheduleScan(delay) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, delay);
}

// ---------------------------------------------------------------------------
// 扫描（核心）
// ---------------------------------------------------------------------------
async function scan() {
  if (!wv || !ready) {
    showNotice('info', '页面还没加载完，稍等一下再扫。');
    return;
  }

  // 防止 SPA 路由抖动导致连环扫描
  const now = Date.now();
  if (now - lastScanAt < 1500) return;
  lastScanAt = now;

  el.scanBtn.disabled = true;
  setConn('busy', '扫描中');

  const cfg = readForm();
  // 把接口捞到的明文薪资一起传进页面，用来覆盖被混淆的薪资文本
  const slimCache = state.jobCache.map((j) => ({
    n: j.jobName,
    b: j.brandName,
    s: j.salaryDesc,
  }));
  // 把页面里的扫描函数序列化成源码，带上参数，注入执行
  const script = `(${window.BOSS_SCAN.toString()})(${JSON.stringify({
    ...cfg,
    jobCache: slimCache,
    deliveredIds: state.deliveredIds,
  })})`;

  try {
    const res = await wv.executeJavaScript(script);
    render(res);
    setConn('ready', '扫描完成');
  } catch (err) {
    console.error(err);
    setConn('ready', '扫描出错');
    showNotice('danger', '扫描失败：' + (err && err.message ? err.message : '页面可能还没就绪'));
  } finally {
    el.scanBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 投递：单个执行 → 单步 → 批量
// ---------------------------------------------------------------------------

// 投一个，不管界面。返回 BOSS_DELIVER 的原始结果。
async function deliverOne(card) {
  const today = todayStr();
  if (state.todayDate !== today) {
    state.todayDate = today;
    state.todayCount = 0;
  }

  const script = `(${window.BOSS_DELIVER.toString()})(${JSON.stringify({
    idx: card.domIdx,
    title: card.title,
    jobId: card.jobId || '',
  })})`;
  const res = await wv.executeJavaScript(script, true);

  if (res && res.ok) {
    state.todayCount += 1;
    card._delivered = true;
    if (card.jobId) {
      state.deliveredIds.push(card.jobId);
      if (state.deliveredIds.length > 3000) {
        state.deliveredIds = state.deliveredIds.slice(-3000);
      }
    }
    await persistConfig();
  }

  return res || { ok: false, reason: '页面没有返回结果' };
}

// 把列表里某张卡标记成已投
function markCardDone(card) {
  const btn = el.list.querySelector(`.deliver-btn[data-idx="${card.domIdx}"]`);
  if (btn) {
    btn.textContent = '已投递';
    btn.classList.add('done');
    btn.disabled = true;
    const box = btn.closest('.card');
    if (box) box.classList.add('is-done');
  }

  // 统计里的「可投」跟着减，别和下面的待投数打架
  const okLeft = state.cards.filter((c) => c.status === 'ok' && !c._delivered).length;
  el.statOk.textContent = okLeft;
  updateDbHint();
}

// 单步投递（点列表里的「投这个」）
async function deliver(card, btn) {
  if (state.busy || state.batch.running) return;
  if (!wv || !ready) {
    showNotice('info', '页面还没就绪，稍等一下。');
    return;
  }

  const today = todayStr();
  if (state.todayDate !== today) {
    state.todayDate = today;
    state.todayCount = 0;
  }

  state.busy = true;
  showNotice('info', `正在投递「${card.title}」，这会儿别动页面...`);
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '投递中...';
  log(`投递：${card.title} · ${card.company}`, 'info');

  try {
    const res = await deliverOne(card);
    if (res.ok) {
      markCardDone(card);
      showNotice('ok', `今天第 ${state.todayCount} 个 · ${res.note}`);
      log(`  ✓ ${res.note}`, 'ok');
    } else {
      btn.disabled = false;
      btn.textContent = originalText;
      showNotice('danger', '投递中止：' + (res.reason || '未知原因'));
      log(`  ✗ ${res.reason || '未知原因'}`, 'err');
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = originalText;
    showNotice('danger', '执行出错：' + ((err && err.message) || '页面可能还没加载好'));
    log(`  ✗ 执行出错：${(err && err.message) || ''}`, 'err');
  } finally {
    state.busy = false;
  }
}

// ---------------------------------------------------------------------------
// 批量投递
// ---------------------------------------------------------------------------
// 触发翻页 / 加载更多
async function loadMore() {
  if (!wv || !ready) return { ok: false };
  try {
    const res = await wv.executeJavaScript(`(${window.BOSS_LOAD_MORE.toString()})()`, true);
    if (res && res.ok) {
      log(`翻页动作：${res.how}${res.sel ? ' (' + res.sel + ')' : ''}`, 'dim');
    }
    return res || { ok: false };
  } catch (e) {
    log('翻页出错：' + ((e && e.message) || ''), 'err');
    return { ok: false };
  }
}

// 强制重扫一次（绕过节流）
async function rescan() {
  lastScanAt = 0;
  await scan();
}

async function startBatch() {
  // 正在跑 → 按钮变成「停止」
  if (state.batch.running) {
    stopBatch();
    return;
  }

  if (!wv || !ready) {
    showNotice('info', '页面还没就绪，稍等一下。');
    return;
  }

  const want = Number(el.batchCount.value) || 10;

  const today = todayStr();
  if (state.todayDate !== today) {
    state.todayDate = today;
    state.todayCount = 0;
  }

  // 不设单日上限：投多少个完全由你设的数字决定
  const plan = Math.min(want, 200);

  const firstPool = state.cards.filter((c) => c.status === 'ok' && !c._delivered && !c._failed);
  if (!firstPool.length) {
    showNotice('danger', '当前没有可投的岗位。先扫描一次，或者放宽筛选条件。');
    log('没有可投岗位，批量没有启动', 'warn');
    return;
  }

  state.batch.running = true;
  state.batch.stop = false;
  state.batch.total = plan;
  state.batch.done = 0;

  el.startBtn.classList.add('is-running');
  el.startBtnText.textContent = '停止投递';
  showBall(true);
  updateBall();
  showNotice('info', `批量投递中：0/${plan}`);

  // 开跑就把日志摊开，让你能看见每一步
  el.logPanel.classList.add('open');
  el.logToggle.textContent = '收起';

  log(
    `开始批量投递：计划 ${plan} 个（当前页可投 ${firstPool.length}，今日已投 ${state.todayCount}）`,
    'info'
  );

  let delivered = 0;
  let pageTurns = 0;
  const MAX_PAGES = 25;

  while (delivered < plan && !state.batch.stop) {
    // 页面被带到别处（聊天页/登录页）就别再往下点了，越点越错
    let currentUrl = '';
    try { currentUrl = wv.getURL(); } catch (e) { /* 忽略 */ }
    if (currentUrl && !/\/web\/geek\/jobs?/.test(currentUrl)) {
      log('页面已不在职位列表（' + currentUrl.slice(0, 70) + '），批量中止', 'err');
      showNotice('danger', '页面跳到别处了。点右上角「职位列表」回去，再重新开始。');
      break;
    }

    const pool = state.cards.filter((c) => c.status === 'ok' && !c._delivered && !c._failed);

    // 本页没货了 → 翻下一页接着找
    if (!pool.length) {
      if (pageTurns >= MAX_PAGES) {
        log(`已经翻了 ${MAX_PAGES} 页，先停一下`, 'warn');
        break;
      }

      log(`本页可投的投完了（${delivered}/${plan}），翻下一页`, 'info');
      showNotice('info', `翻页找岗位… 已投 ${delivered}/${plan}`);

      const nav = await loadMore();
      if (!nav || !nav.ok) {
        log('没找到下一页按钮，结束了', 'warn');
        break;
      }

      const beforeCount = state.cards.length;
      const beforeFirst = state.cards.length ? state.cards[0].title : '';

      await sleep(2600 + Math.round(Math.random() * 1600));
      await rescan();

      const newFirst = state.cards.length ? state.cards[0].title : '';
      const newCount = state.cards.length;

      // 两种机制都认：整页替换（首条变了）或懒加载追加（数量变多了）
      const moved = newFirst !== beforeFirst || newCount > beforeCount;
      if (!moved) {
        log('页面没有新增岗位，可能到头了', 'warn');
        break;
      }

      pageTurns += 1;
      log(`第 ${pageTurns} 次加载，本页共 ${newCount} 个岗位`, 'dim');
      continue;
    }

    const card = pool[0];
    log(`[${delivered + 1}/${plan}] ${card.title} · ${card.company}`, 'info');
    showNotice('info', `批量投递中：${delivered + 1}/${plan} · ${card.title}`);

    let res;
    try {
      res = await deliverOne(card);
    } catch (err) {
      res = { ok: false, fatal: true, reason: (err && err.message) || '执行异常' };
    }

    if (res.ok) {
      delivered += 1;
      state.batch.done = delivered;
      markCardDone(card);
      updateBall();
      log(`  ✓ ${res.note}`, 'ok');
    } else {
      // 这张投不了就跳过，否则会永远卡在它身上
      card._failed = true;
      log(`  ✗ ${res.reason || '未知原因'}`, 'err');

      if (res.fatal || /风控|验证|登录|次数|额度|上限|异常行为|限制/.test(res.reason || '')) {
        log('遇到需要人工处理的状况，批量已停止', 'err');
        showNotice('danger', '批量已停止：' + (res.reason || '') + '。处理完再继续。');
        break;
      }
    }

    if (delivered < plan && !state.batch.stop) {
      const wait = 6000 + Math.round(Math.random() * 6000);
      log(`  等 ${(wait / 1000).toFixed(0)} 秒`, 'dim');
      await sleep(wait);
    }
  }

  state.batch.running = false;
  el.startBtn.classList.remove('is-running');
  el.startBtnText.textContent = '开始投递';

  log(`批量结束：成功 ${delivered}/${plan}，翻了 ${pageTurns} 页`, delivered > 0 ? 'ok' : 'warn');
  showNotice(
    delivered > 0 ? 'ok' : 'danger',
    delivered >= plan
      ? `批量完成，${delivered}/${plan} 全部投出。今天累计 ${state.todayCount} 个。`
      : `批量结束，投出 ${delivered}/${plan}。今天累计 ${state.todayCount} 个。`
  );

  setTimeout(() => {
    if (!state.batch.running) showBall(false);
  }, 4000);
}

function stopBatch() {
  if (!state.batch.running) return;
  state.batch.stop = true;
  el.startBtnText.textContent = '正在停止...';
  log('收到停止指令，当前这个投完就停', 'warn');
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
function render(res) {
  if (!res || !res.ok) {
    showNotice('danger', '扫描没有返回有效结果。');
    return;
  }

  // 留一份给调试用（主进程 --probe 模式会读它）
  window.__lastScan = res;

  const p = res.page || {};

  if (p.hasRisk) {
    showNotice('danger', '⚠ 页面出现风控提示（访问受限 / 异常行为）。立刻停手，换个时间再来，别硬顶。');
  } else if (p.hasCaptcha) {
    showNotice('danger', '页面在要求人机验证。你需要手动通过验证后，才能继续。');
  } else if (p.isLogin) {
    showNotice('info', '当前是登录页。在右侧页面扫码登录，登录后点「重新扫描」。');
  } else if (res.detail && res.detail.found) {
    showNotice('ok', '详情区发现「' + res.detail.text + '」按钮，已在页面上圈出绿框。');
  } else if (!p.listFound) {
    showNotice('', '没找到职位列表。请确认你在「职位搜索」的结果页，不是首页或详情页。');
  } else {
    showNotice('', '');
  }

  // 统计
  const s = res.summary || { total: 0, ok: 0, skip: 0 };
  el.stats.hidden = false;
  el.statTotal.textContent = s.total;
  el.statOk.textContent = s.ok;
  el.statSkip.textContent = s.skip;

  // 接口钩子状态
  updateCacheInfo(res.hookInstalled);

  // 列表
  const cards = res.cards || [];
  state.cards = cards;
  if (!cards.length) {
    el.empty.hidden = false;
    el.list.innerHTML = '';
    el.empty.querySelector('.empty-title').textContent = '这一页没扫到职位卡片';
    el.empty.querySelector('.empty-desc').textContent =
      '要么这不是职位列表页，要么 BOSS 改版了。展开下面的「选择器诊断」看看哪条规则命中 0。';
  } else {
    el.empty.hidden = true;
    el.list.innerHTML = cards.map(renderCard).join('');
  }

  // 诊断
  renderDiag(res.diag || []);

  updateDbHint();
}

function renderCard(c, i) {
  const isOk = c.status === 'ok';
  const num = i + 1;
  const tags = (c.tags || [])
    .map((t) => `<span class="tag">${esc(t)}</span>`)
    .join('');

  const metaBits = [];
  if (c.company) metaBits.push(`<span class="co">${esc(c.company)}</span>`);
  if (c.area) metaBits.push(`<span>${esc(c.area)}</span>`);

  return `
    <div class="card ${isOk ? 'is-ok' : ''} ${c._delivered ? 'is-done' : ''}">
      <div class="card-top">
        <span class="idx">${esc(num)}</span>
        <span class="card-title">${esc(c.title)}</span>
        ${c.salaryRaw ? `<span class="card-salary">${esc(c.salaryRaw)}</span>` : ''}
      </div>
      ${metaBits.length ? `<div class="card-meta">${metaBits.join('<span class="dot-sep">·</span>')}</div>` : ''}
      ${tags ? `<div class="tags">${tags}</div>` : ''}
      ${c.reason ? `<div class="reason">${esc(c.reason)}</div>` : ''}
      ${isOk ? `<div class="card-actions">
        <button class="deliver-btn" data-idx="${c.domIdx != null ? c.domIdx : c.index}">${c._delivered ? '已投递' : '投这个'}</button>
      </div>` : ''}
    </div>
  `;
}

function renderDiag(diag) {
  if (!diag.length) {
    el.diagList.innerHTML = '';
    return;
  }
  const zeros = diag.filter((d) => d.n === 0);
  el.diagBadge.hidden = zeros.length === 0;
  el.diagBadge.textContent = zeros.length + ' 条失效';

  el.diagList.innerHTML = diag
    .map(
      (d) => `
      <div class="diag-row">
        <span class="diag-key">${esc(d.key)}</span>
        <span class="diag-sel" title="${esc(d.sel)}">${esc(d.sel || '—')}</span>
        <span class="diag-n ${d.n === 0 ? 'zero' : ''}">${d.n}</span>
      </div>`
    )
    .join('');
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------
el.scanBtn.addEventListener('click', scan);

el.backBtn.addEventListener('click', () => {
  try { if (wv.canGoBack()) wv.goBack(); } catch { /* ignore */ }
});

el.reloadBtn.addEventListener('click', () => {
  try { wv.reload(); } catch { /* ignore */ }
});

el.gotoListBtn.addEventListener('click', () => {
  try { wv.loadURL(BOSS_LIST_URL); } catch { /* ignore */ }
});

[el.minSalary, el.excludeWords, el.excludeCompanies].forEach((input) => {
  input.addEventListener('input', scheduleSave);
});

el.autoScan.addEventListener('change', scheduleSave);

// ---------------------------------------------------------------------------
// 投递数量设置
// ---------------------------------------------------------------------------
function setBatchCount(n) {
  let v = Math.round(Number(n) || 1);
  if (v < 1) v = 1;
  if (v > 200) v = 200;
  state.batchCount = v;
  el.batchCount.value = String(v);
  el.batchRange.value = String(v);
  scheduleSave();
}

function updateDbHint() {
  const pending = state.cards.filter((c) => c.status === 'ok' && !c._delivered && !c._failed).length;
  const done = state.cards.filter((c) => c._delivered).length;

  el.dbToday.textContent = `今日已投 ${state.todayCount}`;

  if (!state.cards.length) {
    el.dbHint.textContent = '先扫描一次，这里会显示待投数量';
    return;
  }
  const donePart = done > 0 ? ` · 本页已投 ${done}` : '';
  el.dbHint.textContent = `待投 ${pending} 个${donePart}`;
}

el.batchRange.addEventListener('input', () => setBatchCount(el.batchRange.value));
el.batchCount.addEventListener('change', () => setBatchCount(el.batchCount.value));
el.minusCount.addEventListener('click', () => setBatchCount((Number(el.batchCount.value) || 1) - 1));
el.plusCount.addEventListener('click', () => setBatchCount((Number(el.batchCount.value) || 1) + 1));

el.startBtn.addEventListener('click', startBatch);
el.floatBall.addEventListener('click', stopBatch);

// ---------------------------------------------------------------------------
// 日志面板
// ---------------------------------------------------------------------------
el.logToggle.addEventListener('click', () => {
  const open = el.logPanel.classList.toggle('open');
  el.logToggle.textContent = open ? '收起' : '展开';
  if (open) el.logBody.scrollTop = el.logBody.scrollHeight;
});

el.logClear.addEventListener('click', () => {
  el.logBody.innerHTML = '';
  logCount = 0;
  el.logBadge.hidden = true;
});

// 投递按钮：第一次点变「确认投递？」，3 秒内再点一下才真投
el.list.addEventListener('click', (e) => {
  const btn = e.target.closest('.deliver-btn');
  if (!btn || btn.disabled) return;

  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.classList.add('confirm');
    btn.textContent = '确认投递？';
    btn._timer = setTimeout(() => {
      btn.dataset.confirm = '0';
      btn.classList.remove('confirm');
      btn.textContent = '投这个';
    }, 3000);
    return;
  }

  clearTimeout(btn._timer);
  btn.dataset.confirm = '0';
  btn.classList.remove('confirm');

  const idx = Number(btn.dataset.idx);
  const card = state.cards.find((c) => c.domIdx === idx);
  if (!card) {
    showNotice('danger', '找不到这张卡片的数据，重新扫描一次。');
    return;
  }
  deliver(card, btn);
});

// 导出页面结构：把 BOSS 真实 DOM 存成 JSON 到桌面，用来校准选择器
el.exportBtn.addEventListener('click', async () => {
  if (!wv || !ready) {
    showNotice('info', '页面还没加载完，稍等一下。');
    return;
  }
  el.exportBtn.disabled = true;
  el.exportBtn.textContent = '正在导出...';
  try {
    const dom = await wv.executeJavaScript(`(${window.BOSS_DUMP.toString()})()`);
    const res = await window.bridge.saveReport({
      scan: window.__lastScan || null,
      dom,
    });
    if (res && res.ok) {
      showNotice('ok', '已导出到桌面：' + res.path.split(/[\\/]/).pop());
    } else {
      showNotice('danger', '导出失败：' + (res && res.error));
    }
  } catch (err) {
    showNotice('danger', '导出失败：' + (err && err.message));
  } finally {
    el.exportBtn.disabled = false;
    el.exportBtn.textContent = '导出页面结构（发给我排查用）';
  }
});

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    scan();
  }
});

// ---------------------------------------------------------------------------
// 样式自检用的假数据（--mock 时渲染，不连网）
// ---------------------------------------------------------------------------
const MOCK_DATA = {
  ok: true,
  page: { url: 'https://www.zhipin.com/web/geek/jobs', title: '职位搜索', isLogin: false, hasRisk: false, hasCaptcha: false, listFound: true, cardCount: 5 },
  detail: { found: true, text: '立即沟通' },
  diag: [
    { key: 'JOB_CARD', sel: '.job-card-wrapper', n: 5 },
    { key: 'JOB_NAME', sel: '.job-name', n: 5 },
    { key: 'JOB_SALARY', sel: '.salary', n: 5 },
    { key: 'COMPANY', sel: '.company-name', n: 5 },
    { key: 'AREA', sel: '.job-area', n: 5 },
    { key: 'TAGS', sel: '.tag-list li', n: 21 },
    { key: 'CHAT_BUTTON', sel: '.op-btn-chat', n: 2 },
    { key: 'JOB_LIST', sel: '.job-list-box', n: 1 },
  ],
  cards: [
    { index: 0, jobId: 'a1', title: '前端开发工程师', company: '字节跳动', salaryRaw: '25-40K·15薪', salaryMin: 25, salaryMax: 40, area: '杭州·西湖区', tags: ['3-5年', '本科', 'React', 'TypeScript'], hasChat: true, chatText: '立即沟通', status: 'ok', reason: '' },
    { index: 1, jobId: 'a2', title: '高级前端工程师（可视化方向）', company: '网易', salaryRaw: '30-50K', salaryMin: 30, salaryMax: 50, area: '杭州·滨江区', tags: ['5-10年', '本科'], hasChat: true, chatText: '立即沟通', status: 'ok', reason: '', _delivered: true },
    { index: 2, jobId: 'a3', title: '前端开发（外包岗）', company: '某某信息技术', salaryRaw: '12-18K', salaryMin: 12, salaryMax: 18, area: '杭州·余杭区', tags: ['1-3年', '大专'], hasChat: true, chatText: '立即沟通', status: 'skip', reason: '命中排除词「外包」' },
    { index: 3, jobId: 'a4', title: 'Web 前端', company: '某小型电商', salaryRaw: '8-12K', salaryMin: 8, salaryMax: 12, area: '杭州·萧山区', tags: ['1-3年'], hasChat: true, chatText: '立即沟通', status: 'skip', reason: '薪资低于 15K（8-12K）' },
    { index: 4, jobId: 'a5', title: '前端实习生', company: '某公司', salaryRaw: '面议', salaryMin: null, salaryMax: null, area: '杭州', tags: ['应届'], hasChat: false, chatText: '', status: 'skip', reason: '没有沟通按钮（可能已投递 / 已关闭 / 需要登录）' },
  ],
  summary: { total: 5, ok: 2, skip: 3 },
};

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
(async function boot() {
  await loadConfig();

  if (new URLSearchParams(location.search).has('mock')) {
    setConn('ready', '演示数据');
    el.urlBar.textContent = 'https://www.zhipin.com/web/geek/jobs';
    render(MOCK_DATA);

    // 演示日志与进度球（仅 --mock 模式）
    log('已打开 BOSS 直聘上次搜索 [agent]', 'info');
    log('扫描完成：15 个岗位，2 个可投', 'info');
    log('投递：高级前端工程师（可视化方向）· 网易', 'info');
    log('  ✓ 招呼已发出，弹窗已关闭', 'ok');
    log('投递：前端开发（外包岗）· 某某信息技术', 'info');
    log('  ✗ 命中排除词「外包」', 'err');
    state.batch = { running: true, stop: false, total: 5, done: 2 };
    showBall(true);
    updateBall();
    el.logPanel.classList.add('open');
    el.logToggle.textContent = '收起';
    return;
  }

  await createWebview();
  setConn('busy', '加载中');
})();