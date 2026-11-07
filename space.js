/* space.js — B 站关注管理页（space.bilibili.com/<uid>/relation/follow）分组自动选中
 *
 * 背景：B 站侧边栏分组本身的链接就是 ?tagid=<id>（全部关注=-1、特别关注=-10、
 * 自定义分组为正整数 id），但 SPA 在「整页直开」时不一定会按 query 选中分组，
 * 实测会回落到「全部关注」。本脚本在页面加载后找到匹配 tagid 的侧边栏项，
 * 若未激活就补点一次，保证直达目标分组。
 *
 * 仅在 URL 带 tagid 参数时工作；找不到对应分组（未登录/看别人空间）时静默放弃。
 */
(function () {
  'use strict';

  var m = location.search.match(/[?&]tagid=(-?\d+)/);
  if (!m) return;
  var want = m[1];

  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    var items = document.querySelectorAll('.vui_sidebar-item, .follow-sidebar-item');

    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      var a = el.tagName === 'A' ? el : el.querySelector('a[href*="tagid="]');
      var href = a ? (a.href || '') : (el.getAttribute('href') || '');
      var mm = href.match(/[?&]tagid=(-?\d+)/);
      if (mm && mm[1] === want) {
        if (!/(^|\s)(active|vui_sidebar-item--active)(\s|$)/.test(el.className)) {
          (a || el).click();
        }
        clearInterval(timer);
        return;
      }
    }

    // 兜底：按文字匹配「特别关注」（侧边栏 href 结构变动时仍能找到）
    if (want === '-10') {
      for (var j = 0; j < items.length; j++) {
        if (/特别关注/.test(items[j].innerText || '')) {
          if (!/(^|\s)(active|vui_sidebar-item--active)(\s|$)/.test(items[j].className)) {
            var aa = items[j].tagName === 'A' ? items[j] : items[j].querySelector('a');
            (aa || items[j]).click();
          }
          clearInterval(timer);
          return;
        }
      }
    }

    if (tries >= 20) clearInterval(timer); // 10 秒未出现目标分组 → 放弃（未登录/无权限）
  }, 500);
})();
