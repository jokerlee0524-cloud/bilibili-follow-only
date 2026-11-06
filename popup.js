/* popup 逻辑：读写配置 + 特别关注诊断 + 内容脚本版本自愈 */
(function () {
  'use strict';

  var CFG_KEY = 'bfonly_cfg';
  var FOLLOW_KEY = 'bfonly_following';
  var DEFAULTS = { enabled: true, mode: 'split', specialOnly: false };
  var EXT_VER = chrome.runtime.getManifest().version;
  var BILI_URLS = ['https://www.bilibili.com/*', 'https://bilibili.com/*'];

  var elEnabled = document.getElementById('enabled');
  var elState = document.getElementById('stateText');
  var elCount = document.getElementById('followCount');
  var elCache = document.getElementById('cacheTime');
  var elHint = document.getElementById('hint');
  var elFoot = document.querySelector('.foot');
  var elSeg = document.getElementById('modeSeg');
  var elSpecial = document.getElementById('specialOnly');
  var elSpecialText = document.getElementById('specialText');
  var elSpecialRow = document.getElementById('specialRow');
  var elFixBar = document.getElementById('fixBar');
  var elFixText = document.getElementById('fixText');
  var elFixBtn = document.getElementById('fixBtn');
  var elDiag = document.getElementById('diagText');
  var btnRefresh = document.getElementById('refreshBtn');
  var btnOpen = document.getElementById('openBtn');

  var cfg = Object.assign({}, DEFAULTS);
  var follow = null;
  var diag = null;   // 内容脚本 ping 回来的现场状态

  function ago(ts) {
    if (!ts) return '尚未同步';
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return '刚刚同步';
    if (s < 3600) return Math.round(s / 60) + ' 分钟前同步';
    if (s < 86400) return Math.round(s / 3600) + ' 小时前同步';
    return Math.round(s / 86400) + ' 天前同步';
  }

  /* 特别关注数量：优先用分组接口解析出来的 specialMids */
  function countSpecial() {
    if (!follow) return null;
    if (Array.isArray(follow.specialMids)) return follow.specialMids.length;
    if (!follow.specialResolved) return null;   // 旧缓存，没解析过
    if (!follow.list) return 0;
    return follow.list.filter(function (u) {
      var tagged = Array.isArray(u.tag) && u.tag.some(function (t) { return Number(t) === -10; });
      return u.special === 1 || u.special === true || tagged;
    }).length;
  }

  function render() {
    var isSplit = cfg.mode === 'split';
    elEnabled.checked = !!cfg.enabled;
    elSpecial.checked = !!cfg.specialOnly;
    elSpecial.disabled = !cfg.enabled || isSplit;
    elSpecialRow.classList.toggle('off', !cfg.enabled || isSplit);

    var n = countSpecial();
    elSpecialText.textContent = isSplit
      ? '分区模式上下两块都显示，无需此开关'
      : n === null ? '仅显示设为特别关注的 UP 主（尚未读取）'
      : n > 0 ? '仅显示设为特别关注的 ' + n + ' 位 UP 主'
              : '你还没有设置特别关注，先去 B 站设置一下';

    Array.prototype.forEach.call(elSeg.querySelectorAll('.seg-btn'), function (b) {
      b.classList.toggle('active', b.dataset.mode === cfg.mode);
      b.disabled = !cfg.enabled;
    });

    if (!cfg.enabled) {
      elState.textContent = '已关闭，首页保持 B 站原样';
    } else if (isSplit) {
      elState.textContent = '首页分成两块：上★特别关注 / 下其它关注';
    } else if (cfg.mode === 'replace') {
      elState.textContent = '首页已替换为「只看关注」视频流';
    } else {
      elState.textContent = '保留原首页，仅隐藏非关注内容';
    }
    if (cfg.enabled && cfg.specialOnly && !isSplit) elState.textContent += ' · 仅特别关注';

    elCount.textContent = follow && follow.list && follow.list.length ? follow.list.length : '—';
    elCache.textContent = follow ? ago(follow.ts) : '尚未同步';

    if (follow && follow.list && follow.list.length) {
      elHint.textContent = '数据来自 B 站接口，仅存本地，不上传任何服务器';
      elFoot.classList.remove('warn');
    } else {
      elHint.textContent = '还没有关注数据：请先登录 B 站，再刷新一次';
      elFoot.classList.add('warn');
    }

    renderDiag();
    btnRefresh.disabled = false;
    btnRefresh.textContent = '刷新关注列表';
  }

  function renderDiag() {
    if (!elDiag) return;
    if (!diag) { elDiag.textContent = '页面状态：等待 B 站首页响应…'; return; }
    var bits = ['页面脚本 v' + diag.version];
    var modeName = { split: '上下分区', replace: '关注流', filter: '仅过滤' }[diag.mode] || diag.mode;
    bits.push('模式 ' + modeName);
    if (diag.mode === 'split') {
      bits.push('两块同时显示（特别关注 ' + diag.specialCount + ' 位）');
    } else if (diag.specialOnly) {
      if (diag.specialUnavailable) bits.push('⚠ 特别关注读取失败：' + (diag.specialReason || '未知'));
      else if (diag.specialEmpty) bits.push('★ 账号未设置特别关注');
      else bits.push('★ 命中 ' + diag.specialCount + ' 位特别关注');
      if (diag.specialSource) bits.push('来源 ' + diag.specialSource);
    } else {
      bits.push('范围：全部关注（' + diag.followCount + ' 位）');
    }
    elDiag.textContent = bits.join(' · ');
  }

  function showFix(text) {
    if (!elFixBar) return;
    elFixBar.hidden = false;
    elFixText.textContent = text;
  }

  function hideFix() {
    if (elFixBar) elFixBar.hidden = true;
  }

  /* 版本握手：popup 每次打开都现读磁盘，但页面里的内容脚本可能是旧版，
   * 这正是「开关出现了、过滤没生效」的典型原因。检测出来就给一键修复。 */
  function probeContentScript() {
    chrome.tabs.query({ url: BILI_URLS }, function (tabs) {
      var t = (tabs || [])[0];
      if (!t) {
        diag = null;
        renderDiag();
        if (elDiag) elDiag.textContent = '页面状态：未打开 B 站首页（打开后自动生效）';
        hideFix();
        return;
      }
      var attempt = 0;
      function ping() {
        chrome.tabs.sendMessage(t.id, { type: 'bfonly:ping' }, function (r) {
          void chrome.runtime.lastError;
          if ((!r || !r.version) && attempt++ < 2) { setTimeout(ping, 1200); return; }
          if (!r || !r.version) {
            showFix('页面里的脚本没有响应，可能还没刷新过 B 站首页');
            return;
          }
          if (r.version !== EXT_VER) {
            showFix('页面脚本是 v' + r.version + '，扩展是 v' + EXT_VER + '，需要重载扩展才能生效');
            return;
          }
          hideFix();
          diag = r;
          renderDiag();
        });
      }
      ping();
    });
  }

  function load() {
    chrome.storage.local.get([CFG_KEY, FOLLOW_KEY], function (r) {
      cfg = Object.assign({}, DEFAULTS, (r && r[CFG_KEY]) || {});
      follow = (r && r[FOLLOW_KEY]) || null;
      render();
      probeContentScript();
    });
  }

  function saveCfg() {
    var o = {};
    o[CFG_KEY] = cfg;
    chrome.storage.local.set(o);
  }

  // 先确保有默认配置，避免首次安装后内容脚本读不到
  chrome.storage.local.get([CFG_KEY], function (r) {
    if (!r || !r[CFG_KEY]) {
      var o = {};
      o[CFG_KEY] = cfg;
      chrome.storage.local.set(o, load);
    } else {
      load();
    }
  });

  elEnabled.addEventListener('change', function () {
    cfg.enabled = elEnabled.checked;
    saveCfg();
    render();
    reloadBiliTabs(true);
  });

  elSpecial.addEventListener('change', function () {
    if (cfg.mode === 'split') { render(); return; }
    cfg.specialOnly = elSpecial.checked;
    saveCfg();
    render();
    // 不指望 storage.onChanged：直接刷新 B 站标签页，让新范围立刻生效
    reloadBiliTabs(true);
  });

  elSeg.addEventListener('click', function (e) {
    var btn = e.target.closest('.seg-btn');
    if (!btn || btn.disabled) return;
    cfg.mode = btn.dataset.mode;
    saveCfg();
    render();
    reloadBiliTabs(true);
  });

  if (elFixBtn) {
    elFixBtn.addEventListener('click', function () {
      elFixBtn.disabled = true;
      elFixBtn.textContent = '修复中…';
      chrome.runtime.sendMessage({ type: 'bfonly:reloadExt' }, function () {
        void chrome.runtime.lastError;
        window.close();
      });
    });
  }

  btnRefresh.addEventListener('click', function () {
    btnRefresh.disabled = true;
    btnRefresh.textContent = '同步中…';
    var o = {};
    o[FOLLOW_KEY] = null;
    chrome.storage.local.set(o, function () {
      follow = null;
      render();
      reloadBiliTabs(true);
      setTimeout(load, 1200);
    });
  });

  btnOpen.addEventListener('click', function () {
    chrome.tabs.create({ url: 'https://www.bilibili.com/' });
  });

  // hard：直接刷新标签页。页面重新注入内容脚本（磁盘上的最新版）并读回新配置，
  // 不依赖旧脚本是否还活着，也不依赖 storage.onChanged 是否投递成功。
  function reloadBiliTabs(hard) {
    chrome.tabs.query({ url: BILI_URLS }, function (tabs) {
      void chrome.runtime.lastError;
      (tabs || []).forEach(function (t) {
        try {
          if (hard) {
            chrome.tabs.reload(t.id);
          } else {
            chrome.tabs.sendMessage(t.id, { type: 'bfonly:refresh', hard: false }, function () {
              void chrome.runtime.lastError;
            });
          }
        } catch (e) { /* 忽略 */ }
      });
    });
  }
})();
