# B站 · 只看关注

> 打开 B 站首页，只看得到你关注的 UP 主。

一个 Chrome / Edge 扩展（Manifest V3）：把首页整块推荐流替换成一条「只来自关注 UP 主」的视频流，也可以切成温和一点的「仅过滤」模式，保留原生首页、只把非关注内容藏起来。

零依赖、零上报、全部数据跑在你自己已登录的浏览器里。

![只看关注](docs/screenshot-real.png)

<sub>真实运行截图：已登录状态、352 个关注，卡片全部来自关注的 UP 主。</sub>

---

## 为什么做这个

B 站首页的推荐流是会"驯化"人的：你多看两眼的东西，第二天铺满整个屏幕。而关注列表恰恰是你自己主动做的选择。

这个扩展只做一件事——**把首页还给你自己的选择**。

## 两种模式

| 模式 | 行为 | 适合 |
|---|---|---|
| **关注流**（默认） | 隐藏原生推荐流，在首页顶部注入「只看关注」面板，卡片来自关注 UP 主的视频动态 | 想彻底清空推荐、只刷关注的人 |
| **仅过滤** | 保留 B 站原生首页，只把「UP 主不在你关注列表里」的卡片隐藏，右下角显示隐藏数量 | 只想筛掉推荐、还想看原生布局的人 |

弹窗里随时切换，切换后当前页面立刻重载生效，不用手动刷新。

弹窗里还有：

- 总开关（关掉 = 完全不管，首页恢复原样）
- 关注数量 + 上次同步时间
- 「刷新关注列表」（清缓存重拉）
- 「打开 B 站首页」

![工具栏弹窗](docs/preview-popup.png)

<sub>工具栏弹窗：总开关、模式切换、关注数与同步时间。</sub>

---

## 安装

### Chrome / Edge（手动加载，3 步）

1. 把仓库克隆到本地任意目录
   ```bash
   git clone https://github.com/jokerlee0524-cloud/bilibili-follow-only.git
   ```
2. 地址栏打开 `chrome://extensions`（Edge 是 `edge://extensions`）
3. 右上角打开「开发者模式」→ 左上角点「加载未打包的扩展程序」→ 选中克隆下来的文件夹

> 注意 Chrome 较新版本把「加载已解压的扩展程序」改叫了「**加载未打包的扩展程序**」，位置没变，都在扩展页左上角。开发者模式那个开关藏在最右上角，很小，容易找不到。

![Chrome 安装两步](docs/chrome-install-guide.png)

<sub>① 右上角打开开发者模式 → ② 左上角点「加载未打包的扩展程序」，选中本仓库文件夹。</sub>

### 其他 Chromium 内核浏览器

部分 Chromium 分支（如豆包浏览器）仍支持命令行加载，启动时带上扩展目录即可：

```bash
<浏览器可执行文件> --load-extension=/path/to/bilibili-follow-only https://www.bilibili.com/
```

> 命令行参数只在**启动时**生效，所以要先完全退出浏览器再带参数启动。
> Chrome 138+ 已经禁用这个开关，只能走上面的手动加载。

装好后打开 <https://www.bilibili.com/>，首页顶部出现「只看关注」面板即成功。建议把图标固定到工具栏，点开就能一键开关。

---

## 它是怎么做到"只有关注"的

全部数据都来自 B 站自己的接口，跑在你已登录的浏览器里：

1. `GET /x/web-interface/nav` —— 拿登录态和 wbi 签名密钥
2. `GET /x/relation/followings?vmid=...` —— 分页拉全你的关注列表（500 个关注就是 10 页）
3. `GET /x/polymer/web-dynamic/v1/feed/all?type=video` —— 关注 UP 的**视频动态**，天然只包含关注的人

其中动态接口需要 wbi 签名（`w_rid` + `wts`），扩展里自带了一份 MD5 和签名实现（`md5.js` / `wbi.js`），**不依赖任何第三方库**。

原生首页那边则按卡片上的 `a[href*="space.bilibili.com/"]` 抠出 UP 主 mid，比对关注集合，决定保留还是隐藏。

---

## 权限与隐私

- `storage`：只存「开关 / 模式」和关注列表缓存，**全部在本机**
- `host_permissions`：`api.bilibili.com`、`www.bilibili.com`，只用于读写上面三个接口
- 没有任何上报、没有第三方服务器、不碰账号密码

关注列表缓存 12 小时，过期后下次打开首页自动重拉；弹窗里的「刷新关注列表」可以立即重拉。

---

## 已知限制（诚实版）

- **必须登录 B 站**。未登录时接口只返回 `-101`，面板会提示「去登录」。
- 关注流走的是「视频动态」，所以：只投专栏 / 动态不投视频的 UP 不会出现；刚发但还没生成动态的可能延迟几分钟。
- B 站改版是常态。代码对新版首页（`#app > main.bili-feed4-layout > .feed2`）和旧版首页（`#i_cecream`）都做了兼容；如果哪天关注流接口挂了，扩展会**自动降级到「仅过滤」模式**并在面板里提示，而不是把首页搞白。
- 「仅过滤」模式依赖卡片 DOM 里的 `space.bilibili.com/<mid>` 链接；广告卡、活动卡这类认不出作者的会被一并隐藏（这是有意的）。
- 扩展 ID 通过 `manifest.json` 里的 `key` 字段固定，换目录安装也不会丢配置。

---

## 目录结构

```
bilibili-follow-only/
├─ manifest.json      MV3 清单
├─ CHANGELOG.md       更新日志
├─ feed.js            内容脚本：注入面板 / 过滤卡片 / 降级逻辑
├─ feed.css           面板与卡片样式（含隐藏原推荐的规则、深色模式）
├─ wbi.js             接口封装：nav、关注列表、关注动态流、wbi 签名
├─ md5.js             纯 JS MD5（wbi 签名用）
├─ bg.js              Service Worker：首次安装写默认配置
├─ popup.html/js/css  工具栏弹窗
├─ icons/             16/32/48/128 图标
├─ docs/              截图
└─ test/              本地夹具
   ├─ fixture.html    模拟 B 站首页 DOM，9 张卡（3 关注 / 6 非关注）
   └─ mock/           nav / followings / dynamic 三个接口的假数据
```

## 本地调试

```bash
# 起夹具服务
cd test && python -m http.server 8130 --bind 127.0.0.1

# 用测试版 manifest（多一条 127.0.0.1 的匹配规则）加载扩展
# 夹具地址：
#   http://127.0.0.1:8130/fixture.html?dev=1                关注流模式
#   http://127.0.0.1:8130/fixture.html?dev=1&mode=filter    仅过滤模式
#   http://127.0.0.1:8130/fixture.html?dev=1&off=1          关闭态
```

`?dev=1` 只对 `127.0.0.1 / localhost` 生效，真实站点上不存在这个分支。
夹具里的封面图（`test/mock/covers/`）不随仓库分发，本地调试时随便放几张图即可。

夹具环境下长这样（封面是渐变占位图，用来验证布局和过滤逻辑）：

![夹具环境](docs/preview-feed.png)

---

## License

[MIT](LICENSE)
