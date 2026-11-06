/* B 站接口封装：wbi 签名 + 关注列表 + 特别关注分组 + 关注动态流
 *
 * 运行在 bilibili.com 页面内（内容脚本）。请求走「页面直连 → Service Worker 代理」双通道：
 * 老接口（/x/relation/tags、/x/relation/tag）部分账号没有 CORS 头，页面直连会被浏览器拦掉，
 * 此时由 bg.js 代发（扩展有 host_permissions，不受页面 CORS 约束）。
 *
 * 「特别关注」的权威来源是分组 tagid = -10：
 *   /x/relation/tags          → 确认分组存在（tagid 恒为 -10）
 *   /x/relation/tag?tagid=-10 → 分页取成员 mid
 * /x/relation/followings 里的 special / tag 字段只作为补充证据，不再当作唯一来源。
 */
(function () {
  'use strict';

  var MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
  ];

  var KEY_TTL = 30 * 60 * 1000; // wbi key 30 分钟刷新一次
  var keyCache = { imgKey: '', subKey: '', ts: 0 };

  var DEV = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
  var RISK_CODES = [-403, -352, -509, -412]; // 风控 / 签名不过，值得换通道重试

  /* 关系列表里的「特别关注」标记：
   *   special === 1 / true，或 tag 数组里含 -10（特别关注分组恒为 -10）。
   */
  function isSpecial(u) {
    if (!u) return 0;
    if (u.special === 1 || u.special === true || u.special === '1') return 1;
    if (Array.isArray(u.tag)) {
      for (var i = 0; i < u.tag.length; i++) {
        if (Number(u.tag[i]) === -10) return 1;
      }
    }
    return 0;
  }

  function mixinKey(orig) {
    var out = '';
    for (var i = 0; i < MIXIN_KEY_ENC_TAB.length; i++) out += orig[MIXIN_KEY_ENC_TAB[i]];
    return out.slice(0, 32);
  }

  /* 对「全部」查询参数做 wbi 签名。
   * 注意：所有会随请求发出的参数都必须进 signQuery，否则服务端重算 w_rid 会对不上。 */
  function signQuery(params, imgKey, subKey) {
    var mixin = mixinKey(imgKey + subKey);
    var p = Object.assign({}, params);
    p.wts = Math.round(Date.now() / 1000);
    var query = Object.keys(p)
      .filter(function (k) { return p[k] !== undefined && p[k] !== null && p[k] !== ''; })
      .sort()
      .map(function (k) {
        var v = String(p[k]).replace(/[!'()*]/g, '');
        return encodeURIComponent(k) + '=' + encodeURIComponent(v);
      })
      .join('&');
    return query + '&w_rid=' + globalThis.bfMd5(query + mixin);
  }

  function pickKeys(wbiImg) {
    if (!wbiImg || !wbiImg.img_url || !wbiImg.sub_url) return null;
    var img = wbiImg.img_url.split('/').pop().split('.')[0];
    var sub = wbiImg.sub_url.split('/').pop().split('.')[0];
    if (!img || !sub) return null;
    return { imgKey: img, subKey: sub };
  }

  /* Service Worker 代理：内容脚本直连失败时的第二通道 */
  function proxyFetch(url) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve(null); } }, 8000);
      try {
        chrome.runtime.sendMessage({ type: 'bfonly:fetch', url: url }, function (r) {
          void chrome.runtime.lastError;
          if (done) return;
          done = true; clearTimeout(timer);
          resolve(r && r.ok ? r.json : null);
        });
      } catch (e) {
        if (!done) { done = true; clearTimeout(timer); resolve(null); }
      }
    });
  }

  /* 取 JSON：直连 → 风控/网络失败 → 代理；代理也拿不到就抛最后一次错误 */
  async function rawGet(url) {
    var last = null;
    try {
      var res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json, text/plain, */*' }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var j = await res.json();
      if (j && RISK_CODES.indexOf(j.code) >= 0) {
        last = new Error('API ' + j.code + '（疑似风控）');
      } else {
        return j;
      }
    } catch (e) { last = e; }

    var proxied = await proxyFetch(url);
    if (proxied) return proxied;
    throw last || new Error('请求失败');
  }

  function jget(url) {
    return rawGet(url).then(function (data) {
      if (data && typeof data.code === 'number' && data.code !== 0) {
        var e = new Error('API ' + data.code + ' ' + (data.message || ''));
        e.apiCode = data.code;
        throw e;
      }
      return data;
    });
  }

  /* 原样取 JSON，不校验 code —— nav 未登录返回 -101，属于正常状态 */
  function jgetRaw(url) { return rawGet(url); }

  /* 登录态 + wbi 密钥 */
  async function getNav() {
    var data = DEV ? await jgetRaw(location.origin + '/mock/nav.json')
                   : await jgetRaw('https://api.bilibili.com/x/web-interface/nav');
    var d = (data && data.data) || {};
    var keys = pickKeys(d.wbi_img);
    if (keys) {
      keyCache.imgKey = keys.imgKey;
      keyCache.subKey = keys.subKey;
      keyCache.ts = Date.now();
    }
    return {
      isLogin: !!d.isLogin,
      mid: d.mid ? String(d.mid) : '',
      uname: d.uname || '',
      face: d.face || '',
      code: data && typeof data.code === 'number' ? data.code : 0,
      keys: keys || (keyCache.imgKey ? { imgKey: keyCache.imgKey, subKey: keyCache.subKey } : null)
    };
  }

  async function ensureKeys() {
    if (keyCache.imgKey && Date.now() - keyCache.ts < KEY_TTL) {
      return { imgKey: keyCache.imgKey, subKey: keyCache.subKey };
    }
    var nav = await getNav();
    if (!nav.keys) throw new Error('拿不到 wbi 密钥（可能被风控）');
    return nav.keys;
  }

  /* 关注列表（分页拉全）。tag / special 字段原样保留，供上层判定特别关注。 */
  async function getFollowing(mid, onProgress) {
    if (DEV) {
      var mock = await jget(location.origin + '/mock/followings.json');
      var list = ((mock.data && mock.data.list) || []).map(function (u) {
        return { mid: String(u.mid), uname: u.uname, face: u.face,
                 special: isSpecial(u), tag: Array.isArray(u.tag) ? u.tag : null };
      });
      if (onProgress) onProgress(list.length, list.length);
      return { total: list.length, list: list, specialSeen: list.some(function (u) {
        return typeof u.special !== 'undefined' || Array.isArray(u.tag);
      }) };
    }

    var keys = await ensureKeys();
    var all = [];
    var total = 0;
    var specialSeen = false;
    for (var pn = 1; pn <= 20; pn++) {
      var q = signQuery({ vmid: mid, pn: pn, ps: 50, order_type: 'attention' }, keys.imgKey, keys.subKey);
      var res = await jget('https://api.bilibili.com/x/relation/followings?' + q);
      var d = res.data || {};
      total = d.total || total;
      var batch = (d.list || []).map(function (u) {
        if (typeof u.special !== 'undefined' || Array.isArray(u.tag)) specialSeen = true;
        return { mid: String(u.mid), uname: u.uname, face: u.face,
                 special: isSpecial(u), tag: Array.isArray(u.tag) ? u.tag : null };
      });
      all = all.concat(batch);
      if (onProgress) onProgress(all.length, total);
      if (batch.length < 50 || all.length >= total) break;
    }
    return { total: total, list: all, specialSeen: specialSeen };
  }

  /* 特别关注成员（权威通道）
   *
   * 返回 { mids, source, ok, detail }：
   *   ok     = 接口确实成功返回（哪怕 mids 为空，表示这个账号真的没设特别关注）
   *   source = 'group'（分组接口）/ 'relations'（关系字段）/ 'mock' / ''
   *   detail = 失败原因，直接显示在插件面板里，方便定位
   *
   * 依次尝试：签名版 tags → 无签名 tags → 签名版 tag(-10) → 无签名 tag(-10)。
   * tags 只是用来确认分组，拿不到也照样直试 tagid=-10（B 站恒为 -10）。
   */
  async function getSpecialFollowings() {
    if (DEV) {
      var mock = await jgetRaw(location.origin + '/mock/special.json');
      var arr = (mock && mock.data) || [];
      if (!Array.isArray(arr)) arr = arr.list || [];
      return {
        mids: arr.map(function (u) { return String(u.mid); }).filter(Boolean),
        source: 'mock', ok: true, detail: ''
      };
    }

    var keys = null;
    try { keys = await ensureKeys(); } catch (e) { /* 无密钥时退化为无签名请求 */ }

    var notes = [];
    var tagUrl = 'https://api.bilibili.com/x/relation/tags';

    // 1) 确认特别关注分组（失败不阻断，继续直试 -10）
    try {
      var tagsRes = await jgetRaw(keys
        ? tagUrl + '?' + signQuery({}, keys.imgKey, keys.subKey)
        : tagUrl);
      if (tagsRes && tagsRes.code === 0) {
        var tags = (tagsRes.data) || [];
        if (!Array.isArray(tags)) tags = tags.tags || [];
        notes.push('分组列表 OK(' + tags.length + ')');
      } else {
        notes.push('分组列表 code=' + (tagsRes && tagsRes.code));
        var tagsRes2 = await jgetRaw(tagUrl);
        if (tagsRes2 && tagsRes2.code === 0) notes.push('分组列表(无签名) OK');
        else notes.push('分组列表(无签名) code=' + (tagsRes2 && tagsRes2.code));
      }
    } catch (e) {
      notes.push('分组列表 异常:' + (e && e.message ? e.message : e));
    }

    // 2) 取分组下成员，全参数签名
    var out = [];
    var ok = false;
    var lastCode = null;
    for (var pn = 1; pn <= 10; pn++) {
      var params = { tagid: -10, pn: pn, ps: 50 };
      var signed = keys ? signQuery(params, keys.imgKey, keys.subKey)
                        : 'tagid=-10&pn=' + pn + '&ps=50';
      var candidates = keys
        ? [signed, 'tagid=-10&pn=' + pn + '&ps=50']
        : ['tagid=-10&pn=' + pn + '&ps=50'];

      var res = null;
      for (var c = 0; c < candidates.length; c++) {
        try {
          var r = await jgetRaw('https://api.bilibili.com/x/relation/tag?' + candidates[c]);
          if (r && r.code === 0) { res = r; break; }
          lastCode = r ? r.code : 'null';
        } catch (e2) { lastCode = 'ERR:' + (e2 && e2.message ? e2.message : e2); }
      }
      if (!res || res.code !== 0) break;

      ok = true;
      var page = res.data;
      if (!Array.isArray(page)) page = (page && page.list) || [];
      for (var j = 0; j < page.length; j++) {
        if (page[j] && page[j].mid != null) out.push(String(page[j].mid));
      }
      if (page.length < 50) break;
    }

    if (ok) notes.push('成员接口 OK(' + out.length + ')');
    else notes.push('成员接口 失败 code=' + lastCode);

    return {
      mids: out,
      source: ok ? 'group' : '',
      ok: ok,
      detail: notes.join(' / ')
    };
  }

  /* 关注动态流（只要视频），无限翻页 */
  async function getFollowFeed(offset) {
    if (DEV) {
      var mock = await jget(location.origin + '/mock/dynamic.json');
      return parseFeed(mock.data || {});
    }
    var keys = await ensureKeys();
    var q = signQuery({ type: 'video', page: 1, offset: offset || '', platform: 'web' }, keys.imgKey, keys.subKey);
    var res = await jget('https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?' + q);
    return parseFeed(res.data || {});
  }

  function parseFeed(data) {
    var items = [];
    (data.items || []).forEach(function (it) {
      var major = it.modules && it.modules.module_dynamic && it.modules.module_dynamic.major;
      var arch = major && major.archive;
      if (!arch || !arch.bvid) return;
      var author = (it.modules && it.modules.module_author) || {};
      items.push({
        bvid: arch.bvid,
        title: arch.title || '',
        cover: arch.cover || '',
        dur: arch.duration_text || '',
        play: arch.stat && typeof arch.stat.play !== 'undefined' ? arch.stat.play : '',
        up: author.name || '',
        mid: author.mid ? String(author.mid) : '',
        face: author.face || '',
        pub: author.pub_time || ''
      });
    });
    return {
      items: items,
      offset: data.offset || '',
      hasMore: !!data.has_more,
      rawCount: (data.items || []).length
    };
  }

  globalThis.bfApi = {
    isDev: DEV,
    getNav: getNav,
    getFollowing: getFollowing,
    getSpecialFollowings: getSpecialFollowings,
    getFollowFeed: getFollowFeed
  };
})();
