/* Service Worker：默认配置 + API 代理 + 扩展自愈重载 */
'use strict';

var CFG_KEY = 'bfonly_cfg';
var DEFAULTS = { enabled: true, mode: 'split', specialOnly: false };

chrome.runtime.onInstalled.addListener(function (detail) {
  chrome.storage.local.get([CFG_KEY], function (r) {
    var cur = (r && r[CFG_KEY]) || null;
    if (!cur) {
      var o = {};
      o[CFG_KEY] = DEFAULTS;
      chrome.storage.local.set(o);
      return;
    }
    // 1.2.0 升级：老用户从「关注流」平滑迁到「上下分区」，且两块默认都展开。
    // 只做一次；用户之后手动切回任何模式都不会再被改。
    if (detail && detail.reason === 'update' && !cur.splitMigrated) {
      cur.splitMigrated = true;
      if (cur.mode === 'replace') cur.mode = 'split';
      if (cur.mode === 'split') cur.specialOnly = false;
      var u = {};
      u[CFG_KEY] = cur;
      chrome.storage.local.set(u);
    }
  });
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;

  /* 页面直连被 CORS / 风控拦掉时，由 Service Worker 代发。
   * 扩展已在 manifest 里声明 host_permissions，SW 的 fetch 不受页面同源策略约束。 */
  if (msg.type === 'bfonly:fetch') {
    var url = String(msg.url || '');
    var allowed = /^https:\/\/(api|www)\.bilibili\.com\//.test(url) ||
                  /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
    if (!allowed) { sendResponse({ ok: false, error: 'blocked url' }); return; }
    fetch(url, {
      method: 'GET',
      credentials: 'include',
      referrer: 'https://www.bilibili.com/',
      headers: { Accept: 'application/json, text/plain, */*' }
    }).then(function (r) { return r.json(); })
      .then(function (j) { sendResponse({ ok: true, json: j }); })
      .catch(function (e) { sendResponse({ ok: false, error: String(e) }); });
    return true;  // 异步 sendResponse
  }

  /* popup 检测到页面里的内容脚本是旧版时调用：
   * 先 reload 扩展（让内容脚本换成磁盘上的新代码），再刷新已打开的 B 站标签页。 */
  if (msg.type === 'bfonly:reloadExt') {
    chrome.tabs.query({ url: ['https://www.bilibili.com/*', 'https://bilibili.com/*'] }, function (tabs) {
      (tabs || []).forEach(function (t) { try { chrome.tabs.reload(t.id); } catch (e) {} });
      setTimeout(function () { try { chrome.runtime.reload(); } catch (e) {} }, 300);
    });
    sendResponse({ ok: true });
    return true;
  }
});
