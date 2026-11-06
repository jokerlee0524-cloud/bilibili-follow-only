/* B站 · 只看关注 —— 内容脚本
 *
 * 两种工作方式：
 *   replace（默认）：隐藏首页原生推荐流，在顶部注入「只看关注」视频流
 *   filter        ：保留原生首页，只把非关注 UP 主的卡片藏起来
 *
 * 数据来源：
 *   /x/relation/followings                   → 我的关注列表（每项带 special / tag[-10] 特别关注标记）
 *   /x/relation/tags + /x/relation/tag      → 特别关注成员（字段缺失时的兜底通道）
 *   /x/polymer/web-dynamic/v1/feed/all?type=video → 关注 UP 的动态视频（真正的「只关注」流）
 *
 * 范围开关 specialOnly：关 = 全部关注（默认）；开 = 只保留特别关注的 UP 主。
 * 两种模式（replace / filter）共用同一个「活跃集合」。
 */
(function () {
  'use strict';

  var IS_BILI = /(^|\.)bilibili\.com$/.test(location.hostname);
  var IS_HOME = IS_BILI && (location.pathname === '/' || location.pathname === '/index.html');
  var IS_DEV = /^(127\.0\.0\.1|localhost)$/.test(location.hostname) && /[?&]dev=1/.test(location.search);
  if (!IS_HOME && !IS_DEV) return;

  var FEED_VERSION = '1.1.1';          // 与 manifest.json 保持一致，供 popup 做版本握手
  var CFG_KEY = 'bfonly_cfg';
  var FOLLOW_KEY = 'bfonly_following';
  var CACHE_TTL = 12 * 60 * 60 * 1000;  // 关注列表缓存 12 小时
  var SPECIAL_TTL = 30 * 60 * 1000;     // 特别关注集合缓存 30 分钟（比关注列表短，换特别关注后能较快同步）
  var FILL_BATCH = 24;                  // 每批渲染多少张卡

  var DEFAULT_CFG = { enabled: true, mode: 'replace', specialOnly: false };

  var cfg = Object.assign({}, DEFAULT_CFG);
  var following = null;   // { ts, mid, total, list, set, special }
  var feed = { raw: [], items: [], offset: '', hasMore: true, loading: false };
  var status = 'loading'; // loading | ready | notlogin | error | disabled
  var statusText = '';
  var panel = null;
  var gridEl = null;
  var metaEl = null;
  var footEl = null;
  var hiddenCount = 0;
  var specialUnavailable = false;  // 开了特别关注但接口失败 → 降级按全部关注显示
  var specialEmpty = false;        // 接口成功、但这个账号确实没设任何特别关注
  var specialReason = '';          // 失败原因（分组接口返回码 / 异常），直接展示给用户
  var filterObserver = null;
  var reinsertObserver = null;
  var started = false;

  document.documentElement.setAttribute('data-bfonly-ver', FEED_VERSION);

  /* ---------------- 工具 ---------------- */

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmtPlay(n) {
    if (n === '' || n == null) return '';
    var v = Number(n);
    if (!isFinite(v)) return String(n);
    if (v >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
    if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    return String(v);
  }

  function storageGet(keys) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(keys, function (r) { resolve(r || {}); });
      } catch (e) { resolve({}); }
    });
  }

  function storageSet(obj) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.set(obj, function () { resolve(); });
      } catch (e) { resolve(); }
    });
  }

  function waitFor(fn, timeout) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function loop() {
        var v = null;
        try { v = fn(); } catch (e) { v = null; }
        if (v) return resolve(v);
        if (Date.now() - t0 > (timeout || 12000)) return resolve(null);
        setTimeout(loop, 250);
      })();
    });
  }

  /* ---------------- 配置 ---------------- */

  async function loadCfg() {
    var r = await storageGet(CFG_KEY);
    cfg = Object.assign({}, DEFAULT_CFG, r[CFG_KEY] || {});
    if (IS_DEV) {
      // 本地夹具用：?dev=1&mode=filter / ?dev=1&off=1 / ?dev=1&special=1 / ?dev=1&nospecial=1
      var q = new URLSearchParams(location.search);
      if (q.get('mode')) cfg.mode = q.get('mode');
      if (q.get('off') === '1') cfg.enabled = false;
      if (q.get('special') === '1') cfg.specialOnly = true;
      if (q.get('special') === '0') cfg.specialOnly = false;
    }
  }

  async function saveCfg() {
    var o = {};
    o[CFG_KEY] = cfg;
    await storageSet(o);
  }

  /* ---------------- 关注列表 ---------------- */

  /* 旧版（1.0.x / 1.1.0）缓存没有解析过特别关注集合，不能拿来当「已解析」用。
   * 只认新字段 specialResolved，避免「list 里带 special:0 就算有信息」这种假阳性。 */
  function specialCacheValid(data) {
    return !!(data && data.specialResolved &&
      typeof data.specialTs === 'number' &&
      Date.now() - data.specialTs < SPECIAL_TTL);
  }

  function forceNoSpecial() {
    return IS_DEV && /[?&]nospecial=1/.test(location.search);
  }

  /* 关注列表 + 特别关注集合。
   * 开了特别关注却命中旧缓存时，必须重新解析分组接口——这正是 1.1.0 实测失效的根因。 */
  async function loadFollowing(nav) {
    var cached = (await storageGet(FOLLOW_KEY))[FOLLOW_KEY];
    var fresh = cached && cached.list && cached.list.length &&
      cached.mid === nav.mid && Date.now() - cached.ts < CACHE_TTL;
    var needSpecial = cfg.specialOnly && !specialCacheValid(cached);

    if (fresh && !needSpecial) return decorate(cached);

    var data;
    if (fresh) {
      data = cached;   // 关注列表还新鲜，只补特别关注集合
    } else {
      var res = await globalThis.bfApi.getFollowing(nav.mid, function (got, total) {
        setMeta('正在读取关注列表 ' + got + (total ? ' / ' + total : '') + ' 位…');
      });
      data = { ts: Date.now(), mid: nav.mid, total: res.total || res.list.length,
               list: res.list, specialSeen: !!res.specialSeen };
    }

    if (cfg.specialOnly) {
      setMeta('正在读取「特别关注」分组…');
      if (forceNoSpecial()) {
        // DEV：模拟分组接口整体失败
        data.specialMids = [];
        data.specialOk = false;
        data.specialSource = '';
        data.specialDetail = 'DEV 模拟：分组接口不可用';
      } else {
        try {
          var sp = await globalThis.bfApi.getSpecialFollowings();
          data.specialMids = sp.mids || [];
          data.specialOk = sp.ok !== false;
          data.specialSource = sp.source || '';
          data.specialDetail = sp.detail || '';
          // 关系列表里的 special / tag 也算一份证据，取并集
          if (!sp.ok && data.list) {
            var fallback = data.list.filter(function (u) {
              var tagged = Array.isArray(u.tag) && u.tag.some(function (t) { return Number(t) === -10; });
              return u.special === 1 || u.special === true || tagged;
            }).map(function (u) { return String(u.mid); });
            if (fallback.length) {
              data.specialMids = fallback;
              data.specialOk = true;
              data.specialSource = 'relations';
              data.specialDetail = '分组接口不可用，改用关注列表里的特别关注标记';
            }
          }
        } catch (e) {
          data.specialMids = [];
          data.specialOk = false;
          data.specialSource = '';
          data.specialDetail = '分组接口异常：' + (e && e.message ? e.message : e);
        }
      }
      data.specialResolved = true;
      data.specialTs = Date.now();
    }

    var o = {};
    o[FOLLOW_KEY] = data;
    await storageSet(o);
    return decorate(data);
  }

  function decorate(data) {
    var set = new Set();
    var special = new Set();
    (data.list || []).forEach(function (u) {
      var mid = String(u.mid);
      set.add(mid);
      var tagged = Array.isArray(u.tag) && u.tag.some(function (t) { return Number(t) === -10; });
      if (u.special === 1 || u.special === true || tagged) special.add(mid);
    });
    // DEV：模拟 B 站不再返回 special 字段（只认分组接口结果）
    if (IS_DEV && /[?&]nofield=1/.test(location.search)) special = new Set();
    if (Array.isArray(data.specialMids)) {
      data.specialMids.forEach(function (m) { special.add(String(m)); });
    }
    if (forceNoSpecial()) special = new Set();
    return {
      ts: data.ts, mid: data.mid, total: (data.list || []).length,
      list: data.list || [], set: set, special: special,
      specialResolved: !!data.specialResolved,
      specialOk: data.specialOk !== false,
      specialSource: data.specialSource || '',
      specialDetail: data.specialDetail || ''
    };
  }

  /* 当前生效的 UP 主集合：特别关注开关 + 读不到时的降级 */
  function activeSet() {
    if (following && cfg.specialOnly && !specialUnavailable && following.special.size) {
      return following.special;
    }
    return following ? following.set : null;
  }

  async function refreshFollowing() {
    var o = {};
    o[FOLLOW_KEY] = null;
    await storageSet(o);
    following = null;
    await boot(true);
  }

  /* ---------------- 面板 ---------------- */

  /* 找到「推荐流」所在的挂载点，把面板插在它前面。
   * 新版首页： #app > .bili-feed4 > main.bili-feed4-layout > .feed2
   * 旧版首页： #i_cecream > .bili-feed4 > .container
   */
  function mountPoint() {
    var main = document.querySelector('#app main.bili-feed4-layout');
    if (main) return { parent: main, before: main.querySelector('.feed2') };
    var legacy = document.querySelector('#i_cecream .bili-feed4 .container');
    if (legacy) return { parent: legacy, before: legacy.firstElementChild };
    var ice = document.querySelector('#i_cecream');
    if (ice) return { parent: ice, before: ice.firstElementChild };
    var app = document.getElementById('app');
    if (app) return { parent: app, before: app.firstElementChild };
    return null;
  }

  function insertPanel() {
    if (!panel) return;
    var m = mountPoint();
    if (!m) {
      if (!panel.parentNode) document.body.appendChild(panel);
      return;
    }
    if (panel.parentNode === m.parent) return;
    if (m.before && m.before.parentNode === m.parent) {
      m.parent.insertBefore(panel, m.before);
    } else {
      m.parent.insertBefore(panel, m.parent.firstElementChild);
    }
  }

  function buildPanel() {
    if (panel && document.body.contains(panel)) return panel;

    panel = h('div', 'bfonly-panel');
    panel.id = 'bfonly-panel';

    var head = h('div', 'bfonly-head');
    var left = h('div', 'bfonly-head-left');
    var title = h('div', 'bfonly-title');
    title.appendChild(h('span', 'bfonly-logo'));
    title.appendChild(h('span', 'bfonly-title-text', '只看关注'));
    title.appendChild(h('span', 'bfonly-beta', 'ONLY FOLLOWING'));
    left.appendChild(title);

    metaEl = h('div', 'bfonly-sub', '正在读取你的关注列表…');
    left.appendChild(metaEl);

    var right = h('div', 'bfonly-head-right');
    var btnRefresh = h('button', 'bfonly-btn', '刷新');
    btnRefresh.type = 'button';
    btnRefresh.addEventListener('click', function () {
      btnRefresh.disabled = true;
      btnRefresh.textContent = '刷新中…';
      refreshFollowing();
    });
    var btnMode = h('button', 'bfonly-btn ghost', '切到过滤模式');
    btnMode.type = 'button';
    btnMode.addEventListener('click', async function () {
      cfg.mode = cfg.mode === 'replace' ? 'filter' : 'replace';
      await saveCfg();
      teardown();
      await boot(true);
    });
    var btnSpecial = h('button', 'bfonly-btn ghost bfonly-scope-btn', '☆ 特别关注');
    btnSpecial.type = 'button';
    btnSpecial.addEventListener('click', async function () {
      cfg.specialOnly = !cfg.specialOnly;
      await saveCfg();
      teardown();
      await boot(true);
    });
    right.appendChild(btnMode);
    right.appendChild(btnSpecial);
    right.appendChild(btnRefresh);

    head.appendChild(left);
    head.appendChild(right);
    panel.appendChild(head);

    gridEl = h('div', 'bfonly-grid');
    panel.appendChild(gridEl);

    footEl = h('div', 'bfonly-foot');
    panel.appendChild(footEl);

    insertPanel();
    syncScopeBtn();
    return panel;
  }

  function scopedNow() {
    return !!(cfg.specialOnly && !specialUnavailable && !specialEmpty &&
      following && following.special && following.special.size);
  }

  function syncScopeBtn() {
    var b = document.querySelector('#bfonly-panel .bfonly-scope-btn');
    var t = document.querySelector('#bfonly-panel .bfonly-title-text');
    var beta = document.querySelector('#bfonly-panel .bfonly-beta');
    if (t) t.textContent = scopedNow() ? '★ 只看特别关注' : '只看关注';
    if (beta) beta.textContent = scopedNow() ? 'SPECIAL ONLY' : 'ONLY FOLLOWING';
    if (!b) return;
    b.classList.toggle('active', !!cfg.specialOnly);
    b.textContent = cfg.specialOnly ? '★ 特别关注' : '☆ 特别关注';
    b.title = cfg.specialOnly
      ? '当前只看特别关注，点击切回全部关注'
      : '点击只显示设为特别关注的 UP 主';
  }

  function setMeta(text) {
    if (metaEl) metaEl.textContent = text;
  }

  /* 副标题统一口径：范围 / 数量 / 失败原因，一眼能看出开关到底有没有生效 */
  function scopeMeta() {
    if (!cfg.specialOnly) {
      return '已关注 ' + (following ? following.total : 0) + ' 位 UP 主 · 只显示他们的视频';
    }
    if (specialUnavailable) {
      return '⚠ 特别关注读取失败，暂时按全部关注显示 · ' + (specialReason || '点「刷新」重试');
    }
    if (specialEmpty) {
      return '★ 你还没有设置特别关注 · 暂时按全部关注显示';
    }
    return '★ 只看特别关注 · 命中 ' + following.special.size +
      ' 位 UP 主（共关注 ' + following.total + ' 位）';
  }

  function emptyText() {
    if (specialUnavailable) return '特别关注列表读取失败，暂时显示关注流；点「刷新」重试。';
    if (specialEmpty) return '你还没有把任何 UP 主设为特别关注，先去 B 站设置一下吧。';
    return cfg.specialOnly
      ? '特别关注的 UP 主最近没有发视频，过段时间再来看看。'
      : '关注列表里的 UP 主最近没有发视频，过段时间再来看看。';
  }

  function clearGrid() {
    if (gridEl) gridEl.textContent = '';
  }

  function renderState(kind, text, ctaLabel, ctaHref) {
    clearGrid();
    var box = h('div', 'bfonly-state');
    box.appendChild(h('div', 'bfonly-state-icon', kind === 'notlogin' ? '🔒' : kind === 'error' ? '⚠️' : '⏳'));
    box.appendChild(h('div', 'bfonly-state-text', text));
    if (ctaLabel && ctaHref) {
      var a = h('a', 'bfonly-cta', ctaLabel);
      a.href = ctaHref;
      box.appendChild(a);
    }
    gridEl.appendChild(box);
    if (footEl) footEl.textContent = '';
  }

  function makeCard(it) {
    var a = h('a', 'bfonly-card');
    a.href = 'https://www.bilibili.com/video/' + it.bvid;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';

    var cover = h('div', 'bfonly-cover');
    if (it.cover) {
      var img = h('img');
      img.src = it.cover;
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.alt = it.title;
      cover.appendChild(img);
    } else {
      cover.classList.add('empty');
    }
    if (it.dur) cover.appendChild(h('span', 'bfonly-dur', it.dur));
    a.appendChild(cover);

    var info = h('div', 'bfonly-info');
    info.appendChild(h('div', 'bfonly-card-title', it.title));

    var meta = h('div', 'bfonly-card-meta');
    if (it.face) {
      var face = h('img', 'bfonly-face');
      face.src = it.face;
      face.loading = 'lazy';
      face.referrerPolicy = 'no-referrer';
      face.alt = it.up;
      meta.appendChild(face);
    }
    var up = h('span', 'bfonly-up', it.up || '未知 UP 主');
    up.title = it.up || '';
    meta.appendChild(up);
    if (it.pub) meta.appendChild(h('span', 'bfonly-dot', '·'));
    if (it.pub) meta.appendChild(h('span', 'bfonly-pub', it.pub));
    info.appendChild(meta);

    if (it.play !== '') {
      var pl = h('div', 'bfonly-play');
      pl.textContent = '▶ ' + fmtPlay(it.play) + ' 播放';
      info.appendChild(pl);
    }

    a.appendChild(info);
    return a;
  }

  function renderFeed() {
    if (!gridEl) return;
    gridEl.textContent = '';
    if (!feed.items.length) {
      renderState('empty', emptyText());
      return;
    }
    feed.items.forEach(function (it) { gridEl.appendChild(makeCard(it)); });
    updateFoot();
  }

  function updateFoot() {
    if (!footEl) return;
    footEl.textContent = '';
    if (feed.loading) {
      footEl.appendChild(h('span', 'bfonly-hint', '加载中…'));
      return;
    }
    if (feed.hasMore) {
      var btn = h('button', 'bfonly-btn more', '加载更多');
      btn.type = 'button';
      btn.addEventListener('click', function () { loadFeed(true); });
      footEl.appendChild(btn);
    } else if (feed.items.length) {
      footEl.appendChild(h('span', 'bfonly-hint',
        specialUnavailable ? '没有更多了 · 按全部关注显示'
          : specialEmpty ? '没有更多了 · 你还没设置特别关注'
          : scopedNow() ? '没有更多了 · 只显示特别关注的 UP 主'
                        : '没有更多了 · 只显示你关注的 UP 主'));
    }
    if (specialUnavailable) {
      footEl.appendChild(h('span', 'bfonly-hint warn',
        '⚠ 特别关注读取失败，暂时按全部关注显示 · ' + (specialReason || '点「刷新」重试')));
      var retry = h('button', 'bfonly-btn ghost', '重试');
      retry.type = 'button';
      retry.addEventListener('click', function () { refreshFollowing(); });
      footEl.appendChild(retry);
    } else if (specialEmpty) {
      footEl.appendChild(h('span', 'bfonly-hint warn',
        '★ 到 B 站「关注」页把 UP 主设为特别关注后，点「刷新」即可生效'));
    }
  }

  /* ---------------- 拉取关注流 ---------------- */

  /* 按当前范围过滤已拉到的动态；降级时退回全部关注 */
  function visibleItems() {
    if (!cfg.specialOnly || specialUnavailable ||
        !following || !following.special || !following.special.size) {
      return feed.raw.slice();
    }
    return feed.raw.filter(function (x) { return following.special.has(String(x.mid)); });
  }

  async function fetchPage() {
    var res = await globalThis.bfApi.getFollowFeed(feed.offset);
    var known = new Set(feed.raw.map(function (x) { return x.bvid; }));
    res.items.forEach(function (x) {
      if (!known.has(x.bvid)) { feed.raw.push(x); known.add(x.bvid); }
    });
    feed.offset = res.offset || '';
    feed.hasMore = !!res.hasMore && !!res.offset;
    return res.rawCount || 0;
  }

  async function loadFeed(more) {
    if (feed.loading) return;
    feed.loading = true;
    updateFoot();
    var rawSeen = 0;
    try {
      var pages = more ? 1 : 2;
      for (var i = 0; i < pages; i++) {
        if (!feed.hasMore) break;
        rawSeen += await fetchPage();
      }

      /* 特别关注的视频往往很稀疏：继续往下翻，直到凑够卡片或到底。
       * 上限 6 页，避免为了 1 个冷门 UP 主把整条动态流翻完。 */
      var scoped = cfg.specialOnly && !specialUnavailable &&
        following && following.special && following.special.size;
      if (scoped) {
        var target = more ? visibleItems().length + 1 : 8;
        var guard = more ? 4 : 6;
        while (feed.hasMore && visibleItems().length < target && guard-- > 0) {
          rawSeen += await fetchPage();
        }
      }

      feed.items = visibleItems();
      status = 'ready';
      if (!feed.items.length && rawSeen > 0 && !cfg.specialOnly) {
        throw new Error('返回 ' + rawSeen + ' 条动态但解析不到视频，B 站可能改版了');
      }
      if (!feed.items.length) {
        renderState('empty', emptyText());
      } else {
        renderFeed();
      }
    } catch (e) {
      feed.items = [];
      status = 'error';
      if (e && e.apiCode === -101) {
        renderState('notlogin', '登录状态失效了，请重新登录 B 站。', '去登录', 'https://passport.bilibili.com/login');
      } else {
        renderState('error', '关注流接口调用失败（' + (e && e.message ? e.message : e) + '），已自动切到「过滤模式」。');
        cfg.mode = 'filter';
        await saveCfg();
        teardown();
        started = false;
        await boot(true);
      }
    } finally {
      feed.loading = false;
      updateFoot();
    }
  }

  /* ---------------- 过滤模式 ---------------- */

  var CARD_SEL = [
    '.bili-video-card',
    '.feed-card',
    '.floor-single-card',
    '.bilibili-video-card',
    '.video-card'
  ].join(',');

  function cardMid(card) {
    var a = card.querySelector('a[href*="space.bilibili.com/"]');
    if (a) {
      var m = (a.getAttribute('href') || '').match(/space\.bilibili\.com\/(\d+)/);
      if (m) return m[1];
    }
    var any = card.querySelector('[data-mid]');
    if (any) return any.getAttribute('data-mid');
    return null;
  }

  function applyFilter() {
    var cards = document.querySelectorAll('#app ' + CARD_SEL + ', #i_cecream ' + CARD_SEL + ', #reco_list ' + CARD_SEL);
    var active = activeSet();
    var scoped = scopedNow();
    var hidden = 0;
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if (card.closest('#bfonly-panel')) continue;
      var mid = cardMid(card);
      var keep = mid && active && active.has(mid);
      if (keep) {
        if (card.dataset.bfonlyHidden === '1') {
          card.style.removeProperty('display');
          delete card.dataset.bfonlyHidden;
        }
      } else {
        if (card.dataset.bfonlyHidden !== '1') {
          card.style.setProperty('display', 'none', 'important');
          card.dataset.bfonlyHidden = '1';
          hidden++;
        }
      }
    }
    hiddenCount = document.querySelectorAll('[data-bfonly-hidden="1"]').length;

    var chip = document.getElementById('bfonly-chip');
    if (!chip) {
      chip = h('div', 'bfonly-chip');
      chip.id = 'bfonly-chip';
      var txt = h('span', 'bfonly-chip-text', '');
      chip.appendChild(txt);
      var sw = h('button', 'bfonly-chip-btn bfonly-chip-scope', '');
      sw.type = 'button';
      sw.addEventListener('click', async function () {
        cfg.specialOnly = !cfg.specialOnly;
        await saveCfg();
        teardown();
        started = false;
        await boot(true);
      });
      chip.appendChild(sw);
      var off = h('button', 'bfonly-chip-btn', '关闭');
      off.type = 'button';
      off.addEventListener('click', async function () {
        cfg.enabled = false;
        await saveCfg();
        teardown();
      });
      chip.appendChild(off);
      document.body.appendChild(chip);
    }
    var scopeBtn = chip.querySelector('.bfonly-chip-scope');
    if (scopeBtn) scopeBtn.textContent = scoped ? '看全部关注' : '只看特别关注';
    chip.querySelector('.bfonly-chip-text').textContent =
      (specialUnavailable ? '⚠ 特别关注读取失败 · 按全部关注'
        : specialEmpty ? '★ 你还没设置特别关注 · 按全部关注'
        : scoped ? '★ 只看特别关注（' + following.special.size + ' 位）' : '只看关注') +
      ' · 已隐藏 ' + hiddenCount + ' 条' + (scoped ? '非特别关注' : '非关注') + '内容' +
      (specialUnavailable && specialReason ? ' · ' + specialReason : '');
  }

  function startFilter() {
    applyFilter();
    filterObserver = new MutationObserver(function () {
      if (filterObserver._t) return;
      filterObserver._t = setTimeout(function () {
        filterObserver._t = null;
        applyFilter();
      }, 250);
    });
    filterObserver.observe(document.body, { childList: true, subtree: true });
  }

  /* ---------------- 组装 / 拆卸 ---------------- */

  function teardown() {
    document.documentElement.classList.remove('bfonly-replace');
    if (filterObserver) { filterObserver.disconnect(); filterObserver = null; }
    if (reinsertObserver) { reinsertObserver.disconnect(); reinsertObserver = null; }
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null; gridEl = null; metaEl = null; footEl = null;
    var chip = document.getElementById('bfonly-chip');
    if (chip && chip.parentNode) chip.parentNode.removeChild(chip);
    var hiddenEls = document.querySelectorAll('[data-bfonly-hidden="1"]');
    for (var i = 0; i < hiddenEls.length; i++) {
      hiddenEls[i].style.removeProperty('display');
      delete hiddenEls[i].dataset.bfonlyHidden;
    }
  }

  function keepPanelAlive() {
    if (reinsertObserver) reinsertObserver.disconnect();
    reinsertObserver = new MutationObserver(function () {
      if (!panel) return;
      if (!document.body.contains(panel)) insertPanel();
    });
    reinsertObserver.observe(document.body, { childList: true, subtree: true });
  }

  /* 切换模式 / 范围时重建，别让上一次的游标和卡片残留 */
  function resetFeed() {
    feed.raw = [];
    feed.items = [];
    feed.offset = '';
    feed.hasMore = true;
    feed.loading = false;
  }

  async function boot(force) {
    if (!force && started) return;
    started = true;
    await loadCfg();
    specialUnavailable = false;
    specialEmpty = false;
    specialReason = '';
    resetFeed();

    if (!cfg.enabled) {
      status = 'disabled';
      return;
    }

    await waitFor(function () { return mountPoint(); }, 12000);

    if (cfg.mode === 'filter') {
      buildFilterOnly();
      return;
    }

    buildPanel();
    renderState('loading', '正在读取你的关注列表…');

    var nav;
    try {
      nav = await globalThis.bfApi.getNav();
    } catch (e) {
      renderState('error', '无法连接 B 站接口，请确认网络后刷新页面。');
      return;
    }

    if (!nav.isLogin) {
      status = 'notlogin';
      setMeta('未登录 · 无法读取关注列表');
      renderState('notlogin', '登录 B 站后，这里就只剩你关注的 UP 主了。', '去登录',
        'https://passport.bilibili.com/login?gourl=' + encodeURIComponent('https://www.bilibili.com/'));
      return;
    }

    try {
      following = await loadFollowing(nav);
    } catch (e) {
      renderState('error', '读取关注列表失败（' + (e && e.message ? e.message : e) + '）。');
      return;
    }

    applySpecialState();
    setMeta(scopeMeta());
    syncScopeBtn();
    document.documentElement.classList.add('bfonly-replace');
    await loadFeed(false);
    keepPanelAlive();
  }

  function buildFilterOnly() {
    // 过滤模式：不注入面板，只让原生首页只留关注内容
    setMeta('过滤模式');
    (async function () {
      try {
        var nav = await globalThis.bfApi.getNav();
        if (!nav.isLogin) {
          var chip0 = h('div', 'bfonly-chip warn');
          chip0.id = 'bfonly-chip';
          chip0.appendChild(h('span', 'bfonly-chip-text', '只看关注 · 请先登录 B 站'));
          document.body.appendChild(chip0);
          return;
        }
        following = await loadFollowing(nav);
        applySpecialState();
        startFilter();
      } catch (e) {
        var chip = h('div', 'bfonly-chip warn');
        chip.id = 'bfonly-chip';
        chip.appendChild(h('span', 'bfonly-chip-text', '只看关注 · 初始化失败，请刷新页面'));
        document.body.appendChild(chip);
      }
    })();
  }

  /* 三种降级状态的统一判定 */
  function applySpecialState() {
    specialUnavailable = false;
    specialEmpty = false;
    specialReason = '';
    if (!cfg.specialOnly || !following) return;
    if (following.special.size) return;              // 命中，正常工作
    if (following.specialOk === false) {
      specialUnavailable = true;
      specialReason = following.specialDetail || '分组接口未返回';
    } else {
      specialEmpty = true;                          // 接口成功，但账号确实没设特别关注
    }
  }

  /* ---------------- 启动 & 监听 ---------------- */

  boot(false);

  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg) return;
      if (msg.type === 'bfonly:ping') {
        // popup 用它判断页面里的内容脚本是不是最新版，避免「开关有了、脚本没换」
        sendResponse({
          version: FEED_VERSION,
          enabled: !!cfg.enabled,
          mode: cfg.mode,
          specialOnly: !!cfg.specialOnly,
          followCount: following ? following.total : 0,
          specialCount: following ? following.special.size : 0,
          specialResolved: following ? !!following.specialResolved : false,
          specialSource: following ? following.specialSource : '',
          specialDetail: following ? following.specialDetail : '',
          specialUnavailable: specialUnavailable,
          specialEmpty: specialEmpty,
          specialReason: specialReason,
          status: status
        });
        return;
      }
      if (msg.type !== 'bfonly:refresh') return;
      if (msg.hard) { location.reload(); return; }
      teardown();
      started = false;
      boot(true);
    });
  } catch (e) { /* 忽略 */ }

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[CFG_KEY]) return;
      var nv = Object.assign({}, DEFAULT_CFG, changes[CFG_KEY].newValue || DEFAULT_CFG);
      var same = nv.enabled === cfg.enabled && nv.mode === cfg.mode &&
        !!nv.specialOnly === !!cfg.specialOnly;
      cfg = nv;
      if (same) return;
      teardown();
      started = false;
      boot(true);
    });
  } catch (e) { /* 忽略 */ }
})();
