/**
 * BOSS 干跑检查器 —— 主进程
 *
 * 干跑（dry run）= 只识别页面上的「立即沟通」按钮并高亮，一次都不点击。
 * 目的是先验证选择器能不能认对按钮、你的过滤规则准不准，零封号风险。
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// 文件日志
// Electron 在 Windows 上是 GUI 子系统程序，console.log 不会进 stdout 重定向，
// 打包后出问题看不到任何信息。启动过程单独写一份文件，排查用。
// ---------------------------------------------------------------------------
const LOG_PATH = path.join(app.getPath('appData'), 'BossAuto-log.txt');

function fileLog(msg) {
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`, 'utf8');
  } catch (_) { /* 忽略 */ }
}

fileLog('========== 进程启动 ==========');
fileLog('argv: ' + process.argv.slice(1).join(' | '));
fileLog('electron: ' + process.versions.electron + ' chrome: ' + process.versions.chrome);
fileLog('打包? ' + (app.isPackaged ? '是' : '否') + '  asar: ' + __dirname);

process.on('uncaughtException', (err) => {
  fileLog('[崩溃] ' + (err && err.stack ? err.stack : String(err)));
});

// --smoke：自检模式。启动 → 等几秒 → 截图 → 退出，用来验证界面能不能正常渲染。
const SMOKE = process.argv.includes('--smoke');
// --probe：DOM 探针。把招聘页真实结构挖出来，用来修选择器。
const PROBE = process.argv.includes('--probe');
// --mock：用假数据渲染界面，不开浏览器。纯样式自检。
const MOCK = process.argv.includes('--mock');

// ---------------------------------------------------------------------------
// 反检测：把 UA 里的 Electron 标识抹掉
// 普通 <webview> 的 UA 会带 "Electron/45.2.3"，页面一眼就能认出这是壳浏览器。
// 这里用真实的 Chromium 版本号拼一个标准 Chrome UA。
// 必须在 app ready 之前设置。
// ---------------------------------------------------------------------------
app.userAgentFallback =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${process.versions.chrome} Safari/537.36`;

// 关掉自动化特征位（navigator.webdriver 等），再少一个被识别的理由
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// ---------------------------------------------------------------------------
// 配置持久化（存在系统用户数据目录，不进项目目录）
// Windows 下大致是：C:\Users\<你>\AppData\Roaming\boss-auto\config.json
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  minSalary: 0,             // 薪资下限，单位 K/月。0 = 不筛
  excludeWords: [],         // 命中这些词的职位直接排除（标题+公司名都查）
  excludeCompanies: [],     // 排除指定公司
  autoScan: true,           // 页面加载完自动扫一次
  todayDate: '',            // 计数所属日期
  todayCount: 0,            // 今天已投数量（只做统计，不做限制）
  deliveredIds: [],         // 已投递过的职位 ID，防重复投
  batchCount: 100,          // 本次投递数量（滑块记住上次的值）
};

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(cfg) {
  const target = { ...DEFAULT_CONFIG, ...cfg };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(target, null, 2), 'utf8');
  return target;
}

// ---------------------------------------------------------------------------
// 拦下 BOSS 的「投完就跳聊天页」
//
// Boss 点「立即沟通」的流程是：先调加好友接口（这一步招呼已经发出去了），
// 成功后直接 window.location.href = "/web/geek/chat?id=..."，整页跳走。
// 跳走之后职位列表数据全丢，后面的投递全部作废。
//
// 关键：<webview> 标签上的 will-navigate 事件 preventDefault 是无效的，
// 必须在主进程拿到 guest webContents 才能拦。
// ---------------------------------------------------------------------------
const BOSS_CHAT_NAV_RE = /^https?:\/\/(?:[a-z0-9-]+\.)*zhipin\.com\/web\/geek\/chat(?:[/?#]|$)/i;

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;

  contents.on('will-navigate', (e, url) => {
    if (BOSS_CHAT_NAV_RE.test(String(url || ''))) {
      e.preventDefault();
      console.log('[已拦截] 跳转聊天页：' + String(url).slice(0, 90));
      // 往页面里打个时间戳标记。
      // BOSS 只有「加好友成功」才会发起这次跳转，所以这个标记
      // 就等于「刚才那次立即沟通成功了」的铁证，投递引擎靠它判定成功。
      try {
        contents.executeJavaScript('window.__bossNavBlockedAt = Date.now()', true).catch(() => {});
      } catch (_) { /* 忽略 */ }
    }
  });
});

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
let win = null;

function createWindow() {
  fileLog('[窗口] 开始创建');
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1120,
    minHeight: 700,
    title: 'BOSS 干跑检查器',
    backgroundColor: '#0e1116',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // 渲染进程和 Node 隔离
      nodeIntegration: false,
      webviewTag: true,         // ★ 关键：不开这个 <webview> 根本用不了
    },
  });

  win.loadFile(
    path.join(__dirname, 'ui', 'index.html'),
    MOCK ? { query: { mock: '1' } } : undefined
  ).catch((err) => {
    fileLog('[窗口] loadFile 失败: ' + ((err && err.message) || err));
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    fileLog(`[页面] 加载失败 ${code} ${desc} ${url}`);
  });
  win.once('ready-to-show', () => {
    fileLog('[窗口] ready-to-show，显示窗口');
    win.show();
  });

  // 自检：等界面和内嵌页都渲染出来，截一张图存到临时目录，然后退出
  if (SMOKE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          const out = path.join(os.tmpdir(), 'boss-auto-smoke.png');
          fs.writeFileSync(out, img.toPNG());
          console.log('SMOKE_OK ' + out);
        } catch (e) {
          console.log('SMOKE_FAIL ' + (e && e.message));
        }
        app.exit(0);
      }, 6000);
    });
  }

  // 探针：把招聘页真实 DOM 结构打出来（开发调试用，不影响正常使用）
  if (PROBE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const { webContents } = require('electron');
          const guest = webContents.getAllWebContents().find((w) => {
            try {
              return w.getType() === 'webview' || /zhipin\.com/.test(w.getURL());
            } catch { return false; }
          });
          if (!guest) throw new Error('没找到内嵌页面');

          const probe = String.raw`(() => {
            const sels = ['.job-card-box','li.job-card-box','.job-card-wrap','.job-name','.job-salary','.boss-name','.company-location','.job-detail-op a.op-btn-chat'];
            const counts = {};
            sels.forEach(s => { counts[s] = document.querySelectorAll(s).length; });
            const salaries = [];
            document.querySelectorAll('.job-salary').forEach((el, i) => {
              if (i >= 6) return;
              const t = (el.textContent || '').trim();
              salaries.push({ text: t, codes: Array.from(t.slice(0, 8)).map(c => c.charCodeAt(0)) });
            });
            return {
              url: location.href,
              title: document.title,
              bodyLen: document.body.textContent.length,
              hookInstalled: !!window.__bossApiHookInstalled,
              hookStats: window.__bossHookStats || null,
              counts,
              salaries,
            };
          })()`;

          const r = await guest.executeJavaScript(probe);
          console.log('=== PROBE ===');
          console.log(JSON.stringify(r, null, 2));
        } catch (e) {
          console.log('PROBE_FAIL ' + (e && e.message));
        }
        app.exit(0);
      }, 7000);
    });
  }

  // F12 / Ctrl+Shift+I 开控制台，出问题时能看报错
  win.webContents.on('before-input-event', (event, input) => {
    const isF12 = input.key === 'F12';
    const isCtrlShiftI = input.control && input.shift && input.key.toLowerCase() === 'i';
    if (isF12 || isCtrlShiftI) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // 页面里的 target="_blank" 链接交给系统浏览器，别在程序里乱开窗
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('config:load', () => readConfig());
ipcMain.handle('config:save', (_e, cfg) => writeConfig(cfg));
ipcMain.handle('app:info', () => ({
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  userData: app.getPath('userData'),
  configFile: configPath(),
  ua: app.userAgentFallback,
}));

ipcMain.handle('app:paths', () => ({
  webviewPreload: path.join(__dirname, 'webview-preload.js'),
}));

// 把页面结构写到桌面，便于排查选择器失效
ipcMain.handle('report:save', (_e, data) => {  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const target = path.join(app.getPath('desktop'), `boss-dom-${stamp}.json`);
    fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  fileLog('[app] whenReady 触发');
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
