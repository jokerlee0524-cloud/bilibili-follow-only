/* popup 逻辑：读写配置 + 展示关注缓存状态 */
(function () {
  'use strict';

  var CFG_KEY = 'bfonly_cfg';
  var FOLLOW_KEY = 'bfonly_following';
  var DEFAULTS = { enabled: true, mode: 'replace' };

  var elEnabled = document.getElementById('enabled');
  var elState = document.getElementById('stateText');
  var elCount = document.getElementById('followCount');
  var elCache = document.getElementById('cacheTime');
  var elHint = document.getElementById('hint');
  var elFoot = document.querySelector('.foot');
  var elSeg = document.getElementById('modeSeg');
  var btnRefresh = document.getElementById('refreshBtn');
  var btnOpen = document.getElementById('openBtn');

  var cfg = Object.assign({}, DEFAULTS);
  var follow = null;

  function ago(ts) {
    if (!ts) return '尚未同步';
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return '刚刚同步';
    if (s < 3600) return Math.round(s / 60) + ' 分钟前同步';
    if (s < 86400) return Math.round(s / 3600) + ' 小时前同步';
    return Math.round(s / 86400) + ' 天前同步';
  }

  function render() {
    elEnabled.checked = !!cfg.enabled;

    Array.prototype.forEach.call(elSeg.querySelectorAll('.seg-btn'), function (b) {
      b.classList.toggle('active', b.dataset.mode === cfg.mode);
      b.disabled = !cfg.enabled;
    });

    if (!cfg.enabled) {
      elState.textContent = '已关闭，首页保持 B 站原样';
    } else if (cfg.mode === 'replace') {
      elState.textContent = '首页已替换为「只看关注」视频流';
    } else {
      elState.textContent = '保留原首页，仅隐藏非关注内容';
    }

    elCount.textContent = follow && follow.list && follow.list.length ? follow.list.length : '—';
    elCache.textContent = follow ? ago(follow.ts) : '尚未同步';

    if (follow && follow.list && follow.list.length) {
      elHint.textContent = '数据来自 B 站接口，仅存本地，不上传任何服务器';
      elFoot.classList.remove('warn');
    } else {
      elHint.textContent = '还没有关注数据：请先登录 B 站，再刷新一次';
      elFoot.classList.add('warn');
    }

    btnRefresh.disabled = false;
    btnRefresh.textContent = '刷新关注列表';
  }

  function load() {
    chrome.storage.local.get([CFG_KEY, FOLLOW_KEY], function (r) {
      cfg = Object.assign({}, DEFAULTS, (r && r[CFG_KEY]) || {});
      follow = (r && r[FOLLOW_KEY]) || null;
      render();
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
    reloadBiliTabs();
  });

  elSeg.addEventListener('click', function (e) {
    var btn = e.target.closest('.seg-btn');
    if (!btn || btn.disabled) return;
    cfg.mode = btn.dataset.mode;
    saveCfg();
    render();
    reloadBiliTabs();
  });

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

  // 让已打开的 B 站首页立刻重新加载内容脚本的结果
  function reloadBiliTabs(hard) {
    chrome.tabs.query({ url: ['https://www.bilibili.com/*'] }, function (tabs) {
      void chrome.runtime.lastError;
      (tabs || []).forEach(function (t) {
        try {
          chrome.tabs.sendMessage(t.id, { type: 'bfonly:refresh', hard: !!hard }, function () {
            void chrome.runtime.lastError;
          });
        } catch (e) { /* 忽略 */ }
      });
    });
  }
})();
