/**
 * 注入到 BOSS 页面的 preload
 *
 * 职责：拦 BOSS 自己的接口响应，捞出「明文薪资」。
 *
 * 为什么这么绕：
 *   Electron 的 preload 跑在「隔离世界」，那里的 window.fetch / XMLHttpRequest
 *   跟页面自己用的根本不是同一套对象。直接在 preload 里 hook 是无效的。
 *   必须用 webFrame.executeJavaScript 把钩子代码注入到「主世界」，
 *   再让主世界用 postMessage 把数据回传，preload 收到后转给宿主。
 *
 * 为什么需要明文薪资：
 *   BOSS 把页面上的薪资数字用私有字体（PUA 字符）混淆了，
 *   DOM 里读到的是乱码字符，只有接口返回的 salaryDesc 是明文的 "15-20K"。
 *
 * 只读，不改页面，不发任何外部请求。
 */

const { ipcRenderer, webFrame } = require('electron');

// ---------------------------------------------------------------------------
// 下面这个函数会被 toString() 后注入到页面主世界执行。
// 里面不能引用本文件作用域外的任何变量。
// ---------------------------------------------------------------------------
function bossMainWorldHook() {
  if (window.__bossHookStats) return;   // 已经装过了
  window.__bossHookInstalled = true;

  const stats = { installed: true, xhr: 0, fetch: 0, jsonHit: 0, jobs: 0, urls: [], lastErr: '' };
  window.__bossHookStats = stats;

  const MAX_JOBS = 400;
  const MAX_BODY = 4 * 1024 * 1024;

  function noteUrl(url) {
    if (stats.urls.length < 25) stats.urls.push(String(url || '').slice(0, 150));
  }

  function post(jobs, source) {
    try {
      stats.jobs += jobs.length;
      window.postMessage({ __bossJobs: true, jobs, source }, '*');
    } catch (e) {
      stats.lastErr = String((e && e.message) || e).slice(0, 200);
    }
  }

  function extract(node, out, depth) {
    if (!node || depth > 7 || out.length >= MAX_JOBS) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) extract(node[i], out, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;

    if (node.salaryDesc && (node.jobName || node.brandName)) {
      out.push({
        jobName: String(node.jobName || ''),
        brandName: String(node.brandName || ''),
        salaryDesc: String(node.salaryDesc || ''),
        cityName: String(node.cityName || ''),
        areaDistrict: String(node.areaDistrict || ''),
        businessDistrict: String(node.businessDistrict || ''),
        jobLabels: Array.isArray(node.jobLabels) ? node.jobLabels.slice(0, 10) : [],
        skills: Array.isArray(node.skills) ? node.skills.slice(0, 10) : [],
        securityId: String(node.securityId || ''),
        encryptJobId: String(node.encryptJobId || ''),
        lid: String(node.lid || ''),
      });
    }

    for (const k in node) {
      if (Object.prototype.hasOwnProperty.call(node, k)) {
        try { extract(node[k], out, depth + 1); } catch (e) { /* 忽略 */ }
      }
    }
  }

  function report(text, source) {
    try {
      if (!text || text.length < 20 || text.length > MAX_BODY) return;
      if (text.indexOf('salaryDesc') < 0) return;   // 字符串预筛，省得每个响应都 parse
      stats.jsonHit += 1;
      const data = JSON.parse(text);
      const jobs = [];
      extract(data, jobs, 0);
      if (jobs.length) post(jobs, source);
    } catch (e) {
      stats.lastErr = String((e && e.message) || e).slice(0, 200);
    }
  }

  function interesting(url) {
    const s = String(url || '');
    return s.indexOf('zhipin.com') >= 0 || s.indexOf('/wapi/') >= 0;
  }

  // ---- hook XMLHttpRequest ----
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      try { this.__bossUrl = String(url || ''); } catch (e) { /* 忽略 */ }
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.send = function () {
      const self = this;
      stats.xhr += 1;
      try {
        self.addEventListener('load', function () {
          const url = String(self.__bossUrl || '');
          if (!url) return;
          noteUrl(url);
          if (!interesting(url)) return;
          report(self.responseText, 'xhr');
        });
      } catch (e) { /* 忽略 */ }
      return origSend.apply(this, arguments);
    };
  }

  // ---- hook fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function () {
      stats.fetch += 1;
      const p = origFetch.apply(this, arguments);
      try {
        p.then(function (res) {
          const url = String((res && res.url) || '');
          if (url) noteUrl(url);
          if (!interesting(url)) return;
          if (typeof res.clone !== 'function') return;
          res.clone().text().then(function (t) { report(t, 'fetch'); }).catch(function (e) {
            stats.lastErr = String((e && e.message) || e).slice(0, 200);
          });
        }).catch(function () { /* 忽略 */ });
      } catch (e) { /* 忽略 */ }
      return p;
    };
  }
}

// ---------------------------------------------------------------------------
// 把钩子注入主世界
// ---------------------------------------------------------------------------
try {
  webFrame.executeJavaScript('(' + bossMainWorldHook.toString() + ')()');
} catch (e) {
  try { ipcRenderer.sendToHost('boss-hook-error', String((e && e.message) || e)); } catch (_) { /* 忽略 */ }
}

// ---------------------------------------------------------------------------
// 主世界抓到数据后用 postMessage 回传，这里转交给宿主
// ---------------------------------------------------------------------------
window.addEventListener('message', function (e) {
  const d = e && e.data;
  if (!d || d.__bossJobs !== true || !Array.isArray(d.jobs)) return;
  try {
    ipcRenderer.sendToHost('boss-jobs', { jobs: d.jobs, source: d.source || 'hook' });
  } catch (err) { /* 忽略 */ }
});
