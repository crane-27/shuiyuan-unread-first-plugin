/**
 * 构建 Chrome / Edge 版（MV3，用于小范围分发的「解压加载」方式）
 *
 * 用法：npm run build:chrome
 * 产物：
 *   dist/chrome/                                     解压后可直接「加载已解压的扩展程序」
 *   dist/shuiyuan-unread-first-chrome-<version>.zip  发给他人（解压后加载）
 *
 * 说明：content script 与 Firefox 版完全共用（未使用任何扩展 API）；
 * Chrome 版 manifest 需要去掉 gecko 专有字段（browser_specific_settings、
 * data_collection_permissions、SVG 图标），其余保持一致。
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const firefoxManifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));

const outDir = path.join(root, 'dist', 'chrome');
const zipPath = path.join(root, 'dist', `shuiyuan-unread-first-chrome-${firefoxManifest.version}.zip`);

const chromeManifest = {
  manifest_version: 3,
  name: firefoxManifest.name,
  version: firefoxManifest.version,
  description: firefoxManifest.description,
  minimum_chrome_version: '110',
  icons: {
    48: 'icons/icon-48.png',
    96: 'icons/icon-96.png',
  },
  content_scripts: [
    {
      matches: ['https://shuiyuan.sjtu.edu.cn/*'],
      js: ['src/content.js'],
      run_at: 'document_idle',
    },
  ],
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(outDir, 'src'), { recursive: true });
mkdirSync(path.join(outDir, 'icons'), { recursive: true });
writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(chromeManifest, null, 2) + '\n');
cpSync(path.join(root, 'src', 'content.js'), path.join(outDir, 'src', 'content.js'));
for (const icon of ['icon-48.png', 'icon-96.png']) {
  cpSync(path.join(root, 'icons', icon), path.join(outDir, 'icons', icon));
}

// 打包 zip（优先使用 zip 命令，不可用时退化为 python3）
rmSync(zipPath, { force: true });
const zipScript = [
  'import os, sys, zipfile',
  'root, out = sys.argv[1], sys.argv[2]',
  "with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:",
  '    for dirpath, _dirs, files in os.walk(root):',
  '        for name in files:',
  '            full = os.path.join(dirpath, name)',
  '            z.write(full, os.path.relpath(full, root))',
].join('\n');

let zipped = false;
try {
  execFileSync('zip', ['-r', '-q', zipPath, '.'], { cwd: outDir });
  zipped = true;
} catch (_) {
  try {
    execFileSync('python3', ['-c', zipScript, outDir, zipPath]);
    zipped = true;
  } catch (_) {
    zipped = false;
  }
}

console.log('Chrome 版目录已生成： ' + outDir);
if (zipped) {
  console.log('Chrome 版压缩包已生成： ' + zipPath);
} else {
  console.log('未找到 zip/python3，跳过压缩包；直接分发 dist/chrome 目录即可。');
}
