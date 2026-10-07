# 水源未读优先（shuiyuan-unread-first）— 设计与实施计划

- 状态：**已实现并通过本地自动验证**（jsdom 17 项测试全过 + `web-ext lint` 0 错误 0 告警），待登录态实测
- 日期：2026-10-07
- 目标站点：https://shuiyuan.sjtu.edu.cn （Discourse，站点版本 2026.5.0-latest.1，全站需登录）

---

## 1. 目标

在话题页底部「推荐」栏中，把**有未读回复（跟踪级别，蓝色数字气泡）**的话题排到最前；不足时从论坛未读接口补位；整体最多 5 条（该栏原有设计上限）。形态为 **Firefox 桌面版扩展**（Manifest V3，纯 JS 无构建）。

## 2. 已确认事实（取证记录）

### 2.1 截图观察（refs/，已由逐张确认）
- 「推荐 / ✦相关」两个 tab，「推荐」为当前选中；列表 5 行；列头「回复 | 浏览量 | 活动」；该列表不显示头像列。
- 浅蓝小圆点（无数字）=「从未点开」（unseen / new）；蓝底数字气泡 =「有未读回复」（unread，跟踪级别才有）。
- 底部文案：「有 N 个未读话题和 M 个新话题，或浏览【分类】中的其他话题」。
- 截图中该栏 5 行全部是圆点（新话题），没有任何用户跟踪未读——这正是要修复的场景。

### 2.2 Discourse 上游核实（@librarian，discourse/discourse main，站点版本接近）
- 服务端推荐算法本来就是「未读 → 新话题 → 随机补足」，数量由 `suggested_topics`（默认 5）封顶；但站点实测页面上并未出现未读，说明仅靠重排不够，**补位注入才是关键**。
- DOM 稳定选择器：
  - 容器 `#suggested-topics`（.more-topics__list）→ `.topics` → `table.topic-list` → `tbody` → `tr.topic-list-item[data-topic-id]`
  - 行状态 class：`unread-posts`（有未读回复）/ `unseen-topic`（从未点开）
  - 徽标：`.badge-notification.unread-posts`（数字）/ `.badge-notification.new-topic`（圆点）
  - 标题链接：`a.title.raw-topic-link`
- `/unread.json`（登录态）：GET + cookie 即可，无需 CSRF；条目为 TopicListItemSerializer，含 id/title/fancy_title/slug/category_id/reply_count/views/bumped_at/unread_posts/new_posts/unseen/notification_level 等，足够生成行；分页可用 `page`（per_page 参数名未核实，v1 只用默认第一页）。
- 话题 JSON（`/t/<id>.json`）与 `#data-preloaded` 的 `topic_<id>` 含 suggested_topics 字段——但站点自研插件 `discourse-preload-optimization` 可能裁剪预加载数据，**本方案不依赖预加载数据**。
- 未发现现成同类 userscript / 插件 / 主题组件，需自研。
- 站点启用 `login_required`（jAccount SSO），匿名接口全部 403。

### 2.3 本机环境
- Node v22.23.1 / npm 10.9.8（web-ext v10 要求 Node 22+，满足）。

### 2.4 登录态实地取证（已完成，样本页 `/t/topic/475868/320`）
- 容器证实：`.more-topics__container > .more-topics__lists > #suggested-topics.more-topics__list`；标题 `h3#suggested-topics-title`「新话题和未读话题」；表格 `#suggested-topics .topics table.topic-list > tbody.topic-list-body`。
- Tab 证实：推荐/相关是表头内按钮 `thead.topic-list-header.--has-tabs ul.nav-pills > li > button`（「推荐」当前为 `btn.active`）→ 实现需加「仅推荐 tab 激活时处理」守卫，避免误改「相关」列表。
- 行证实：`tr.topic-list-item[data-topic-id]`，状态类 `unseen-topic`；标题 `a.title.raw-link.raw-topic-link`；站点链接样式为 `/t/topic/<id>`（不带 slug）；徽标 `span.topic-post-badges > a.badge.badge-notification.new-topic`（title=「新话题」）；分类标签 `a.badge-category__wrapper`（CSS 变量 `--category-badge-color` 等 + 内层 `span[data-category-id]`）。
- 样本 5 行均为 `unseen-topic`（该页无未读行），与截图一致。
- `/unread.json`：HTTP 200；样本 2 条，实测字段：id/title/unread_posts/new_posts/unseen/notification_level(=2, Tracking)/last_read_post_number/posts_count/highest_post_number。`category_id/slug/reply_count/views/bumped_at` 未包含在本次截取子集中，但属上游 TopicListItemSerializer 字段（实现按字段存在与否降级）。
- `#data-preloaded` 未按预期读取有效键（脚本读取方式问题）；本方案不依赖预加载数据。
- 底部「有 N 个未读话题…」文案在样本页未渲染（条件显示）；插件不处理该文案。

## 3. 设计决策记录（逐轮确认结果）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 处理方式 | 重排 + 补位（不足时从未读接口注入）；不做完全替换 |
| 2 | 未读定义 | 蓝点（有未读回复/跟踪）优先，灰点（从未点开）其次；两类都算「未读」 |
| 3 | 组内排序 | 稳定排序：保持各组原有相对顺序 |
| 4 | 工程形态 | 纯 JS，无构建；默认 Manifest V3 |
| 5 | 安装方式 | 临时加载验证 + 用户自行完成 AMO unlisted 签名（我提供命令/文档，密钥不经过会话） |
| 6 | 配置项 | 无配置，硬编码合理默认 |
| 7 | 平台 | 仅桌面 Firefox（窄屏实现顺带兼容，不做专项验证） |
| 8 | 条数上限 | 推荐栏总条数上限 5（该站原设计），超出替换尾部 |
| 9 | 补位来源 | 只用 /unread.json（蓝点）；灰点不参与补位，仅参与重排 |
| 10 | 视觉 | 不改任何视觉样式 |
| 11 | 验收/取证 | 用户可在登录态控制台跑只读命令取证 |
| 13 | 栏内现状 | 该栏只有两类未读标记（蓝/灰） |
| 14 | 「跟踪」含义 | 通知级别 Tracking；水源上蓝点即跟踪，无需额外级别判断 |
| 16 | 优先级顺序 | 蓝点 → 灰点（蓝点即跟踪，不存在「灰点跟踪」） |
| 17 | 不足 5 条 | 显示实际条数，不用已读项凑数 |
| 18 | 跟踪集口径 | 接受 /unread.json 全集（Tracking+Watching 混含，差异可忽略） |
| 19 | 拉取范围 | 全站（不限于当前分类） |
| 20 | 蓝点选取 | 原有蓝点保持原顺序在前；不足 5 条时才请求接口补缺 |

## 4. 行为规格（v1）

### 4.1 触发
- 站点级 content script（Discourse 是 SPA，从首页点进话题不刷新页面，因此 matches 为整个站点而非 `/t/*`）。
- MutationObserver 观察 `document.body`（`childList + subtree`）+ 防抖；每次触发后查找 `#suggested-topics`，找到才执行。

### 4.2 分级与排序
- 前置守卫：仅当「推荐」tab 激活（同一表头内 `button.active` 文案为「推荐」）时处理；「相关」激活或无法判定时跳过。
1. 列表行分级：
   - **A**：`tr` 含 class `unread-posts` 或含 `.badge-notification.unread-posts`（有未读回复）
   - **B**：`tr` 含 class `unseen-topic` 或含 `.badge-notification.new-topic`（从未点开）
   - **C**：其他（实际应不存在；若存在排最后）
2. 目标顺序：A（原顺序）→ B（原顺序）→ C（原顺序）。

### 4.3 补位（仅蓝点）
- 若 A 类行数 < 5：请求 `/unread.json`（全站、活动序、默认第一页）：
  - 排除当前话题 id；
  - 排除列表中已存在的 id（去重）；
  - 按接口顺序逐条生成行，插入到「最后一个 A 行」之后，直到 A = 5 或接口条目用尽。
- 接口结果 5 秒内存缓存（同一页面快速切换话题不重复请求）。

### 4.4 截断与展示
- 按目标顺序只显示前 5 行（其余 `display:none`）；若排序后总行数不足 5，显示实际条数。
- 不改视觉、不加标记、不改底部文案。

### 4.5 合成行
- 以该栏**现有行**为模板克隆（自动继承站点主题样式），填充：
  - 标题 + 链接（站点样式 `/t/topic/<id>`，实测确认不带 slug；标题用 fancy_title/title）
  - 未读数字徽标（`unread_posts || new_posts`；复用模板行 `.new-topic` 锚点结构改为 `.unread-posts` + 数字）
  - 回复数（`reply_count`，缺失时降级为 `posts_count - 1`）、浏览量（`views`，缺失留空）
  - 活动时间（`bumped_at` 相对时间：分钟/小时/天内显示相对值，超 7 天显示日期；同时写入绝对时间 title）
  - 分类名/颜色：合并「页面现有分类标签缓存」与「一次性 `GET /categories.json` 缓存」；仍失败则不渲染分类标签（降级，不报错）
- 注入行打标记（如 `data-sy-injected="1"`），重复执行时按 `data-topic-id` 去重、幂等。

### 4.6 幂等与失败兜底
- 若当前顺序/可见性已符合目标 → **零 DOM 修改**（防 MutationObserver 自触发循环）。
- 接口失败 / 未登录 / 找不到容器 / 结构不符合 → 静默；接口失败时仍完成重排。
- 不触碰「相关」tab 与站内其他页面；不注入样式；不使用浏览器扩展 API（纯 DOM + fetch），便于 mock 测试。

### 4.7 效果示例
- 原：`[灰, 蓝, 灰, 灰, 灰]` → 变：`[蓝, 灰, 灰, 灰, 灰]`
- 蓝点不足时补位：`[蓝, 蓝, 蓝, 蓝, 蓝]`（未读 ≥5 时原灰点全部被挤出）
- 未读只有 2 条时：`[蓝, 蓝, 灰, 灰, 灰]`；未读 3 条、灰点 0 条时：`[蓝, 蓝, 蓝]`（显示实际条数）

## 5. 工程结构

```
manifest.json          MV3；content_scripts.matches = https://shuiyuan.sjtu.edu.cn/*
                       browser_specific_settings.gecko.id（固定 ID，签名必需）
                       （无需 host_permissions：content script 同源 fetch 以页面身份进行）
src/content.js         全部逻辑：常量 → 定位 → 分级 → 排序/可见性 → 补位 → 合成行 → 观察调度 → 兜底
icons/48.png, 96.png   占位图标（先简单生成，可后续替换）
test/mock.html         模拟 #suggested-topics 结构与假 /unread.json（自测排序/补位/截断/幂等/失败兜底）
package.json           devDeps: web-ext；scripts: lint / build / sign / run
README.md              临时加载、打包、签名（AMO unlisted）步骤
PLAN.md                本计划
```

- 扩展显示名「水源未读优先」；gecko id 暂定 `shuiyuan-unread-first@liuil235`（签名后不可更改，可在此审查阶段更换）。

## 6. 交付与安装

- 临时加载：`about:debugging#/runtime/this-firefox` → 载入 `manifest.json`（或 `npm run start` = `web-ext run`）。
- 打包：`npm run build`（web-ext build → `web-ext-artifacts/*.zip`）。
- 签名（用户自行执行，密钥不进会话）：AMO 生成 API key/secret → `web-ext sign --channel=unlisted`，或 AMO 手动上传 zip 选择「自发布（unlisted）」；签名后安装 xpi 永久使用。
- 隐私：无数据收集、无存储、无后台、无远程代码。

## 7. 验证计划

1. 我：mock 自测（顺序、补位、截断、幂等、失败兜底）；`web-ext lint` 零错误。
2. 你：临时加载实测三个场景：
   - 推荐栏有蓝点+灰点 → 蓝点在前；
   - 推荐栏无蓝点 → 从接口补到 5 条蓝点；
   - 未读不足 5 条 → 显示实际条数。
3. 有问题贴控制台报错 → 迭代修复。

## 8. 风险与未决项

| 项 | 影响 | 应对 |
|----|------|------|
| SPA 切换话题时节点复用/替换方式未运行时验证 | 可能漏触发或重复处理 | 观察 body + 防抖 + 幂等守卫 |
| 切到「相关」tab 后同容器行为未验证 | 可能误处理相关列表 | 增加「推荐 tab 激活」守卫；实测校正 |
| `/unread.json` 的 category_id/reply_count/views/bumped_at 未在样本子集中直接出现 | 合成行个别字段缺失 | 按上游序列化器实现；字段缺失时逐项降级（分类标签可缺、计数留空） |
| `unified_new_enabled` 实验可能改变推荐组成 | 服务端顺序变化 | 插件重排不依赖服务端顺序，仍生效 |
| `/unread.json` per_page 参数名未核实 | 分页行为 | v1 只用默认第一页（约 30 条，足够补 5 条） |

## 9. 下一步

1. **你审查本计划**（重点：第 4 节行为规格、第 5 节命名与结构）——取证已补齐（见 2.4）；
2. 确认后开工：实现 → mock 自测 → 你临时加载实测 → 迭代 → 打包与签名。
