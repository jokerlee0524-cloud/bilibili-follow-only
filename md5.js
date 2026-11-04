/* MD5（UTF-8 输入，小写 hex 输出）
 * B 站 wbi 签名需要它，浏览器原生没有 MD5，所以自带一份。
 * 挂到 globalThis.bfMd5，供 wbi.js 使用。
 */
(function () {
  'use strict';

  var K = new Int32Array(64);
  for (var i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  }
  // 每轮左移位数：7,12,17,22 / 5,9,14,20 / 4,11,16,23 / 6,10,15,21
  var S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

  function toBytes(str) {
    if (typeof TextEncoder !== 'undefined') {
      return Array.from(new TextEncoder().encode(str));
    }
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function md5(str) {
    var bytes = toBytes(String(str));
    var bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var lo = bitLen >>> 0;
    var hi = Math.floor(bitLen / 4294967296) >>> 0;
    for (var b = 0; b < 4; b++) bytes.push((lo >>> (8 * b)) & 0xff);
    for (var c = 0; c < 4; c++) bytes.push((hi >>> (8 * c)) & 0xff);

    var a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;

    for (var off = 0; off < bytes.length; off += 64) {
      var M = new Int32Array(16);
      for (var m = 0; m < 16; m++) {
        var p = off + m * 4;
        M[m] = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24);
      }

      var A = a0, B = b0, C = c0, D = d0;

      for (var r = 0; r < 64; r++) {
        var F, g;
        if (r < 16) {
          F = (B & C) | (~B & D);
          g = r;
        } else if (r < 32) {
          F = (D & B) | (~D & C);
          g = (5 * r + 1) % 16;
        } else if (r < 48) {
          F = B ^ C ^ D;
          g = (3 * r + 5) % 16;
        } else {
          F = C ^ (B | ~D);
          g = (7 * r) % 16;
        }
        var sum = (A + F + K[r] + M[g]) | 0;
        var sh = S[(r % 4) + (r >> 4) * 4];
        A = D;
        D = C;
        C = B;
        B = (B + ((sum << sh) | (sum >>> (32 - sh)))) | 0;
      }

      a0 = (a0 + A) | 0;
      b0 = (b0 + B) | 0;
      c0 = (c0 + C) | 0;
      d0 = (d0 + D) | 0;
    }

    function le(n) {
      var s = '';
      for (var i = 0; i < 4; i++) {
        s += ('0' + ((n >>> (8 * i)) & 0xff).toString(16)).slice(-2);
      }
      return s;
    }

    return le(a0) + le(b0) + le(c0) + le(d0);
  }

  globalThis.bfMd5 = md5;
})();
