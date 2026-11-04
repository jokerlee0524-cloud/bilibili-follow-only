/* Service Worker：只负责首次安装时写入默认配置 */
'use strict';

var CFG_KEY = 'bfonly_cfg';
var DEFAULTS = { enabled: true, mode: 'replace' };

chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.local.get([CFG_KEY], function (r) {
    if (!r || !r[CFG_KEY]) {
      var o = {};
      o[CFG_KEY] = DEFAULTS;
      chrome.storage.local.set(o);
    }
  });
});
