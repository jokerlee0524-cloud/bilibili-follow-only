/* B 站接口封装：wbi 签名 + 关注列表 + 关注动态流
 * 运行在 bilibili.com 页面内（内容脚本），fetch 自带登录 Cookie。
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

  function mixinKey(orig) {
    var out = '';
    for (var i = 0; i < MIXIN_KEY_ENC_TAB.length; i++) out += orig[MIXIN_KEY_ENC_TAB[i]];
    return out.slice(0, 32);
  }

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

  async function jget(url) {
    var res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json, text/plain, */*' }
    });
    if (!res.ok) {
      var err = new Error('HTTP ' + res.status);
      err.httpStatus = res.status;
      throw err;
    }
    var data = await res.json();
    if (data && typeof data.code === 'number' && data.code !== 0) {
      var e = new Error('API ' + data.code + ' ' + (data.message || ''));
      e.apiCode = data.code;
      throw e;
    }
    return data;
  }

  /* 原样取 JSON，不校验 code —— nav 接口未登录时返回 -101，属于正常状态而非错误 */
  async function jgetRaw(url) {
    var res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json, text/plain, */*' }
    });
    if (!res.ok) {
      var err = new Error('HTTP ' + res.status);
      err.httpStatus = res.status;
      throw err;
    }
    return res.json();
  }

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

  /* 关注列表（分页拉全） */
  async function getFollowing(mid, onProgress) {
    if (DEV) {
      var mock = await jget(location.origin + '/mock/followings.json');
      var list = ((mock.data && mock.data.list) || []).map(function (u) {
        return { mid: String(u.mid), uname: u.uname, face: u.face };
      });
      if (onProgress) onProgress(list.length, list.length);
      return { total: list.length, list: list };
    }

    var keys = await ensureKeys();
    var all = [];
    var total = 0;
    for (var pn = 1; pn <= 20; pn++) {
      var q = signQuery({ vmid: mid, pn: pn, ps: 50, order: 'desc', order_type: 'attention' }, keys.imgKey, keys.subKey);
      var res = await jget('https://api.bilibili.com/x/relation/followings?' + q);
      var d = res.data || {};
      total = d.total || total;
      var batch = (d.list || []).map(function (u) {
        return { mid: String(u.mid), uname: u.uname, face: u.face };
      });
      all = all.concat(batch);
      if (onProgress) onProgress(all.length, total);
      if (batch.length < 50 || all.length >= total) break;
    }
    return { total: total, list: all };
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
    getFollowFeed: getFollowFeed
  };
})();
