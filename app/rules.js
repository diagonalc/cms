/**
 * 采集规则引擎（零第三方依赖）
 *
 * 支持三种文档：
 * - json：JSONPath 子集，如 $.info.rows[*]、$.vod_name、$['data'][0]
 * - xml：把 XML 当 HTML 一样解析，用 XPath 子集
 * - xpath：抓 HTML 页面，用 XPath 子集
 *
 * XPath 支持：
 * - //div、.//a、/html/body/div、./text()
 * - [@class="x"]、[contains(@class,"x")]、[1]、[last()]
 * - @href、@src、text()
 * 不支持：递归 ..、following-sibling、not()、条件过滤、数组切片等。
 */

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const RAW_TAGS = new Set(['script', 'style']);

function decodeEntities(text) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  };
  return String(text || '').replace(
    /&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]+));/gi,
    (match, hex, dec, name) => {
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      if (dec) return String.fromCodePoint(Number.parseInt(dec, 10));
      const val = named[String(name).toLowerCase()];
      return val === undefined ? match : val;
    }
  );
}

/* =========================================================
 * HTTP
 * ======================================================= */

async function fetchContent(url, method = 'GET', headers = {}, body = '') {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    throw new Error('采集地址必须以 http:// 或 https:// 开头');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      method: String(method || 'GET').toUpperCase(),
      headers: { 'User-Agent': DEFAULT_UA, ...(headers || {}) },
      body: String(method || 'GET').toUpperCase() === 'POST' ? body : undefined,
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`资源站返回 HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把 @keyword / @source / @page 等占位符替换进 URL。
 * 默认 URL 编码；@sourceRaw / @keywordRaw 等 Raw 变体不编码，
 * 适合把值拼进 URL 路径（例如 http://site.com@sourceRaw）。
 */
function buildUrl(template, vars = {}) {
  return String(template || '').replace(/@(\w+)/g, (match, key) => {
    if (key.endsWith('Raw')) {
      const base = key.slice(0, -3);
      if (base in vars) return String(vars[base] ?? '');
      return match;
    }
    if (!(key in vars)) return match;
    return encodeURIComponent(vars[key] ?? '');
  });
}

/* =========================================================
 * JSONPath 子集
 * ======================================================= */

function tokenizeJsonPath(path) {
  const p = String(path || '').trim();
  if (!p.startsWith('$')) throw new Error(`JSONPath 必须以 $ 开头：${p}`);

  const tokens = [];
  let i = 1;
  while (i < p.length) {
    if (p[i] === '.') {
      i++;
      const start = i;
      while (i < p.length && /[\w-]/.test(p[i])) i++;
      if (start === i) throw new Error(`JSONPath 字段名为空：${p}`);
      tokens.push({ type: 'field', name: p.slice(start, i) });
    } else if (p[i] === '[') {
      const end = p.indexOf(']', i + 1);
      if (end === -1) throw new Error(`JSONPath 缺少 ]：${p}`);
      const inner = p.slice(i + 1, end).trim();
      if (inner === '*') tokens.push({ type: 'wildcard' });
      else if (/^\d+$/.test(inner)) tokens.push({ type: 'index', index: Number(inner) });
      else if (/^(['"]).*\1$/.test(inner)) tokens.push({ type: 'field', name: inner.slice(1, -1) });
      else throw new Error(`不支持的 JSONPath 片段：[${inner}]`);
      i = end + 1;
    } else {
      throw new Error(`不支持的 JSONPath：${p.slice(i)}`);
    }
  }
  return tokens;
}

function selectJson(data, path) {
  let current = [data];
  for (const token of tokenizeJsonPath(path)) {
    const next = [];
    for (const item of current) {
      if (token.type === 'field') {
        if (item && typeof item === 'object' && !Array.isArray(item) && token.name in item) {
          next.push(item[token.name]);
        }
      } else if (token.type === 'index') {
        if (Array.isArray(item) && item[token.index] !== undefined) {
          next.push(item[token.index]);
        }
      } else if (token.type === 'wildcard') {
        if (Array.isArray(item)) next.push(...item);
        else if (item && typeof item === 'object') next.push(...Object.values(item));
      }
    }
    current = next;
  }
  return current;
}

/* =========================================================
 * HTML/XML 解析
 * ======================================================= */

function createElement(tag, attrs, parent) {
  return { type: 'element', tag, attrs, children: [], parent };
}

function createText(text, parent) {
  return { type: 'text', text, parent };
}

function parseAttrs(text) {
  const attrs = {};
  const re = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const name = m[1].toLowerCase();
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function appendText(parent, raw) {
  const text = decodeEntities(raw);
  if (!text) return;
  parent.children.push(createText(text, parent));
}

/**
 * 宽容的 HTML/XML 解析器：不要求标签闭合，适合抓网页。
 * 生成节点：{ type:'element', tag, attrs, children, parent }
 *          { type:'text', text, parent }
 */
function parseHtml(html) {
  const root = createElement('#document', {}, null);
  const stack = [root];
  const src = String(html || '');
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      appendText(stack[stack.length - 1], src.slice(i));
      break;
    }
    if (lt > i) appendText(stack[stack.length - 1], src.slice(i, lt));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }

    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const content = end === -1 ? src.slice(lt + 9) : src.slice(lt + 9, end);
      if (content) stack[stack.length - 1].children.push(createText(content, stack[stack.length - 1]));
      i = end === -1 ? src.length : end + 3;
      continue;
    }

    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const end = src.indexOf('>', lt);
      i = end === -1 ? src.length : end + 1;
      continue;
    }

    const closeMatch = /^<\/\s*([a-zA-Z][\w:-]*)\s*>/.exec(src.slice(lt));
    if (closeMatch) {
      const tag = closeMatch[1].toLowerCase();
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k].tag === tag) {
          stack.length = k;
          break;
        }
      }
      i = lt + closeMatch[0].length;
      continue;
    }

    const openMatch = /^<([a-zA-Z][\w:-]*)((?:\s+[^<>]*?)?)\s*(\/?)>/.exec(src.slice(lt));
    if (!openMatch) {
      appendText(stack[stack.length - 1], '<');
      i = lt + 1;
      continue;
    }

    const tag = openMatch[1].toLowerCase();
    const attrs = parseAttrs(openMatch[2]);
    const selfClosing = openMatch[3] === '/';
    const parent = stack[stack.length - 1];
    const el = createElement(tag, attrs, parent);
    parent.children.push(el);
    i = lt + openMatch[0].length;

    if (selfClosing || VOID_TAGS.has(tag)) continue;

    if (RAW_TAGS.has(tag)) {
      const closeRe = new RegExp(`</\\s*${tag}\\s*>`, 'i');
      const rest = src.slice(i);
      const m = closeRe.exec(rest);
      if (m) {
        const content = rest.slice(0, m.index);
        if (content) el.children.push(createText(content, el));
        i += m.index + m[0].length;
      } else {
        if (rest) el.children.push(createText(rest, el));
        i = src.length;
      }
      continue;
    }

    stack.push(el);
  }

  return root;
}

function nodeText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text;
  return (node.children || []).map(nodeText).join('');
}

function descendants(node, out = []) {
  for (const child of node.children || []) {
    if (child.type === 'element') {
      out.push(child);
      descendants(child, out);
    }
  }
  return out;
}

function descendantTextNodes(node, out = []) {
  for (const child of node.children || []) {
    if (child.type === 'text') out.push(child);
    else if (child.type === 'element') descendantTextNodes(child, out);
  }
  return out;
}

/* =========================================================
 * XPath 子集
 * ======================================================= */

function parseXPathStep(expr) {
  const raw = String(expr || '').trim();
  if (raw === '.' || raw === '') return { kind: 'self' };
  if (raw === 'text()') return { kind: 'text' };
  if (raw.startsWith('@')) return { kind: 'attr', name: raw.slice(1).trim() };

  const tagMatch = /^([^\[]+)/.exec(raw);
  const tag = (tagMatch ? tagMatch[1] : raw).trim().toLowerCase();
  const predicates = [];
  const predRe = /\[([^\]]+)\]/g;
  let m;
  while ((m = predRe.exec(raw))) predicates.push(m[1].trim());
  return { kind: 'element', tag, predicates };
}

function parseXPath(expr) {
  let e = String(expr || '').trim();
  let startAxis = 'child';

  if (e.startsWith('.//')) { startAxis = 'descendant'; e = e.slice(3); }
  else if (e.startsWith('//')) { startAxis = 'descendant'; e = e.slice(2); }
  else if (e.startsWith('./')) { startAxis = 'child'; e = e.slice(2); }
  else if (e.startsWith('/')) { startAxis = 'child'; e = e.slice(1); }
  else if (e.startsWith('.')) { startAxis = 'self'; e = e.slice(1); }

  const parts = e.split(/(\/\/|\/)/);
  const steps = [];
  let axis = startAxis;

  for (const part of parts) {
    if (!part) continue;
    if (part === '//') { axis = 'descendant'; continue; }
    if (part === '/') { axis = 'child'; continue; }
    steps.push({ axis, ...parseXPathStep(part) });
    axis = 'child';
  }

  return steps;
}

function applyPredicate(nodes, predicate) {
  const pred = String(predicate || '').trim();

  if (/^\d+$/.test(pred)) {
    const n = Number(pred);
    return nodes[n - 1] ? [nodes[n - 1]] : [];
  }
  if (pred === 'last()') {
    return nodes.length ? [nodes[nodes.length - 1]] : [];
  }

  let m = /^@([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')$/.exec(pred);
  if (m) {
    const value = m[2] ?? m[3];
    return nodes.filter((n) => n.attrs && n.attrs[m[1]] === value);
  }

  m = /^contains\(\s*@([\w:-]+)\s*,\s*(?:"([^"]*)"|'([^']*)')\s*\)$/.exec(pred);
  if (m) {
    const value = m[2] ?? m[3];
    return nodes.filter((n) => String((n.attrs || {})[m[1]] || '').includes(value));
  }

  m = /^@([\w:-]+)$/.exec(pred);
  if (m) {
    return nodes.filter((n) => n.attrs && Object.prototype.hasOwnProperty.call(n.attrs, m[1]));
  }

  m = /^text\(\)\s*=\s*(?:"([^"]*)"|'([^']*)')$/.exec(pred);
  if (m) {
    const value = m[1] ?? m[2];
    return nodes.filter((n) => nodeText(n).trim() === value);
  }

  throw new Error(`不支持的 XPath 谓词：[${pred}]`);
}

/**
 * 返回 { kind:'node'|'text'|'attr', node?/text?/value? } 列表。
 */
function xpathSelect(root, expr, context = null) {
  const steps = parseXPath(expr);
  let current = [{ kind: 'node', node: context || root }];

  for (const step of steps) {
    const next = [];

    for (const item of current) {
      if (item.kind !== 'node') continue;
      const node = item.node;

      if (step.kind === 'self') {
        next.push({ kind: 'node', node });
        continue;
      }

      if (step.kind === 'text') {
        if (step.axis === 'descendant') {
          for (const t of descendantTextNodes(node)) next.push({ kind: 'text', text: t.text });
        } else {
          for (const child of node.children || []) {
            if (child.type === 'text') next.push({ kind: 'text', text: child.text });
          }
        }
        continue;
      }

      if (step.kind === 'attr') {
        // a/@href 取的是 a 自己的属性；//@href 才向下找所有后代
        const candidates = step.axis === 'descendant'
          ? [node, ...descendants(node)]
          : [node];
        for (const c of candidates) {
          if (c.type === 'element' && c.attrs && Object.prototype.hasOwnProperty.call(c.attrs, step.name)) {
            next.push({ kind: 'attr', value: c.attrs[step.name] });
          }
        }
        continue;
      }

      const candidates = step.axis === 'descendant'
        ? [node, ...descendants(node)]
        : (node.children || []).filter((c) => c.type === 'element');

      let matched = candidates.filter(
        (c) => c.type === 'element' && (step.tag === '*' || c.tag === step.tag)
      );
      for (const pred of step.predicates) matched = applyPredicate(matched, pred);
      for (const c of matched) next.push({ kind: 'node', node: c });
    }

    current = next;
    if (!current.length) break;
  }

  return current;
}

function xpathValues(root, expr, context = null) {
  return xpathSelect(root, expr, context).map((item) => {
    if (item.kind === 'text') return item.text.trim();
    if (item.kind === 'attr') return String(item.value || '').trim();
    return nodeText(item.node).trim();
  });
}

function xpathElements(root, expr, context = null) {
  return xpathSelect(root, expr, context)
    .filter((item) => item.kind === 'node')
    .map((item) => item.node);
}

/* =========================================================
 * 统一提取接口
 * ======================================================= */

function parseDocument(type, text) {
  if (type === 'json') {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('规则类型是 JSON，但返回内容不是 JSON');
    }
  }
  return parseHtml(text);
}

function normalizeJsonPath(path) {
  const p = String(path || '').trim();
  if (!p) return p;
  return p.startsWith('.') ? `$${p}` : p;
}

function extractValues(type, doc, path, context = null) {
  if (!path) return [];
  if (type === 'json') {
    return selectJson(context || doc, normalizeJsonPath(path));
  }
  return xpathValues(doc, path, context);
}

function extractValue(type, doc, path, context = null) {
  const values = extractValues(type, doc, path, context);
  return values.length ? values[0] : '';
}

/** 把多个匹配结果拼成一个字符串（例如 //div//text() 会得到多段文本）。 */
function extractText(type, doc, path, context = null, join = '') {
  return extractValues(type, doc, path, context).join(join);
}

function extractList(type, doc, path, context = null) {
  if (!path) return [];
  if (type === 'json') {
    return selectJson(context || doc, normalizeJsonPath(path));
  }
  return xpathElements(doc, path, context);
}

module.exports = {
  fetchContent,
  buildUrl,
  parseHtml,
  parseDocument,
  nodeText,
  selectJson,
  xpathSelect,
  xpathValues,
  xpathElements,
  extractValues,
  extractValue,
  extractText,
  extractList,
};
