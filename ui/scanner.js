/**
 * BOSS 页面扫描器
 *
 * ★ 这个函数会被 toString() 序列化后注入到 BOSS 真实页面里执行，
 *   所以它必须【完全自包含】——不能引用本文件以外的任何变量、常量、模块。
 *
 * 它只做两件事：
 *   1. 读（把职位卡片信息抓出来）
 *   2. 标（用边框和角标圈出来）
 * 绝不点击任何东西。
 */

window.BOSS_SCAN = function (cfg) {
  cfg = cfg || {};

  var MIN_SALARY = Number(cfg.minSalary) || 0;
  var EXCLUDE_WORDS = (cfg.excludeWords || []).filter(Boolean);
  var EXCLUDE_COMPANIES = (cfg.excludeCompanies || []).filter(Boolean);
  // 从 BOSS 接口捞到的明文职位数据（含真实薪资）
  var CACHE = cfg.jobCache || [];
  // 本工具已经投过的职位 ID，用来防重复
  var DELIVERED_IDS = cfg.deliveredIds || [];
  var deliveredSet = {};
  for (var di = 0; di < DELIVERED_IDS.length; di++) {
    if (DELIVERED_IDS[di]) deliveredSet[DELIVERED_IDS[di]] = 1;
  }

  function lookupCache(title, company) {
    if (!title) return '';
    for (var i = 0; i < CACHE.length; i++) {
      if (CACHE[i].n === title && CACHE[i].b === company) return CACHE[i].s || '';
    }
    // 公司名偶尔对不上，退一步只按职位名匹配
    for (var j = 0; j < CACHE.length; j++) {
      if (CACHE[j].n === title) return CACHE[j].s || '';
    }
    return '';
  }

  // -------------------------------------------------------------------------
  // 选择器表：每个目标配多个候选，从左到右依次尝试，第一个有命中的胜出。
  // BOSS 前端改版时，这里是最先崩的地方 —— 所以候选要够多。
  // -------------------------------------------------------------------------
  var SEL = {
    JOB_CARD: [
      'li.job-card-box',            // ← 2026 新版实测结构
      '.job-card-box',
      '.job-card-wrap',             // 新版内层兜底
      '.job-card-wrapper',          // 老版兜底
      'ul.job-list > li.job-card',
      '[ka="job-card"]',
    ],
    JOB_NAME: [
      '.job-name',
      '.job-title .job-name',
      '[ka="job-name"]',
      '.job-card-left .job-name',
    ],
    JOB_SALARY: [
      '.job-salary',
      '.salary',
      '[ka="job-salary"]',
      '.job-title .red',
    ],
    COMPANY: [
      '.job-card-footer .boss-name',    // ← 优先在卡片底部取，避免抓到 HR 名字
      '.job-card-footer .company-name',
      '.boss-name',
      '.company-name',
      '.company-info h3',
      '[ka="job-card-company"]',
    ],
    AREA: [
      '.company-location',          // ← 新版实测
      '.job-area',
      '.job-area-wrapper',
      '[ka="job-area"]',
    ],
    TAGS: [
      '.tag-list li',
      '.job-tags span',
      '.job-info ul.tag-list li',
    ],
    // 新版按钮在右侧详情区，不在列表卡片上
    CHAT_BUTTON: [
      '.job-detail-op a.op-btn-chat',
      '.op-btn-chat',
      'a.op-btn-chat',
      '.btn-startchat',
      '[ka*="job_chat"]',
    ],
    JOB_LIST: [
      '.job-list-container',        // ← 新版实测
      '.rec-job-list',
      '.job-list-box',
      'ul.job-list',
    ],
  };

  // 按钮上允许出现的文字（用来做兜底识别 + 判断这个按钮到底能不能点）
  var CHAT_WORDS = ['立即沟通', '继续沟通', '马上沟通', '立即申请', '投个简历'];

  // -------------------------------------------------------------------------
  // 小工具
  // -------------------------------------------------------------------------
  function q1(root, list) {
    for (var i = 0; i < list.length; i++) {
      var el = root.querySelector(list[i]);
      if (el) return el;
    }
    return null;
  }

  function qa(root, list) {
    for (var i = 0; i < list.length; i++) {
      var els = root.querySelectorAll(list[i]);
      if (els && els.length) return els;
    }
    return [];
  }

  function txt(el) {
    if (!el) return '';
    return String(el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  // -------------------------------------------------------------------------
  // 从 Vue 组件实例读数据（GetJob page-hydrate 同款思路）
  //
  // BOSS 是 Vue 应用，职位数据就挂在卡片的组件实例上。
  // 这比读 DOM 文本可靠得多：
  //   - 薪资在页面上被私有字体混淆成乱码，Vue 数据里是明文
  //   - 公司名不会抓到 HR 的名字
  //   - 还能拿到加密职位 ID，后面靠它校验按钮归属
  // -------------------------------------------------------------------------
  function pickVueJob(obj) {
    if (!obj || typeof obj !== 'object') return null;
    var name = obj.jobName;
    var id = obj.encryptJobId || obj.encryptId;
    var sal = obj.salaryDesc;
    if (!name || !(id || sal)) return null;
    return {
      encryptJobId: String(obj.encryptJobId || obj.encryptId || ''),
      encryptBossId: String(obj.encryptBossId || ''),
      jobName: String(obj.jobName || ''),
      salaryDesc: String(obj.salaryDesc || ''),
      jobExperience: String(obj.jobExperience || ''),
      jobDegree: String(obj.jobDegree || ''),
      cityName: String(obj.cityName || ''),
      areaDistrict: String(obj.areaDistrict || ''),
      businessDistrict: String(obj.businessDistrict || ''),
      brandName: String(obj.brandName || ''),
      brandScaleName: String(obj.brandScaleName || ''),
      bossName: String(obj.bossName || ''),
      bossTitle: String(obj.bossTitle || ''),
      skills: Array.isArray(obj.skills) ? obj.skills.slice(0, 12) : [],
      jobLabels: Array.isArray(obj.jobLabels) ? obj.jobLabels.slice(0, 12) : [],
    };
  }

  function readVueJob(el) {
    var cur = el;
    // 沿 DOM 向上找 8 层，碰到第一个带 Vue 实例的元素就读
    for (var up = 0; up < 8 && cur; up++) {
      var inst = cur.__vueParentComponent || cur.__vue__;
      if (inst) {
        var sources = [inst.data, inst._data, inst.props, inst.setupState, inst.ctx];
        for (var si = 0; si < sources.length; si++) {
          var src = sources[si];
          if (!src) continue;
          var hit = pickVueJob(src.job || src.jobInfo || src.item || src);
          if (hit) return hit;
        }
      }
      cur = cur.parentElement;
    }
    return null;
  }

  // 薪资统一换算成「K / 月」，方便和用户设的薪资下限比较
  function parseSalary(s) {
    if (!s) return null;
    var t = String(s).replace(/\s/g, '');
    if (/面议|面谈|薪资面议/.test(t)) return { min: null, max: null, raw: s, negotiable: true };

    var m = t.match(/(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)([Kk千万])/);
    if (m) {
      var a = parseFloat(m[1]);
      var b = parseFloat(m[2]);
      var u = m[3];
      if (u === '万') {
        // 万/年 → K/月；万/月 → K/月
        if (/年/.test(t)) { a = (a * 10) / 12; b = (b * 10) / 12; }
        else { a = a * 10; b = b * 10; }
      }
      return { min: round1(a), max: round1(b), raw: s };
    }

    var m2 = t.match(/(\d+(?:\.\d+)?)元\/天/);
    if (m2) {
      var daily = (parseFloat(m2[1]) * 21) / 1000; // 21 个工作日粗算
      return { min: round1(daily), max: round1(daily), raw: s, fromDaily: true };
    }

    var m3 = t.match(/(\d+(?:\.\d+)?)([Kk千])/);
    if (m3) {
      var v = parseFloat(m3[1]);
      return { min: round1(v), max: round1(v), raw: s };
    }

    return null;
  }

  function getJobId(card) {
    var a = card.querySelector('a[href*="job_detail"]');
    if (a) {
      var href = a.getAttribute('href') || '';
      var m = href.match(/job_detail\/([^.?\/#]+)/);
      if (m) return m[1];
    }
    var ka = card.getAttribute('ka') || '';
    if (ka) return ka;
    return '';
  }

  // 找「立即沟通」按钮：先走选择器，再走文字兜底
  function findChatButton(card) {
    var btn = q1(card, SEL.CHAT_BUTTON);
    if (btn && CHAT_WORDS.indexOf(txt(btn)) >= 0) return { el: btn, text: txt(btn) };

    // 文字兜底：只认长度很短、文字完全等于这些词的元素
    var all = card.querySelectorAll('a, button, div, span');
    for (var i = 0; i < all.length; i++) {
      var t = txt(all[i]);
      if (t && t.length <= 8 && CHAT_WORDS.indexOf(t) >= 0) {
        return { el: all[i], text: t };
      }
    }
    if (btn) return { el: btn, text: txt(btn) };
    return null;
  }

  // -------------------------------------------------------------------------
  // 先清掉上一轮的标记，避免越扫越花
  // -------------------------------------------------------------------------
  function clearMarks() {
    var marks = document.querySelectorAll('[data-boss-auto-mark]');
    for (var i = 0; i < marks.length; i++) {
      var el = marks[i];
      el.style.outline = '';
      el.style.outlineOffset = '';
      el.removeAttribute('data-boss-auto-mark');
    }
    var badges = document.querySelectorAll('[data-boss-auto-badge]');
    for (var j = 0; j < badges.length; j++) badges[j].remove();
    var posed = document.querySelectorAll('[data-boss-auto-pos]');
    for (var k = 0; k < posed.length; k++) {
      posed[k].style.position = '';
      posed[k].removeAttribute('data-boss-auto-pos');
    }
  }

  function markCard(card, color, dashed) {
    card.setAttribute('data-boss-auto-mark', '1');
    card.style.outline = (dashed ? '1px dashed ' : '2px solid ') + color;
    card.style.outlineOffset = '2px';
  }

  function addBadge(card, text, bg) {
    if (getComputedStyle(card).position === 'static') {
      card.style.position = 'relative';
      card.setAttribute('data-boss-auto-pos', '1');
    }
    var b = document.createElement('div');
    b.setAttribute('data-boss-auto-badge', '1');
    b.textContent = text;
    b.style.cssText =
      'position:absolute;top:-1px;right:-1px;z-index:99999;' +
      'background:' + bg + ';color:#fff;' +
      'font:700 11px/1.4 -apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif;' +
      'padding:1px 7px;border-radius:0 5px 0 6px;' +
      'box-shadow:0 1px 4px rgba(0,0,0,.22);pointer-events:none;white-space:nowrap;';
    card.appendChild(b);
  }

  // -------------------------------------------------------------------------
  // 开始扫
  // -------------------------------------------------------------------------
  clearMarks();

  var cards = qa(document, SEL.JOB_CARD);
  var listRoot = q1(document, SEL.JOB_LIST);
  // 是否是「左列表 + 右详情」分栏布局（决定卡片上没有按钮是否正常）
  var splitLayout = !!document.querySelector('.job-detail-container, .job-detail-op, .job-detail-box');

  // 诊断：每个选择器各自命中了多少个，用来判断哪个规则失效了
  var diag = Object.keys(SEL).map(function (key) {
    var best = { key: key, sel: '', n: 0 };
    for (var i = 0; i < SEL[key].length; i++) {
      var n = document.querySelectorAll(SEL[key][i]).length;
      if (n > best.n) best = { key: key, sel: SEL[key][i], n: n };
    }
    return best;
  });

  var results = [];
  var okCount = 0;

  for (var i = 0; i < cards.length; i++) {
    var card = cards[i];

    // 过滤掉明显不是职位卡片的容器（有些兜底选择器会误伤）
    if (card.querySelectorAll('a[href*="job_detail"]').length > 1) continue;

    // 优先从 Vue 实例读（明文），DOM 文本只做兜底
    var vue = readVueJob(card);

    var title = (vue && vue.jobName) || txt(q1(card, SEL.JOB_NAME));
    var company = (vue && vue.brandName) || txt(q1(card, SEL.COMPANY));
    var salaryRaw = (vue && vue.salaryDesc) || txt(q1(card, SEL.JOB_SALARY));
    var salaryFromApi = !!(vue && vue.salaryDesc);

    // Vue 没读到、且 DOM 文本被字体混淆（没有阿拉伯数字）时，用接口缓存兜底
    if (!/\d/.test(salaryRaw)) {
      var realSalary = lookupCache(title, company);
      if (realSalary) {
        salaryRaw = realSalary;
        salaryFromApi = true;
      }
    }

    var area = '';
    if (vue && (vue.cityName || vue.areaDistrict)) {
      area = [vue.cityName, vue.areaDistrict].filter(Boolean).join('·');
    } else {
      area = txt(q1(card, SEL.AREA));
    }

    var tags = [];
    if (vue && vue.skills && vue.skills.length) {
      tags = vue.skills.slice();
    } else {
      var tagEls = qa(card, SEL.TAGS);
      for (var t = 0; t < tagEls.length && tags.length < 6; t++) {
        var tt = txt(tagEls[t]);
        if (tt) tags.push(tt);
      }
    }

    // 标题太短或没有标题，基本可以判定选择器没认对
    if (!title && !company) continue;

    var chat = findChatButton(card);
    var salary = parseSalary(salaryRaw);
    // 加密职位 ID 优先从 Vue 取，它是校验按钮归属的关键
    var jobId = (vue && vue.encryptJobId) || getJobId(card);

    // 打上索引标记，投递时靠它精确定位到这一张卡
    card.setAttribute('data-boss-auto-idx', String(i));

    var status = 'ok';
    var reason = '';

    // 最高优先级：本工具投过的，直接跳过
    if (jobId && deliveredSet[jobId]) {
      status = 'skip';
      reason = '你已经投过了（本工具记录）';
    }

    // 2026 新版是「左列表 + 右详情」分栏，卡片上本来就没有按钮，
    // 按钮在右侧详情区。所以卡片无按钮不能当成「不可投」。
    var noBtnIsNormal = splitLayout;

    if (status === 'skip') {
      // 已经判过了，不再往下走
    } else if (!chat && !noBtnIsNormal) {
      status = 'skip';
      reason = '卡片上没有沟通按钮（可能已投递 / 已关闭）';
    } else if (chat && chat.text.indexOf('立即沟通') < 0 && chat.text.indexOf('立即申请') < 0) {
      status = 'skip';
      reason = '按钮状态是「' + chat.text + '」，不是可投递状态';
    } else {
      var haystack = (title + ' ' + company + ' ' + tags.join(' ')).toLowerCase();

      for (var w = 0; w < EXCLUDE_WORDS.length; w++) {
        var word = String(EXCLUDE_WORDS[w]).toLowerCase().trim();
        if (word && haystack.indexOf(word) >= 0) {
          status = 'skip';
          reason = '命中排除词「' + EXCLUDE_WORDS[w] + '」';
          break;
        }
      }

      if (status === 'ok') {
        for (var c = 0; c < EXCLUDE_COMPANIES.length; c++) {
          var co = String(EXCLUDE_COMPANIES[c]).trim();
          if (co && company.indexOf(co) >= 0) {
            status = 'skip';
            reason = '排除公司「' + co + '」';
            break;
          }
        }
      }

      if (status === 'ok' && MIN_SALARY > 0) {
        if (!salary || salary.min == null) {
          reason = '薪资不明（' + (salaryRaw || '空') + '），未参与筛选';
        } else if (salary.min < MIN_SALARY) {
          status = 'skip';
          reason = '薪资低于 ' + MIN_SALARY + 'K（' + salaryRaw + '）';
        }
      }
    }

    // 上色
    if (status === 'ok') {
      okCount++;
      markCard(card, '#22c55e', false);
      addBadge(card, String(okCount), '#16a34a');
      if (chat && chat.el) {
        chat.el.style.outline = '2px solid #f59e0b';
        chat.el.style.outlineOffset = '3px';
        chat.el.style.borderRadius = '6px';
        chat.el.setAttribute('data-boss-auto-mark', '1');
      }
    } else {
      markCard(card, '#8b949e', true);
    }

    results.push({
      index: i,
      domIdx: i,
      jobId: jobId,
      title: title || '(标题未识别)',
      company: company || '(公司未识别)',
      salaryRaw: salaryRaw || '',
      salaryMin: salary ? salary.min : null,
      salaryMax: salary ? salary.max : null,
      salaryFromApi: salaryFromApi,
      area: area || '',
      tags: tags,
      hasChat: !!chat,
      chatText: chat ? chat.text : '',
      status: status,
      reason: reason,
    });
  }

  // -------------------------------------------------------------------------
  // 详情区的沟通按钮
  // BOSS 新版是「左侧列表 + 右侧详情」分栏布局，按钮不在卡片上而在详情区。
  // 这里在整页范围内找一个可见的、文字对得上的按钮，找到就圈绿框。
  // 注意：只圈，不点。
  // -------------------------------------------------------------------------
  var detailBtn = null;
  var pageEls = document.querySelectorAll('a, button');
  for (var d = 0; d < pageEls.length; d++) {
    var e = pageEls[d];
    if (CHAT_WORDS.indexOf(txt(e)) < 0) continue;
    if (e.offsetParent === null) continue;                    // 不可见
    if (e.closest && e.closest('[data-boss-auto-mark]')) continue; // 卡片里已经标过
    detailBtn = e;
    break;
  }
  if (detailBtn) {
    detailBtn.setAttribute('data-boss-auto-mark', '1');
    detailBtn.style.outline = '3px solid #22c55e';
    detailBtn.style.outlineOffset = '3px';
    detailBtn.style.borderRadius = '6px';
  }

  // 页面状态判断 —— 这些提示能省掉 90% 的「怎么没反应」的困惑
  var bodyText = (document.body && document.body.textContent) || '';
  var page = {
    url: location.href,
    title: document.title,
    isLogin: /login|passport|signin/i.test(location.href) ||
             /\/web\/user/i.test(location.href) ||
             !!document.querySelector('.login-form, .boss-login'),
    hasRisk: /访问受限|您.?的账户存在异常行为|频繁提交刷新请求|操作过于频繁/.test(bodyText),
    hasCaptcha: /安全验证|请完成验证|拖动滑块|验证码/.test(bodyText),
    listFound: !!listRoot || cards.length > 0,
    cardCount: cards.length,
    scannedUrl: location.href,
  };

  return {
    ok: true,
    at: Date.now(),
    page: page,
    detail: {
      found: !!detailBtn,
      text: detailBtn ? txt(detailBtn) : '',
    },
    // 接口钩子（主世界）是否装上了
    hookInstalled: !!window.__bossHookStats,
    hookStats: window.__bossHookStats
      ? {
          xhr: window.__bossHookStats.xhr,
          fetch: window.__bossHookStats.fetch,
          jsonHit: window.__bossHookStats.jsonHit,
          jobs: window.__bossHookStats.jobs,
          urls: (window.__bossHookStats.urls || []).slice(0, 8),
          lastErr: window.__bossHookStats.lastErr,
        }
      : null,
    diag: diag,
    cards: results,
    summary: {
      total: results.length,
      ok: okCount,
      skip: results.length - okCount,
    },
  };
};

/**
 * 页面结构导出器
 *
 * ★ 同样必须完全自包含（会被 toString 后注入执行）。
 * 用来在 BOSS 改版、选择器失效时，把真实 DOM 结构抓出来校准规则。
 * 只读，不改页面。
 */
window.BOSS_DUMP = function () {
  function txtOf(e) {
    return String((e && e.textContent) || '').replace(/\s+/g, '').trim();
  }
  function rectOf(e) {
    var r = e.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  }
  function clsOf(e) {
    return String((e && e.className) || '').slice(0, 140);
  }

  var out = {
    url: location.href,
    title: document.title,
    at: Date.now(),
    viewport: [window.innerWidth, window.innerHeight],
    hookStats: window.__bossHookStats || null,
  };

  // ---- 1. 所有像「动作按钮」的元素 ----
  var WORDS = ['立即沟通', '继续沟通', '马上沟通', '立即申请', '投个简历', '收藏', '已投递', '不感兴趣'];
  var actions = [];
  var els = document.querySelectorAll('a, button, div, span');
  for (var i = 0; i < els.length && actions.length < 40; i++) {
    var e = els[i];
    var t = txtOf(e);
    if (!t || t.length > 10) continue;
    if (WORDS.indexOf(t) < 0) continue;
    var cs = getComputedStyle(e);
    actions.push({
      text: t,
      tag: e.tagName,
      cls: clsOf(e),
      id: e.id || '',
      ka: e.getAttribute('ka') || '',
      href: e.getAttribute('href') || '',
      visible: e.offsetParent !== null && cs.display !== 'none' && cs.visibility !== 'hidden',
      rect: rectOf(e),
      parentTag: e.parentElement ? e.parentElement.tagName : '',
      parentCls: e.parentElement ? clsOf(e.parentElement) : '',
    });
  }
  out.actions = actions;

  // ---- 2. 像「职位卡片」的容器 ----
  var cards = [];
  var cardEls = document.querySelectorAll('[class*="job-card"], [class*="job-item"], li[class*="job"]');
  for (var j = 0; j < cardEls.length && cards.length < 20; j++) {
    var c = cardEls[j];
    cards.push({
      tag: c.tagName,
      cls: clsOf(c),
      kids: c.children.length,
      rect: rectOf(c),
      textSample: String(c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    });
  }
  out.cards = cards;

  // ---- 3. 像「详情区」的容器 ----
  var details = [];
  var dEls = document.querySelectorAll('[class*="job-detail"], [class*="detail-box"], [class*="job-detail-container"], [class*="job-detail-wrapper"]');
  for (var k = 0; k < dEls.length && details.length < 12; k++) {
    details.push({
      tag: dEls[k].tagName,
      cls: clsOf(dEls[k]),
      rect: rectOf(dEls[k]),
    });
  }
  out.detailContainers = details;

  // ---- 3b. 分页 / 翻页相关元素（排查翻页结构用）----
  var pagers = [];
  var pEls = document.querySelectorAll('[class*="page"], [class*="pager"], [class*="pagination"]');
  for (var pi = 0; pi < pEls.length && pagers.length < 12; pi++) {
    var pe = pEls[pi];
    if (pe.offsetParent === null) continue;
    var pr = rectOf(pe);
    if (pr[2] < 10 || pr[3] < 5) continue;
    pagers.push({
      tag: pe.tagName,
      cls: clsOf(pe),
      text: String(pe.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70),
      rect: pr,
    });
  }
  out.pagers = pagers;

  // ---- 4. 页面出现过的所有 class 名（去重，用来发现真实命名） ----
  var classes = [];
  var seen = {};
  var all = document.querySelectorAll('*');
  for (var m = 0; m < all.length && classes.length < 600; m++) {
    var cn = all[m].className;
    if (typeof cn !== 'string' || !cn) continue;
    var parts = cn.split(/\s+/);
    for (var p = 0; p < parts.length; p++) {
      var x = parts[p];
      if (x && !seen[x]) { seen[x] = 1; classes.push(x); }
    }
  }
  out.allClasses = classes;

  return out;
};

/**
 * 加载更多职位（翻页 / 滚动懒加载）
 *
 * ★ 自包含，注入页面执行。只做「翻页」这一个动作，不投递。
 *
 * 策略按可靠性排序：
 *   1. 找「下一页」按钮点它（新版 BOSS 用的就是这种）
 *   2. 按钮文字兜底
 *   3. 都没有就把列表滚到底，触发懒加载
 */
window.BOSS_LOAD_MORE = function () {
  var NEXT_SEL = [
    '.options-pages a.next',
    '.pagination a.next',
    '.page-nav a.next',
    '.ui-pagination .next',
    'a[ka*="next"]',
    '[class*="pagination"] [class*="next"]',
    '[class*="page"] a[class*="next"]',
    '.job-list-container ~ * a.next',
  ];

  function visible(el) {
    if (!el) return false;
    if (el.offsetParent === null) return false;
    var r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  }

  function clickIt(el) {
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2;
    var y = r.top + r.height / 2;
    var o = {
      bubbles: true, cancelable: true, view: window, button: 0,
      clientX: x, clientY: y, screenX: x, screenY: y,
    };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  }

  // ---- 1. 选择器找「下一页」 ----
  for (var i = 0; i < NEXT_SEL.length; i++) {
    var btn = document.querySelector(NEXT_SEL[i]);
    if (!visible(btn)) continue;
    if (/disabled|is-disabled|ban/i.test(String(btn.className || ''))) continue;
    clickIt(btn);
    return { ok: true, how: 'next-button', sel: NEXT_SEL[i] };
  }

  // ---- 2. 文字兜底 ----
  var all = document.querySelectorAll('a, button, li, span');
  for (var j = 0; j < all.length; j++) {
    var t = (all[j].textContent || '').replace(/\s+/g, '');
    if ((t === '下一页' || t === '下一页>' || t === '下页') && visible(all[j])) {
      clickIt(all[j]);
      return { ok: true, how: 'text' };
    }
  }

  // ---- 3. 滚动触发懒加载 ----
  var box = document.querySelector('.job-list-container, .rec-job-list, .job-list-box, ul.job-list');
  if (box && box.scrollHeight > box.clientHeight + 40) {
    box.scrollTop = box.scrollHeight;
    return { ok: true, how: 'scroll-list' };
  }

  window.scrollTo(0, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
  return { ok: true, how: 'scroll-page' };
};

/**
 * 读取分页状态（判断是不是已经到最后一页）
 */
window.BOSS_PAGE_STATE = function () {
  var out = { page: '', total: '', hasNext: null, firstTitle: '', count: 0 };

  var cards = document.querySelectorAll('li.job-card-box, .job-card-box');
  out.count = cards.length;
  if (cards.length) {
    var nameEl = cards[0].querySelector('.job-name');
    out.firstTitle = nameEl ? String(nameEl.textContent || '').trim() : '';
  }

  var act = document.querySelector(
    '.options-pages .active, .pagination .active, [class*="pagination"] [class*="active"]'
  );
  if (act) out.page = String(act.textContent || '').trim();

  var next = document.querySelector('.options-pages a.next, .pagination a.next');
  if (next) {
    out.hasNext = !/disabled|is-disabled/i.test(String(next.className || ''));
  }

  return out;
};

/**
 * 单次投递执行器
 *
 * ★ 自包含，会被注入到 BOSS 页面里执行。
 *
 * 点击前必须通过四道校验，任何一道不过就中止：
 *   1. 页面没有风控提示
 *   2. 卡片还在、可见
 *   3. 详情区的职位名和卡片上的职位名一致（防误投）
 *   4. 按钮文字是「立即沟通」（不是「继续沟通」「已投递」）
 *
 * 节奏全部随机化，不跑固定间隔。
 */
window.BOSS_DELIVER = async function (cfg) {
  cfg = cfg || {};
  var idx = String(cfg.idx);
  var expectTitle = String(cfg.title || '');
  var key = expectTitle.slice(0, 8);
  var startUrl = location.href;
  var encryptId = String(cfg.jobId || '');   // 加密职位 ID，用来校验按钮归属

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }
  function jitter(base, spread) {
    return base + Math.random() * spread;
  }
  function fail(reason) {
    return { ok: false, reason: reason };
  }
  function bodyText() {
    return (document.body && document.body.textContent) || '';
  }
  // 按坐标派发一整套鼠标事件（比 element.click() 更像真人）
  function mouseClick(el, ratioX, ratioY) {
    var r = el.getBoundingClientRect();
    if (r.width < 5 || r.height < 5) return false;
    var x = r.left + r.width * ratioX;
    var y = r.top + r.height * ratioY;
    var opts = {
      bubbles: true, cancelable: true, view: window, button: 0,
      clientX: x, clientY: y, screenX: x, screenY: y,
    };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return true;
  }

  // ---- 校验 0：当前必须还在职位列表页 ----
  // 投递成功后 BOSS 会往聊天页跳，一旦跳过去列表就没了，后续操作全废
  if (!/\/web\/geek\/jobs?(\?|#|$)/.test(location.href)) {
    return fail('当前不在职位列表页（' + location.pathname + '），已中止。点右上角「职位列表」回去。');
  }

  // ---- 校验 1：风控 ----
  if (/访问受限|账户存在异常行为|频繁提交刷新请求|操作过于频繁/.test(bodyText())) {
    return fail('页面出现风控提示，已中止');
  }

  // ---- 校验 2：卡片还在不在 ----
  var card = document.querySelector('[data-boss-auto-idx="' + idx + '"]');
  if (!card) return fail('卡片找不到了，重新扫描一次');

  card.scrollIntoView({ block: 'center', behavior: 'auto' });
  await sleep(jitter(350, 300));

  // ---- 校验 2.5：先清掉挡路的弹窗（GetJob 的 assertNoPopup）----
  // 上一岗投完可能留着「已向BOSS发送消息」弹窗，不关就会点到「继续沟通」
  function findGreetPopup() {
    var els = document.querySelectorAll('a, button');
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || '').replace(/\s+/g, '');
      if ((t === '留在此页' || t === '继续沟通') && els[i].offsetParent !== null) return els[i];
    }
    return null;
  }
  if (findGreetPopup()) {
    if (!closeGreetDialog()) {
      return fail('页面有弹窗挡着且关不掉，已中止（防止点穿）');
    }
    await sleep(jitter(400, 300));
  }

  // ---- 点卡片，让右侧详情切过去 ----
  var wrap = card.querySelector('.job-card-wrap') || card;
  if (!mouseClick(wrap, 0.5, 0.72)) return fail('卡片不在可视区域，先滚一下页面');
  await sleep(jitter(900, 500));

  // 用加密 ID 匹配按钮归属（GetJob 的 chatKaMatchesJob 同款）
  function kaMatches(el) {
    if (!el) return false;
    if (!encryptId) return true;
    var ka = el.getAttribute('ka') || '';
    return ka.indexOf(encryptId) >= 0;
  }

  function readChatBtn() {
    return document.querySelector('.job-detail-op a.op-btn-chat') ||
           document.querySelector('a.op-btn-chat');
  }

  // 详情区切到本岗的标志：按钮的 ka 属性里带着本岗的加密 ID
  async function waitReady(maxRound) {
    for (var i = 0; i < maxRound; i++) {
      var b = readChatBtn();
      if (b && kaMatches(b)) {
        var t = (b.textContent || '').replace(/\s+/g, '');
        if (/已沟通|已投递|继续沟通|继续聊/.test(t)) return { state: 'chatted', text: t };
        if (/立即沟通|马上沟通|立即申请/.test(t)) return { state: 'immediate', el: b, text: t };
      }
      // 拿不到加密 ID 时退回职位名匹配
      if (!encryptId && key) {
        var h = document.querySelector('.job-detail-header');
        if (h && h.textContent.indexOf(key) >= 0) {
          var b2 = readChatBtn();
          if (b2 && /立即沟通/.test((b2.textContent || '').replace(/\s+/g, ''))) {
            return { state: 'immediate', el: b2, text: '立即沟通' };
          }
        }
      }
      await sleep(200);
    }
    return { state: 'pending' };
  }

  var ready = await waitReady(25);

  // 没切过去就再点一次卡片（GetJob 的二次重试）
  if (ready.state === 'pending') {
    mouseClick(wrap, 0.5, 0.72);
    await sleep(jitter(800, 400));
    ready = await waitReady(20);
  }

  if (ready.state === 'chatted') {
    return fail('这个岗位已经沟通过了（' + ready.text + '）');
  }
  if (ready.state !== 'immediate') {
    return fail('详情区没切到目标职位，已中止（防止投错）');
  }

  var btn = ready.el;
  var br = btn.getBoundingClientRect();
  if (br.width < 5 || br.height < 5) return fail('按钮不可见');

  // ---- 全部校验通过，动手 ----
  await sleep(jitter(400, 500));
  var clickAt = Date.now();
  mouseClick(btn, 0.5, 0.5);

  // ---- 等结果 ----
  await sleep(jitter(2600, 800));

  // 铁证：主进程拦下了「跳聊天页」的导航 = 加好友已在服务端生效。
  // 导航被拦后弹窗和按钮都可能不变化，这反而是最可靠的成功信号。
  var navBlockedAt = Number(window.__bossNavBlockedAt) || 0;
  if (navBlockedAt >= clickAt - 1500) {
    closeGreetDialog();
    return {
      ok: true,
      status: 'sent',
      note: '招呼已发出（跳转已拦截）',
    };
  }

  // 兜底：页面真被导航走了（主进程那层拦截万一失效）
  if (location.href !== startUrl) {
    return {
      ok: true,
      status: 'navigated',
      note: '招呼已发出，但页面跳到了 ' + location.pathname,
    };
  }

  var after = bodyText();

  // BOSS 服务端的每日沟通上限（实测普通账号 150/天）
  if (/达到沟通上限|已与\d+位BOSS沟通|沟通次数已用完/.test(after)) {
    // 把这个「确定」弹窗点掉，别让它挡后面的路
    var qels = document.querySelectorAll('a, button');
    for (var qi = 0; qi < qels.length; qi++) {
      var qt = (qels[qi].textContent || '').replace(/\s+/g, '');
      if (qt === '确定' && qels[qi].offsetParent !== null) {
        qels[qi].click();
        break;
      }
    }
    return fail('今日 BOSS 沟通次数已到服务端上限（约 150/天），明天再来');
  }
  var afterBtn = document.querySelector('.job-detail-op a.op-btn-chat');
  var afterText = afterBtn ? (afterBtn.textContent || '').replace(/\s+/g, '') : '';

  // 成功后的弹窗，文案是「已向BOSS发送消息」。关掉它，否则会一直挡着页面。
  // 只点 a / button，点 div 容器无效还容易误触到「继续沟通」直接跳聊天页。
  function closeGreetDialog() {
    var els = document.querySelectorAll('a, button');
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || '').replace(/\s+/g, '');
      if (t === '留在此页' || t === '留在此页面' || t === '关闭') {
        var r = els[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          els[i].click();
          return true;
        }
      }
    }
    return false;
  }

  // ---- 先看成功信号（要在关弹窗之前判断，关了文案就没了）----
  var sentHit = /已向BOSS发送消息|已发送消息|打招呼成功|沟通成功|招呼已发送/.test(after);
  if (sentHit) {
    var closed = closeGreetDialog();
    return {
      ok: true,
      status: 'sent',
      note: '招呼已发出' + (closed ? '，弹窗已关闭' : ''),
    };
  }

  // ---- 失败信号 ----
  if (/登录\/注册|扫码登录|请先登录|手机号登录/.test(after) && /立即沟通/.test(afterText)) {
    return fail('未登录。BOSS 要求先登录才能投递');
  }
  if (/安全验证|滑块|拖动|请完成验证/.test(after)) {
    return fail('触发了人机验证，需要你手动处理');
  }

  // ---- 按钮状态变了，也算成功 ----
  if (afterText && afterText.indexOf('立即沟通') < 0) {
    closeGreetDialog();
    return { ok: true, status: 'changed', note: '按钮已变成「' + afterText + '」，投出去了' };
  }

  return {
    ok: true,
    status: 'unknown',
    note: '点击已发出，但没检测到明确结果。请自己看一眼右侧页面确认',
  };
};
