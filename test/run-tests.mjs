/**
 * jsdom 自动化测试：排序 / 补位 / 截断 / 幂等 / 失败兜底 / tab 守卫 / 当前话题排除 / 分类标签
 * 运行：node test/run-tests.mjs（需先 npm install）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.error('未找到 jsdom，请先运行 npm install');
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentScript = readFileSync(path.join(root, 'src', 'content.js'), 'utf8');

const CATEGORIES = [
  { id: 87, name: '生活', color: 'FFAB00', text_color: 'FFFFFF', slug: 'life-experience' },
  {
    id: 99,
    name: '职场生涯',
    color: 'FFD600',
    text_color: 'FFFFFF',
    slug: 'career',
    description_text: '职场生涯分类描述',
  },
];

const SKELETON = `<!DOCTYPE html><html><body>
<div class="more-topics__container"><div class="more-topics__lists">
  <div id="suggested-topics" class="more-topics__list">
    <h3 id="suggested-topics-title">新话题和未读话题</h3>
    <div class="topics">
      <table class="topic-list">
        <thead class="topic-list-header --has-tabs"><tr>
          <th class="topic-list-data default"><ul class="nav nav-pills">
            <li><button class="btn active" title="推荐" type="button">推荐</button></li>
            <li><button class="btn" title="相关" type="button">相关</button></li>
          </ul></th>
          <th class="topic-list-data posts num">回复</th>
          <th class="topic-list-data views num">浏览量</th>
          <th class="topic-list-data activity num">活动</th>
        </tr></thead>
        <tbody class="topic-list-body"></tbody>
      </table>
    </div>
  </div>
</div></div>
</body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkTopic(id, title, categoryId, state, extra = {}) {
  return Object.assign(
    {
      id,
      title,
      fancy_title: title,
      category_id: categoryId,
      __state: state,
      unread_posts: state === 'unread' ? 1 : 0,
      new_posts: state === 'unread' ? 1 : 0,
      posts_count: 10,
      reply_count: 9,
      views: 123,
      bumped_at: new Date(Date.now() - 20 * 60000).toISOString(),
    },
    extra
  );
}

function rowHtml(t) {
  const isUnread = t.__state === 'unread';
  const badge = isUnread
    ? `<a href="/t/topic/${t.id}" title="未读回复" class="badge badge-notification unread-posts">${t.unread_posts || 1}</a>`
    : `<a href="/t/topic/${t.id}" title="新话题" class="badge badge-notification new-topic"> </a>`;
  return `<tr data-topic-id="${t.id}" class="topic-list-item category-demo ${isUnread ? 'unread-posts' : 'unseen-topic'}">
    <td class="main-link topic-list-data" colspan="1">
      <span class="link-top-line" role="heading" aria-level="2">
        <span class="topic-statuses"></span>
        <a href="/t/topic/${t.id}" data-topic-id="${t.id}" class="title raw-link raw-topic-link">${t.title}</a>
        <span class="topic-post-badges">&nbsp;${badge}</span>
      </span>
      <div class="link-bottom-line">
        <span class="discourse-tags"><a class="discourse-tag" href="/tag/demo">演示标签</a></span>
        <a class="badge-category__wrapper" title="占位分类" style="--category-badge-color:#FFAB00;--category-badge-text-color:#FFFFFF;" href="/c/demo/${t.category_id}">
          <span data-category-id="${t.category_id}" class="badge-category"><span class="badge-category__name">占位分类</span></span>
        </a>
      </div>
    </td>
    <td class="num posts topic-list-data"><span class="posts">${t.reply_count}</span></td>
    <td class="num views topic-list-data"><span class="number">${t.views}</span></td>
    <td class="num activity topic-list-data"><span class="relative-date">20 分钟</span></td>
  </tr>`;
}

const EMOJIS = { custom: [{ name: 'deepseek', url: '/images/emoji/custom/deepseek.png' }] };

async function makePage({
  url = 'https://shuiyuan.sjtu.edu.cn/t/topic/111/1',
  unread = [],
  unreadStatus = 200,
  categories = CATEGORIES,
  preload = null,
} = {}) {
  const dom = new JSDOM(SKELETON, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = { unread: 0, categories: 0, emojis: 0 };
  window.fetch = async (u) => {
    const s = String(u);
    if (s.includes('/unread.json')) {
      calls.unread += 1;
      if (unreadStatus !== 200) return { ok: false, status: unreadStatus, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ topic_list: { topics: unread } }) };
    }
    if (s.includes('/categories.json')) {
      calls.categories += 1;
      return { ok: true, status: 200, json: async () => ({ category_list: { categories } }) };
    }
    if (s.includes('/emojis.json')) {
      calls.emojis += 1;
      return { ok: true, status: 200, json: async () => EMOJIS };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  if (preload) {
    const el = window.document.createElement('script');
    el.id = 'data-preloaded';
    el.textContent = JSON.stringify(preload);
    window.document.body.appendChild(el);
  }
  window.eval(contentScript);
  window.__syUf.pause();
  await sleep(5);
  return { window, doc: window.document, calls };
}

const setRows = (doc, list) => {
  doc.querySelector('tbody.topic-list-body').innerHTML = list.map(rowHtml).join('');
};
const rows = (doc) => [...doc.querySelectorAll('#suggested-topics tbody tr[data-topic-id]')];
const ids = (doc) => rows(doc).map((r) => r.dataset.topicId);
const visibleIds = (doc) => rows(doc).filter((r) => r.style.display !== 'none').map((r) => r.dataset.topicId);
const hiddenIds = (doc) => rows(doc).filter((r) => r.style.display === 'none').map((r) => r.dataset.topicId);
const injectedCount = (doc) => doc.querySelectorAll('tr[data-sy-injected]').length;

let passCount = 0;
const failures = [];
function test(label, fn) {
  try {
    fn();
    passCount += 1;
    console.log('✅ ' + label);
  } catch (err) {
    failures.push(label);
    console.log('❌ ' + label + '\n     ' + err.message);
  }
}

const mixed = () => [
  mkTopic('s1', '未点开 1', 87, 'unseen'),
  mkTopic('s2', '未读回复 A', 87, 'unread', { unread_posts: 3 }),
  mkTopic('s3', '未点开 2', 87, 'unseen'),
  mkTopic('s4', '未读回复 B', 99, 'unread'),
  mkTopic('s5', '未点开 3', 99, 'unseen'),
];
const unseen5 = () =>
  ['1', '2', '3', '4', '5'].map((n, i) => mkTopic('u' + n, '新话题 ' + n, 87, 'unseen', { reply_count: 10 + i }));
const apiUnread = (list, cat = 99) =>
  list.map((id, i) =>
    mkTopic(id, '注入话题 ' + id, cat, 'unread', {
      unread_posts: i + 1,
      new_posts: i + 1,
      tags: i === 0 ? ['AI', '测试'] : [],
    })
  );

// ---- 1) 混合重排 ----
{
  const { doc, window } = await makePage();
  setRows(doc, mixed());
  await window.__syUf.apply();
  test('混合：未读在前、组内稳定', () => assert.deepEqual(visibleIds(doc), ['s2', 's4', 's1', 's3', 's5']));
  test('混合：无隐藏行', () => assert.deepEqual(hiddenIds(doc), []));
}

// ---- 2) 补位到满 + 分类填充 ----
{
  const { doc, window, calls } = await makePage({ unread: apiUnread(['t1', 't2', 't3', 't4', 't5', 't6', 't7']) });
  setRows(doc, unseen5());
  await window.__syUf.apply();
  test('补位：前 5 条为注入未读', () => assert.deepEqual(visibleIds(doc), ['t1', 't2', 't3', 't4', 't5']));
  test('补位：总数 10、隐藏 5', () => {
    assert.equal(ids(doc).length, 10);
    assert.deepEqual(hiddenIds(doc), ['u1', 'u2', 'u3', 'u4', 'u5']);
  });
  test('补位：注入行未读徽标', () => {
    const badge = doc.querySelector('tr[data-topic-id="t1"] .badge-notification.unread-posts');
    assert.equal(badge.textContent, '1');
  });
  test('补位：分类接口仅 1 次、分类名更新', () => {
    assert.equal(calls.categories, 1);
    const name = doc.querySelector('tr[data-topic-id="t1"] .badge-category__name');
    assert.equal(name.textContent, '职场生涯');
  });
  test('顶层分类徽标不带 --has-parent', () => {
    const wrap = doc.querySelector('tr[data-topic-id="t1"] a.badge-category__wrapper');
    assert.ok(!wrap.querySelector('.badge-category').classList.contains('--has-parent'));
  });
  test('补位：注入行标签按数据重建', () => {
    const links = [
      ...doc.querySelectorAll('tr[data-topic-id="t1"] .discourse-tags a.discourse-tag'),
    ];
    assert.deepEqual(
      links.map((a) => a.textContent),
      ['AI', '测试']
    );
    assert.equal(links[0].getAttribute('href'), '/tag/' + encodeURIComponent('AI'));
  });
  test('补位：无标签话题不带标签容器', () => {
    assert.equal(doc.querySelectorAll('tr[data-topic-id="t2"] .discourse-tags').length, 0);
  });
  test('补位：分类悬浮描述已同步', () => {
    const wrap = doc.querySelector('tr[data-topic-id="t1"] a.badge-category__wrapper');
    assert.equal(wrap.getAttribute('title'), '职场生涯分类描述');
  });
  test('补位：注入行计数与时间已填充', () => {
    const row = doc.querySelector('tr[data-topic-id="t1"]');
    assert.equal(row.querySelector('td.posts').textContent.trim(), '9');
    assert.equal(row.querySelector('td.views').textContent.trim(), '123');
    assert.equal(row.querySelector('td.activity').textContent.trim(), '20 分钟');
  });
}

// ---- 3) 补位不足 ----
{
  const { doc, window } = await makePage({ unread: apiUnread(['t1', 't2'], 87) });
  setRows(doc, unseen5());
  await window.__syUf.apply();
  test('补位不足：未读 2 + 新话题 3', () => assert.deepEqual(visibleIds(doc), ['t1', 't2', 'u1', 'u2', 'u3']));
  test('补位不足：其余隐藏', () => assert.deepEqual(hiddenIds(doc), ['u4', 'u5']));
}

// ---- 4) 接口失败 ----
{
  const { doc, window } = await makePage({ unreadStatus: 403 });
  setRows(doc, mixed());
  await window.__syUf.apply();
  test('接口失败：仅重排', () => assert.deepEqual(visibleIds(doc), ['s2', 's4', 's1', 's3', 's5']));
  test('接口失败：无注入', () => assert.equal(injectedCount(doc), 0));
}

// ---- 5) 幂等 ----
{
  const { doc, window } = await makePage({ unread: apiUnread(['t1', 't2', 't3', 't4', 't5']) });
  setRows(doc, unseen5());
  await window.__syUf.apply();
  const before = doc.querySelector('#suggested-topics').outerHTML;
  await window.__syUf.apply();
  test('幂等：二次执行零改动', () =>
    assert.equal(doc.querySelector('#suggested-topics').outerHTML, before));
  test('幂等：注入行恰好 5 条', () => assert.equal(injectedCount(doc), 5));
}

// ---- 6) 当前话题排除 ----
{
  const { doc, window } = await makePage({ url: 'https://shuiyuan.sjtu.edu.cn/t/topic/111/1', unread: apiUnread(['111', '222']) });
  setRows(doc, unseen5());
  await window.__syUf.apply();
  test('当前话题被排除，仅注入 222', () => assert.deepEqual(visibleIds(doc), ['222', 'u1', 'u2', 'u3', 'u4']));
  test('当前话题排除：隐藏 u5', () => assert.deepEqual(hiddenIds(doc), ['u5']));
}

// ---- 7) tab 守卫 ----
{
  const { doc, window } = await makePage({ unread: apiUnread(['t1']) });
  setRows(doc, mixed());
  doc.querySelector('#suggested-topics button[title="推荐"]').classList.remove('active');
  doc.querySelector('#suggested-topics button[title="相关"]').classList.add('active');
  await window.__syUf.apply();
  test('相关 tab 激活：不改动', () => {
    assert.deepEqual(ids(doc), ['s1', 's2', 's3', 's4', 's5']);
    assert.equal(injectedCount(doc), 0);
    assert.deepEqual(hiddenIds(doc), []);
  });
}

// ---- 8) 标题实体与表情解码 ----
{
  const { doc, window } = await makePage({
    unread: [
      mkTopic('e1', 'x', 87, 'unread', { fancy_title: 'A&amp;B 测试' }),
      mkTopic('e2', 'y', 87, 'unread', {
        fancy_title: '你好<img class="emoji" src="/images/emoji/t.png" alt="e">呀',
      }),
    ],
  });
  setRows(doc, unseen5());
  await window.__syUf.apply();
  test('标题实体被解码（&amp; → &）', () => {
    const link = doc.querySelector('tr[data-topic-id="e1"] a.title');
    assert.equal(link.textContent, 'A&B 测试');
  });
  test('标题中的表情图片被保留', () => {
    const link = doc.querySelector('tr[data-topic-id="e2"] a.title');
    const img = link.querySelector('img.emoji');
    assert.ok(img);
    assert.equal(img.getAttribute('src'), '/images/emoji/t.png');
    assert.equal(link.textContent, '你好呀');
  });
}

// ---- 9) 分类嵌套（子分类） ----
{
  const nested = [
    {
      id: 500,
      name: '父分类',
      color: 'AA0000',
      slug: 'parent',
      subcategory_list: [{ id: 501, name: '子分类', color: '00AA00', slug: 'child' }],
    },
  ];
  const { doc, window, calls } = await makePage({ unread: apiUnread(['c1'], 501), categories: nested });
  setRows(doc, unseen5());
  await window.__syUf.apply();
  test('子分类标签正确解析', () => {
    const name = doc.querySelector('tr[data-topic-id="c1"] .badge-category__name');
    assert.equal(name.textContent, '子分类');
  });
  test('子分类场景仅请求一次分类接口', () => assert.equal(calls.categories, 1));
  test('二级分类徽标：父色变量与 --has-parent 同步', () => {
    const wrap = doc.querySelector('tr[data-topic-id="c1"] a.badge-category__wrapper');
    assert.equal(wrap.style.getPropertyValue('--parent-category-badge-color').trim(), '#AA0000');
    const badge = wrap.querySelector('.badge-category');
    assert.ok(badge.classList.contains('--has-parent'));
    assert.equal(badge.getAttribute('data-parent-category-id'), '500');
  });
  test('无描述分类：清除模板残留的悬浮说明', () => {
    const wrap = doc.querySelector('tr[data-topic-id="c1"] a.badge-category__wrapper');
    assert.ok(!wrap.hasAttribute('title'));
  });
}

// ---- 10) 预加载数据提供分类（无需请求 /categories.json） ----
{
  const preload = {
    site: JSON.stringify({
      categories: [{ id: 99, name: '职场生涯', color: 'FFD600', slug: 'career' }],
    }),
  };
  const { doc, window, calls } = await makePage({ unread: apiUnread(['p1'], 99), preload });
  setRows(doc, unseen5());
  await window.__syUf.apply();
  test('预加载来源解析分类且不请求接口', () => {
    const name = doc.querySelector('tr[data-topic-id="p1"] .badge-category__name');
    assert.equal(name.textContent, '职场生涯');
    assert.equal(calls.categories, 0);
  });
}

// ---- 11) 标题表情短代码渲染 ----
{
  const { doc, window, calls } = await makePage({
    unread: [
      mkTopic('m1', '投喂可爱蓝色大肥鱼 :deepseek:', 87, 'unread', {
        fancy_title: '投喂可爱蓝色大肥鱼 :deepseek:',
      }),
    ],
  });
  setRows(doc, unseen5());
  await window.__syUf.apply();
  test('表情短代码渲染为图片', () => {
    const img = doc.querySelector('tr[data-topic-id="m1"] a.title img.emoji');
    assert.ok(img, '应存在表情图片');
    assert.equal(img.getAttribute('title'), ':deepseek:');
    assert.equal(img.getAttribute('src'), '/images/emoji/custom/deepseek.png');
    assert.equal(calls.emojis, 1);
  });
}

// ---- 12) 页面已有同名表情时无需请求接口 ----
{
  const { doc, window, calls } = await makePage({
    unread: [mkTopic('m2', '你好 :smile:', 87, 'unread', { fancy_title: '你好 :smile:' })],
  });
  doc.body.insertAdjacentHTML(
    'beforeend',
    '<p><img class="emoji" title=":smile:" src="/images/emoji/twitter/smile.png" alt=":smile:" loading="lazy" draggable="false"></p>'
  );
  setRows(doc, unseen5());
  await window.__syUf.apply();
  test('页面已有表情模板：直接复用且不请求接口', () => {
    const img = doc.querySelector('tr[data-topic-id="m2"] a.title img.emoji');
    assert.ok(img);
    assert.equal(img.getAttribute('src'), '/images/emoji/twitter/smile.png');
    assert.equal(calls.emojis, 0);
  });
}

// ---- 结果 ----
console.log('\n通过 ' + passCount + ' 项' + (failures.length ? '，失败 ' + failures.length + ' 项：\n- ' + failures.join('\n- ') : '，全部通过'));
if (failures.length) process.exitCode = 1;
