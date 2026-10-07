# 水源未读优先（Firefox / Chrome 扩展）

在 [水源社区](https://shuiyuan.sjtu.edu.cn) 话题页底部「推荐」栏中，把**有未读回复（跟踪级别）的话题**排到最前；不足 5 条时从论坛未读接口自动补位；整栏最多显示 5 条（该栏原设计）。

- 只作用于「推荐」tab，不修改「相关」；
- 除顺序与内容（补位）外不改任何视觉；
- 无后台脚本、无存储、无数据收集；纯 DOM + 同源请求；
- 设计与逐项决策记录见 `PLAN.md`。

## 行为

1. 行分级：**未读回复**（蓝色数字气泡）→ **从未点开**（小圆点）→ 其他；
2. 组内保持原有顺序（稳定排序）；
3. 未读不足 5 条时，从 `/unread.json`（全站、最近活动优先；排除当前话题与重复项）补位；
4. 只显示前 5 条，其余隐藏；不足 5 条就显示实际条数；
5. 「相关」tab 激活时不做任何处理；接口失败/未登录时静默（仍完成重排）。

## 安装与使用

### 方式一：临时加载（开发/试用）

1. 打开 Firefox，地址栏进入 `about:debugging#/runtime/this-firefox`；
2. 点「临时载入附加组件…」，选择本目录的 `manifest.json`；
3. 登录水源，打开任意话题页，滚动到底部查看「推荐」栏；
4. 注意：浏览器重启后需要重新临时加载。

### 方式二：长期安装（AMO unlisted 自行签名）

1. 注册/登录 [AMO 开发者中心](https://addons.mozilla.org/developers/)，到
   https://addons.mozilla.org/developers/addon/api/key/ 生成 API key/secret；
2. 本地执行（密钥只留在你本机）：

   ```bash
   npm install
   export WEB_EXT_API_KEY="user:xxxxxxxx:123"
   export WEB_EXT_API_SECRET="xxxxxxxxxx"
   npm run sign
   ```

3. 在 `web-ext-artifacts/` 得到已签名的 `.xpi`，拖入 Firefox 安装即可（不公开上架）。
   也可手动：AMO 开发者中心 →「提交附加组件」→ 选择「自发布（on your own）」上传 `npm run build` 的产物。

### 方式三：Chrome / Edge 版（小范围分发）

Chrome/Edge 版与 Firefox 版共用同一份 content script，用构建脚本生成：

```bash
npm run build:chrome
```

产物：
- `dist/chrome/`：解压加载用的目录；
- `dist/shuiyuan-unread-first-chrome-<版本>.zip`：发给他人（对方解压后加载）。

对方安装步骤（Chrome 或 Edge）：
1. 解压 zip 到一个**固定的文件夹**（之后不要删除或移动）；
2. Chrome 打开 `chrome://extensions`（Edge 为 `edge://extensions`）；
3. 打开右上角「开发者模式」；
4. 点「加载已解压的扩展程序」，选择解压出来的文件夹；
5. 登录水源，打开话题页查看效果。

注意：
- 这类非商店扩展必须通过「开发者模式」加载；请保持开发者模式开启，否则扩展会被停用；
- 想免去开发者模式，可上架 Chrome Web Store（一次性 5 美元开发者注册费；可见性可选 Unlisted，仅链接可见）。

## 开发

```bash
npm install      # 安装 web-ext / jsdom（Node 22+）
npm run lint     # web-ext lint 静态检查
npm test         # jsdom 自动化测试（排序 / 补位 / 截断 / 幂等 / 失败兜底 / tab 守卫 / 排除当前话题）
npm run build    # 打包 Firefox 版 zip → web-ext-artifacts/
npm run build:chrome  # 生成 Chrome/Edge 版（解压加载 / 分发）→ dist/
npm run run      # web-ext run：自动打开一个装有扩展的 Firefox
```

浏览器内手工测试：直接用 Firefox 打开 `test/mock.html`（内置 fetch 模拟与 6 个场景按钮）。

## 故障排查

- 打开控制台（F12），过滤 `[水源未读优先]` 可看到全部调试日志；
- 未登录时没有未读数据，插件会自动静默；
- 若「推荐」栏无变化：确认当前是「推荐」tab、且页面上存在带未读/未点开标记的话题；
- 站点大版本升级若改了 DOM 结构，可能需要更新 `src/content.js` 中的选择器（见文件头注释）。

## 目录结构

```
manifest.json        MV3 清单（content script 仅匹配 shuiyuan.sjtu.edu.cn）
src/content.js       全部逻辑（纯 DOM + fetch，无扩展 API）
icons/               图标（48/96 PNG + SVG 源）
test/mock.html       浏览器手工测试页
test/run-tests.mjs   jsdom 自动化测试
scripts/build-chrome.mjs  Chrome/Edge 版构建（npm run build:chrome）
PLAN.md              设计计划与决策记录
```

## 已知限制

- 注入行的话题标签按接口数据重建、样式复用页面现有标签；若站点对个别标签使用特殊配色，可能与原生略有差异；
- 相对时间超过 7 天后显示日期，格式与站点略有差异；
- 站点主题若调整「推荐 / 相关」的 DOM 结构，插件会自动降级为不动作（不会报错）。
