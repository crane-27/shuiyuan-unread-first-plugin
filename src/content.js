/**
 * 水源未读优先 —— content script
 *
 * 目标：在话题页底部「推荐」栏中，把有未读回复（跟踪级别，数字气泡）的话题排到最前；
 * 不足 5 条时从 /unread.json 补位；整栏最多显示 5 条；不改视觉；失败静默；幂等。
 *
 * 约束：不使用任何 browser.* / chrome.* API（纯 DOM + 同源 fetch），
 * 便于在普通页面（test/mock.html）与 jsdom（test/run-tests.mjs）中直接测试。
 *
 * 完整设计见仓库根目录 PLAN.md（第 4 节行为规格、第 2.4 节实测取证）。
 */

(() => {
  'use strict';

  // ==================== 配置 ====================
  const PREFIX = '[水源未读优先]';
  const MAX_ITEMS = 5; // 整栏最多显示条数（站点原设计）
  const UNREAD_TARGET = MAX_ITEMS; // 补位后期望的未读条数
  const CACHE_TTL_MS = 5000; // /unread.json 结果缓存（毫秒）
  const FETCH_ERROR_LOG_INTERVAL_MS = 15000; // 接口报错日志节流

  const SEL_CONTAINER = '#suggested-topics'; // 推荐栏容器（实测确认）
  const SEL_TBODY = 'tbody.topic-list-body';
  const CLASS_UNREAD = 'unread-posts'; // 行状态：有未读回复
  const CLASS_UNSEEN = 'unseen-topic'; // 行状态：从未点开
  const SEL_BADGE_UNREAD = '.badge-notification.unread-posts';
  const SEL_BADGE_NEW = '.badge-notification.new-topic';

  // 克隆模板行时需要清理的状态类（避免把模板话题的状态带到注入行上）
  const STATE_CLASSES = [
    'unread-posts',
    'unseen-topic',
    'visited',
    'bookmarked',
    'liked',
    'pinned',
    'unpinned',
    'closed',
    'archived',
    'has-excerpt',
  ];

  // ==================== 运行时状态 ====================
  const state = {
    autoPaused: false, // 测试用：暂停自动调度
    scheduled: false, // 已安排一轮调度
    running: false, // 当前有执行中的 apply
    pending: false, // 执行期间又有新变更
    unreadCache: { at: 0, topics: null },
    unreadInflight: null, // 并发请求合并
    lastFetchErrorLogAt: 0,
    categories: new Map(), // id(string) -> { id, name, color, textColor, slug }
    categoriesFetched: false,
    lastCategoriesErrorAt: 0,
    emojis: new Map(), // ':code:' -> { url, template }（template 为页面中可克隆的表情图片）
    emojisFetched: false,
    lastEmojisErrorAt: 0,
    preloadedAbsorbed: false,
  };

  const log = (...args) => {
    try {
      console.debug(PREFIX, ...args);
    } catch (_) {
      /* 忽略 */
    }
  };

  const defer = (fn) =>
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 0);

  // ==================== 小工具 ====================
  const toArray = (list) => Array.prototype.slice.call(list || []);

  function firstIn(root, selectors) {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  /** 从当前地址解析话题 id（/t/topic/475868/320 → '475868'） */
  function currentTopicId() {
    const m = location.pathname.match(/\/t\/[^/]+\/(\d+)/);
    return m ? m[1] : null;
  }

  /** 相对时间，对齐站点样式：刚刚 / N 分钟 / N 小时 / N 天 / 日期 */
  function formatRelative(iso) {
    const t = Date.parse(iso);
    if (!t) return '';
    const diff = Date.now() - t;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return minutes + ' 分钟';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + ' 小时';
    const days = Math.floor(hours / 24);
    if (days < 7) return days + ' 天';
    const d = new Date(t);
    const md = d.getMonth() + 1 + '月' + d.getDate() + '日';
    return d.getFullYear() === new Date().getFullYear() ? md : d.getFullYear() + '年' + md;
  }

  /** 浏览量简写（≥1000 → 8.9k） */
  function formatCount(n) {
    const num = Number(n);
    if (n == null || Number.isNaN(num)) return '';
    if (num < 1000) return String(num);
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  }

  const normalizeColor = (v) => {
    const s = String(v || '').trim().replace(/^#/, '');
    return s || null;
  };

  // ==================== 行分级 ====================
  function topicRows(tbody) {
    return toArray(tbody.children).filter(
      (el) => el.tagName === 'TR' && el.hasAttribute('data-topic-id')
    );
  }

  const rowTopicId = (row) => row.getAttribute('data-topic-id') || '';

  const isUnreadRow = (row) =>
    row.classList.contains(CLASS_UNREAD) || !!row.querySelector(SEL_BADGE_UNREAD);

  const isUnseenRow = (row) =>
    row.classList.contains(CLASS_UNSEEN) || !!row.querySelector(SEL_BADGE_NEW);

  const rankOf = (row) => (isUnreadRow(row) ? 0 : isUnseenRow(row) ? 1 : 2); // A→B→C

  /**
   * 前置守卫：仅当「推荐」tab 激活时才处理。
   * - 找不到 tab 按钮（单列表场景）→ 通过；
   * - 有 tab 但找不到激活态 → 保守跳过；
   * - 激活的是「相关」→ 跳过。
   */
  function recommendedTabActive(container) {
    const buttons = toArray(container.querySelectorAll('button')).filter((b) =>
      /推荐|相关/.test((b.textContent || '').trim())
    );
    if (!buttons.length) return true;
    const active = buttons.find(
      (b) =>
        b.classList.contains('active') ||
        b.getAttribute('aria-pressed') === 'true' ||
        b.getAttribute('aria-selected') === 'true'
    );
    if (!active) return false;
    return /推荐/.test(active.textContent || '');
  }

  // ==================== 分类信息（用于注入行的分类标签） ====================
  /**
   * 通用吸收：在任意 JSON 结构里收集「分类形状」的对象（有 id + color + name/slug）。
   * 兼容 /categories.json（含嵌套 subcategory_list）与 #data-preloaded 的 site 数据等不同结构。
   */
  function absorbCategories(node, depth, parent) {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      node.forEach((n) => absorbCategories(n, depth + 1, parent));
      return;
    }
    if (typeof node !== 'object') return;
    const isCategory = node.id != null && node.color && (node.name || node.slug);
    if (isCategory) {
      const key = String(node.id);
      if (!state.categories.has(key)) {
        const parentId =
          node.parent_category_id != null
            ? node.parent_category_id
            : parent && parent.id != null
              ? parent.id
              : null;
        state.categories.set(key, {
          id: node.id,
          name: node.name || node.slug || '',
          color: normalizeColor(node.color),
          textColor: normalizeColor(node.text_color || node.textColor),
          slug: node.slug || null,
          parentId,
          parentColor: null,
          parentTextColor: null,
          descriptionText: String(node.description_text || '').trim(),
        });
      }
    }
    const nextParent = isCategory ? node : parent;
    Object.keys(node).forEach((k) => {
      if (/categor/i.test(k)) absorbCategories(node[k], depth + 1, nextParent);
    });
  }

  const parseMaybeJson = (v) => {
    if (typeof v === 'string') {
      try {
        return JSON.parse(v);
      } catch (_) {
        return null;
      }
    }
    return v || null;
  };

  /** 从页面预加载数据（#data-preloaded）补充分类信息；整个页面只尝试一次 */
  function absorbPreloadedCategories() {
    if (state.preloadedAbsorbed) return;
    state.preloadedAbsorbed = true;
    try {
      const el = document.getElementById('data-preloaded');
      if (!el) return;
      const candidates = [el.textContent, el.getAttribute('data-preload-data')];
      let data = null;
      for (const src of candidates) {
        if (!src) continue;
        try {
          const parsed = JSON.parse(src);
          if (parsed && typeof parsed === 'object') {
            data = parsed;
            break;
          }
        } catch (_) {
          /* 换下一个来源 */
        }
      }
      if (!data) return;
      const site = parseMaybeJson(data.site);
      if (site) absorbCategories(site, 0);
    } catch (_) {
      /* 忽略 */
    }
  }

  /** 从页面现有分类标签采集分类信息（整个文档，不限推荐栏），并补齐父分类与悬浮描述 */
  function harvestCategoriesFromDom() {
    toArray(document.querySelectorAll('a.badge-category__wrapper')).forEach((wrap) => {
      const badge = wrap.querySelector('[data-category-id]');
      const id = badge && badge.getAttribute('data-category-id');
      if (!id) return;
      const parentColor = normalizeColor(
        wrap.style.getPropertyValue('--parent-category-badge-color')
      );
      const parentTextColor = normalizeColor(
        wrap.style.getPropertyValue('--parent-category-badge-text-color')
      );
      const parentIdAttr = badge.getAttribute('data-parent-category-id');
      const titleAttr = wrap.getAttribute('title') || (badge && badge.getAttribute('title')) || '';

      const existing = state.categories.get(id);
      if (existing) {
        if (!existing.parentColor && parentColor) existing.parentColor = parentColor;
        if (!existing.parentTextColor && parentTextColor)
          existing.parentTextColor = parentTextColor;
        if (existing.parentId == null && parentIdAttr != null)
          existing.parentId = Number(parentIdAttr);
        if (!existing.descriptionText && titleAttr) existing.descriptionText = titleAttr;
        return;
      }
      const nameEl = wrap.querySelector('.badge-category__name');
      const href = wrap.getAttribute('href') || '';
      const m = href.match(/\/c\/([^/]+)\/(\d+)/);
      state.categories.set(id, {
        id: Number(id),
        name: (nameEl && nameEl.textContent.trim()) || (badge.textContent || '').trim(),
        color: normalizeColor(wrap.style.getPropertyValue('--category-badge-color')),
        textColor: normalizeColor(wrap.style.getPropertyValue('--category-badge-text-color')),
        slug: m ? m[1] : null,
        parentId: parentIdAttr != null ? Number(parentIdAttr) : null,
        parentColor,
        parentTextColor,
        descriptionText: titleAttr,
      });
    });
  }

  /**
   * 汇总分类信息来源：预加载 → 页面现有标签 → /categories.json（带 include_subcategories，
   * 覆盖子分类）。请求成功才算完成；失败 30 秒后允许重试。
   */
  async function ensureCategories(ids) {
    absorbPreloadedCategories();
    harvestCategoriesFromDom();
    const missing = toArray(ids).filter((id) => id != null && !state.categories.has(String(id)));
    if (!missing.length) return;

    const now = Date.now();
    if (state.categoriesFetched || now - state.lastCategoriesErrorAt < 30000) return;

    try {
      const res = await fetch('/categories.json?include_subcategories=true', {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      absorbCategories(data, 0);
      state.categoriesFetched = true;
    } catch (err) {
      state.lastCategoriesErrorAt = now;
      log('分类接口请求失败（30 秒内不重试）：', err && err.message ? err.message : err);
    }
  }

  // ==================== 未读接口 ====================
  async function fetchUnreadTopics() {
    const now = Date.now();
    if (state.unreadCache.topics && now - state.unreadCache.at < CACHE_TTL_MS) {
      return state.unreadCache.topics;
    }
    if (state.unreadInflight) return state.unreadInflight;
    state.unreadInflight = (async () => {
      try {
        const res = await fetch('/unread.json', {
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const topics = (data && data.topic_list && data.topic_list.topics) || [];
        state.unreadCache = { at: Date.now(), topics };
        return topics;
      } catch (err) {
        const t = Date.now();
        if (t - state.lastFetchErrorLogAt > FETCH_ERROR_LOG_INTERVAL_MS) {
          state.lastFetchErrorLogAt = t;
          log('未读接口请求失败，本次仅做重排：', err && err.message ? err.message : err);
        }
        return [];
      } finally {
        state.unreadInflight = null;
      }
    })();
    return state.unreadInflight;
  }

  // ==================== 注入行构建 ====================
  function createUnreadBadge(id, topic) {
    const count = topic.unread_posts || topic.new_posts || 1;
    const a = document.createElement('a');
    a.className = 'badge badge-notification unread-posts';
    a.setAttribute('href', '/t/topic/' + id);
    a.setAttribute('data-topic-id', String(id));
    a.setAttribute('title', count + ' 个未读回复');
    a.textContent = String(count);
    return a;
  }

  function setCellText(cell, text) {
    if (!cell || text == null || text === '') return null;
    // 计数列理论上不放徽标；模板若带了，先清掉避免残留
    toArray(cell.querySelectorAll('.badge-notification')).forEach((b) => b.remove());
    const target = firstIn(cell, ['.posts', '.number', '.relative-date', 'span']) || cell;
    target.textContent = text;
    return target;
  }

  /**
   * 定位行内各数据列。优先按类名（.posts / .views / .activity 等），
   * 找不到时回退到标准列序（主链接之后依次为 回复 / 浏览量 / 活动）。
   */
  function findCells(row) {
    const tds = toArray(row.querySelectorAll('td'));
    const byClass = (tokens) => {
      for (const t of tokens) {
        const td = row.querySelector('td.' + t);
        if (td) return td;
      }
      for (const t of tokens) {
        const inner = row.querySelector('.' + t);
        if (inner && inner.closest('td')) return inner.closest('td');
      }
      return null;
    };
    return {
      posts: byClass(['posts']) || tds[1] || null,
      views: byClass(['views']) || tds[2] || null,
      activity: byClass(['activity', 'age', 'relative-date']) || tds[3] || null,
    };
  }

  function updateCategoryChip(row, topic) {
    const wrap = row.querySelector('a.badge-category__wrapper');
    if (!wrap) return;
    const info = topic.category_id != null ? state.categories.get(String(topic.category_id)) : null;
    if (!info) {
      wrap.remove();
      return;
    }
    if (info.slug) wrap.setAttribute('href', '/c/' + info.slug + '/' + info.id);

    // 一级分类（父分类）：用于徽标左半边的双色方块（核心 CSS：.--has-parent::before 渐变）
    const parent = info.parentId != null ? state.categories.get(String(info.parentId)) : null;
    const parentColor = (parent && parent.color) || info.parentColor || null;
    const parentTextColor = (parent && parent.textColor) || info.parentTextColor || null;
    const hasParent = !!parentColor;

    try {
      if (info.color) wrap.style.setProperty('--category-badge-color', '#' + info.color);
      if (info.textColor)
        wrap.style.setProperty('--category-badge-text-color', '#' + info.textColor);
      if (hasParent) {
        wrap.style.setProperty('--parent-category-badge-color', '#' + parentColor);
        if (parentTextColor)
          wrap.style.setProperty('--parent-category-badge-text-color', '#' + parentTextColor);
      } else {
        wrap.style.removeProperty('--parent-category-badge-color');
        wrap.style.removeProperty('--parent-category-badge-text-color');
      }
    } catch (_) {
      /* jsdom 等环境对自定义属性支持有限，忽略 */
    }

    const badge = wrap.querySelector('[data-category-id]') || wrap.querySelector('.badge-category');
    if (badge) {
      badge.setAttribute('data-category-id', String(info.id));
      if (badge.classList) badge.classList.toggle('--has-parent', hasParent);
      if (hasParent && info.parentId != null) {
        badge.setAttribute('data-parent-category-id', String(info.parentId));
      } else {
        badge.removeAttribute('data-parent-category-id');
      }
    }

    // 悬浮说明（站点在分类标签上使用 title 承载分类描述）：
    // 仅当模板带有 title 时同步为当前分类的描述，避免残留错误文本；无描述则清除
    const description = info.descriptionText || '';
    [wrap, badge].forEach((el) => {
      if (!el || !el.hasAttribute('title')) return;
      if (description) el.setAttribute('title', description);
      else el.removeAttribute('title');
    });
    const nameEl =
      wrap.querySelector('.badge-category__name') || wrap.querySelector('.badge-category');
    if (nameEl) nameEl.textContent = info.name || '';
    else wrap.textContent = info.name || '';
    if (info.slug) row.classList.add('category-' + info.slug);
  }

  // ==================== 表情（标题里的 :shortcode: → 表情图片） ====================
  /** 从页面已有的表情图片采集映射（复用站点精确的标签结构与类名） */
  function harvestEmojisFromDom() {
    toArray(document.querySelectorAll('img.emoji')).forEach((img) => {
      const code = img.getAttribute('title') || '';
      const url = img.getAttribute('src') || '';
      if (!/^:[A-Za-z0-9_+-]+:$/.test(code) || !url) return;
      const existing = state.emojis.get(code);
      if (!existing) state.emojis.set(code, { url, template: img });
      else if (!existing.template) existing.template = img;
    });
  }

  /** 吸收 /emojis.json 里的表情（按任意结构遍历 {name, url} 形状的对象） */
  function absorbEmojis(node, depth) {
    if (!node || depth > 5) return;
    if (Array.isArray(node)) {
      node.forEach((n) => absorbEmojis(n, depth + 1));
      return;
    }
    if (typeof node !== 'object') return;
    const name = node.name;
    const url = node.url || node.image_url;
    if (typeof name === 'string' && typeof url === 'string' && name && url) {
      const code = ':' + name.replace(/^:|:$/g, '') + ':';
      if (!state.emojis.has(code)) state.emojis.set(code, { url, template: null });
    }
    Object.keys(node).forEach((k) => absorbEmojis(node[k], depth + 1));
  }

  /** 为标题中出现的表情短代码补充数据（先查页面，再请求一次 /emojis.json） */
  async function ensureEmojis(titles) {
    harvestEmojisFromDom();
    const needed = new Set();
    toArray(titles).forEach((title) => {
      const re = /:([A-Za-z0-9_+-]+):/g;
      const text = String(title || '');
      let m;
      while ((m = re.exec(text)) !== null) needed.add(':' + m[1] + ':');
    });
    const missing = [...needed].filter((code) => !state.emojis.has(code));
    if (!missing.length) return;

    const now = Date.now();
    if (state.emojisFetched || now - state.lastEmojisErrorAt < 30000) return;
    try {
      const res = await fetch('/emojis.json', {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      absorbEmojis(data, 0);
      state.emojisFetched = true;
    } catch (err) {
      state.lastEmojisErrorAt = now;
      log('表情接口请求失败（无法解析的表情将按原文显示）：', err && err.message ? err.message : err);
    }
  }

  function buildEmojiImage(code, info) {
    const img = info.template ? info.template.cloneNode(false) : document.createElement('img');
    if (!info.template) {
      img.className = 'emoji';
      img.setAttribute('loading', 'lazy');
    }
    img.setAttribute('src', info.url);
    img.setAttribute('title', code);
    img.setAttribute('alt', code);
    return img;
  }

  /** 把纯文本里的 :shortcode:（已知表情）替换成表情图片，其余保持文本 */
  function appendTextWithEmojis(frag, text) {
    const str = String(text || '');
    const re = /:([A-Za-z0-9_+-]+):/g;
    let last = 0;
    let m;
    while ((m = re.exec(str)) !== null) {
      const code = ':' + m[1] + ':';
      const info = state.emojis.get(code);
      if (!info) continue;
      if (m.index > last) frag.appendChild(document.createTextNode(str.slice(last, m.index)));
      frag.appendChild(buildEmojiImage(code, info));
      last = m.index + code.length;
    }
    const rest = str.slice(last);
    if (rest) frag.appendChild(document.createTextNode(rest));
  }

  /**
   * 写入标题内容。核心的 fancy_title 可能内嵌表情图片标签（<img class="emoji">），
   * 自定义表情的 :shortcode: 则保留为文本——这里统一处理：DOMParser 解析实体、
   * 白名单保留站内图片，并把文本里的已知表情短代码渲染为表情图片，全程避免 innerHTML。
   */
  function setTitleContent(link, topic) {
    const raw = String(topic.fancy_title || topic.title || '');
    try {
      const doc = new DOMParser().parseFromString(raw, 'text/html');
      const frag = document.createDocumentFragment();
      toArray(doc.body.childNodes).forEach((node) => {
        if (node.nodeType === 3) {
          // 文本节点：把已知表情短代码渲染成图片
          appendTextWithEmojis(frag, node.nodeValue || '');
          return;
        }
        if (node.nodeName === 'IMG') {
          const src = node.getAttribute('src') || '';
          if (/^\//.test(src) || /^https:\/\/shuiyuan\.sjtu\.edu\.cn\//.test(src)) {
            const img = document.createElement('img');
            img.setAttribute('src', src);
            img.setAttribute('class', node.getAttribute('class') || 'emoji');
            const alt = node.getAttribute('alt');
            if (alt != null) img.setAttribute('alt', alt);
            const t = node.getAttribute('title');
            if (t != null) img.setAttribute('title', t);
            img.setAttribute('loading', 'lazy');
            frag.appendChild(img);
          }
          return;
        }
        // 其他元素只保留其文本内容（同样处理表情短代码）
        const text = node.textContent || '';
        if (text) appendTextWithEmojis(frag, text);
      });
      link.textContent = '';
      link.appendChild(frag);
    } catch (_) {
      link.textContent = String(topic.title || raw);
    }
  }

  /** 用现有行做模板克隆一条「未读」行（自动继承站点主题样式） */
  function buildRow(template, topic, selfTopicId) {
    const id = String(topic.id);
    const row = template.cloneNode(true);

    // 行状态：清掉模板话题的状态类与分类类，改成「未读」
    toArray(row.classList)
      .filter((c) => STATE_CLASSES.indexOf(c) !== -1 || c.indexOf('category-') === 0)
      .forEach((c) => row.classList.remove(c));
    row.classList.add(CLASS_UNREAD);
    row.setAttribute('data-topic-id', id);
    row.setAttribute('data-sy-injected', '1');
    if (selfTopicId) row.setAttribute('data-sy-topic', selfTopicId);

    // 状态图标区（置顶/书签等）清空
    const statuses = row.querySelector('.topic-statuses');
    if (statuses) statuses.textContent = '';

    // 模板话题的标签/摘要不适用于新话题：先移除，标签稍后按 topic.tags 重建
    toArray(row.querySelectorAll('.discourse-tags, .discourse-tag')).forEach((el) => el.remove());
    toArray(row.querySelectorAll('.topic-excerpt')).forEach((el) => el.remove());

    // 标题与链接（站点现行样式 /t/topic/<id>，不带 slug）
    const link = firstIn(row, ['a.title.raw-topic-link', 'a.title']);
    if (link) {
      link.setAttribute('href', '/t/topic/' + id);
      link.setAttribute('data-topic-id', id);
      setTitleContent(link, topic);
    }

    // 未读数字徽标（复用 .topic-post-badges 结构）
    let badges = row.querySelector('.topic-post-badges');
    if (!badges) {
      badges = document.createElement('span');
      badges.className = 'topic-post-badges';
      (row.querySelector('.link-top-line') || row).appendChild(badges);
    }
    badges.textContent = '';
    badges.appendChild(document.createTextNode('\u00a0'));
    badges.appendChild(createUnreadBadge(id, topic));

    // 回复数 / 浏览量 / 活动时间（优先按类名找单元格，退化时按标准列序）
    const cells = findCells(row);
    const replies =
      topic.reply_count != null
        ? topic.reply_count
        : topic.posts_count != null
          ? Math.max(0, topic.posts_count - 1)
          : null;
    if (replies != null) setCellText(cells.posts, String(replies));
    if (topic.views != null) setCellText(cells.views, formatCount(topic.views));

    const ageCell = cells.activity;
    const bumped = topic.bumped_at || topic.last_posted_at;
    if (ageCell && bumped) {
      const target = setCellText(ageCell, formatRelative(bumped));
      if (target) {
        try {
          target.setAttribute('title', new Date(bumped).toLocaleString('zh-CN'));
        } catch (_) {
          /* 忽略 */
        }
      }
    }

    // 分类标签与话题标签
    updateCategoryChip(row, topic);
    buildTagElements(row, topic);

    return row;
  }

  /** 用页面现有标签结构生成注入行的话题标签（保持站点样式与配色） */
  function buildTagElements(row, topic) {
    const tags = Array.isArray(topic.tags)
      ? topic.tags.map((t) => (typeof t === 'string' ? t : t && t.name)).filter(Boolean)
      : [];
    if (!tags.length) return;
    const bottom = row.querySelector('.link-bottom-line');
    if (!bottom) return;

    // 容器结构：优先复用页面中已有的标签容器（继承站点类名）
    const existingContainer = document.querySelector('#suggested-topics .discourse-tags');
    let container;
    if (existingContainer) {
      container = existingContainer.cloneNode(true);
      container.textContent = '';
    } else {
      container = document.createElement('div');
      container.className = 'discourse-tags';
    }

    // 锚点模板：优先同名标签（配色/类名完全一致），否则任意标签
    let anchors = toArray(document.querySelectorAll('#suggested-topics a.discourse-tag'));
    if (!anchors.length) anchors = toArray(document.querySelectorAll('a.discourse-tag'));

    tags.forEach((tag) => {
      const same = anchors.find((a) => (a.textContent || '').trim() === tag);
      const tpl = same || anchors[0] || null;
      const anchor = tpl ? tpl.cloneNode(true) : document.createElement('a');
      if (!tpl) anchor.className = 'discourse-tag';
      anchor.textContent = tag;
      anchor.setAttribute('href', '/tag/' + encodeURIComponent(tag));
      if (!same) anchor.removeAttribute('title'); // 避免残留其他标签的悬浮说明
      container.appendChild(anchor);
    });

    const chip = row.querySelector('a.badge-category__wrapper');
    if (chip) chip.insertAdjacentElement('afterend', container);
    else bottom.appendChild(container);
  }

  // ==================== 排序与可见性 ====================
  /**
   * 稳定排序：未读(A) → 未点开(B) → 其他(C)；只显示前 MAX_ITEMS 条。
   * 幂等：当前顺序与可见性已符合目标时，零 DOM 修改（防止观察者自循环）。
   */
  function applyOrderAndVisibility(tbody, rows) {
    const decorated = rows.map((row, index) => ({ row, rank: rankOf(row), index }));
    decorated.sort((a, b) => a.rank - b.rank || a.index - b.index);
    const desired = decorated.map((d) => d.row);
    const visibleCount = Math.min(MAX_ITEMS, desired.length);

    // 幂等检查（顺序）
    const current = topicRows(tbody);
    let same = current.length === desired.length;
    if (same) {
      for (let i = 0; i < desired.length; i++) {
        if (current[i] !== desired[i]) {
          same = false;
          break;
        }
      }
    }
    // 幂等检查（可见性）
    if (same) {
      for (let i = 0; i < desired.length; i++) {
        const shouldHide = i >= visibleCount;
        if ((desired[i].style.display === 'none') !== shouldHide) {
          same = false;
          break;
        }
      }
    }
    if (same) return;

    // 应用顺序
    for (let i = 0; i < desired.length; i++) {
      const row = desired[i];
      const at = tbody.children[i];
      if (at !== row) tbody.insertBefore(row, at || null);
    }
    // 应用可见性
    for (let i = 0; i < desired.length; i++) {
      desired[i].style.display = i < visibleCount ? '' : 'none';
    }
  }

  /** 不足 5 条未读时，用 /unread.json 补位（插入到现有未读行之后） */
  async function topUp(container, tbody, rows, unreadCount, selfTopicId) {
    const need = UNREAD_TARGET - unreadCount;
    if (need <= 0) return false;

    const topics = await fetchUnreadTopics();
    if (!topics.length) return false;

    const existing = new Set(rows.map(rowTopicId));
    const picks = topics
      .filter((t) => {
        const id = String(t.id);
        return !existing.has(id) && (!selfTopicId || id !== selfTopicId);
      })
      .slice(0, need);
    if (!picks.length) return false;

    await ensureEmojis(picks.map((t) => t.title || t.fancy_title || ''));
    await ensureCategories(picks.map((t) => t.category_id));
    const unresolved = picks.filter(
      (t) => t.category_id == null || !state.categories.has(String(t.category_id))
    ).length;
    if (unresolved) log('有 ' + unresolved + ' 条注入行缺少分类信息（将不显示分类标签）');

    const template = rows.find(isUnseenRow) || rows.find(isUnreadRow) || rows[0];
    if (!template) return false;

    const lastUnread = rows.filter(isUnreadRow).pop() || null;
    const reference = lastUnread ? lastUnread.nextSibling : tbody.firstChild;
    const fragment = document.createDocumentFragment();
    picks.forEach((t) => fragment.appendChild(buildRow(template, t, selfTopicId)));
    tbody.insertBefore(fragment, reference);
    log('已注入 ' + picks.length + ' 条未读话题');
    return true;
  }

  // ==================== 主流程 ====================
  async function applyUnreadFirst() {
    const container = document.querySelector(SEL_CONTAINER);
    if (!container) return; // 非话题页 / 尚未渲染
    if (!recommendedTabActive(container)) return; // 切到了「相关」或无法判定

    const tbody = container.querySelector(SEL_TBODY) || container.querySelector('tbody');
    if (!tbody) return;

    const selfTopicId = currentTopicId();

    // 清理：上一话题遗留的注入行 / 与真实行重复的注入行
    const injected = [];
    const realIds = new Set();
    topicRows(tbody).forEach((row) => {
      if (row.hasAttribute('data-sy-injected')) injected.push(row);
      else realIds.add(rowTopicId(row));
    });
    injected.forEach((row) => {
      const stale = selfTopicId && row.getAttribute('data-sy-topic') !== selfTopicId;
      const duplicate = realIds.has(rowTopicId(row));
      if (stale || duplicate) row.remove();
    });

    let rows = topicRows(tbody);
    if (!rows.length) return;

    // 不足 5 条未读：从未读接口补位（失败静默，仅跳过补位）
    const unreadCount = rows.filter(isUnreadRow).length;
    if (unreadCount < UNREAD_TARGET) {
      const injectedNow = await topUp(container, tbody, rows, unreadCount, selfTopicId);
      if (injectedNow) rows = topicRows(tbody);
    }

    applyOrderAndVisibility(tbody, rows);
  }

  // ==================== 调度（MutationObserver + 防抖 + 幂等） ====================
  function schedule() {
    if (state.autoPaused) return;
    if (state.running) {
      state.pending = true;
      return;
    }
    if (state.scheduled) return;
    state.scheduled = true;
    defer(() => {
      state.scheduled = false;
      if (state.autoPaused) return;
      state.running = true;
      Promise.resolve()
        .then(applyUnreadFirst)
        .catch((err) => log('处理异常：', err && err.message ? err.message : err))
        .then(() => {
          state.running = false;
          if (state.pending && !state.autoPaused) {
            state.pending = false;
            schedule();
          }
        });
    });
  }

  function start() {
    if (!document.body) return;
    const observer = new MutationObserver(() => schedule());
    observer.observe(document.body, { childList: true, subtree: true });
    schedule();
  }

  // 测试钩子（content script 运行在隔离世界，真实站点上不会暴露给页面脚本）
  window.__syUf = {
    apply: applyUnreadFirst,
    resetCache() {
      state.unreadCache = { at: 0, topics: null };
      state.unreadInflight = null;
      state.categoriesFetched = false;
      state.lastCategoriesErrorAt = 0;
      state.emojisFetched = false;
      state.lastEmojisErrorAt = 0;
      state.preloadedAbsorbed = false;
    },
    pause() {
      state.autoPaused = true;
    },
    resume() {
      state.autoPaused = false;
      schedule();
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
