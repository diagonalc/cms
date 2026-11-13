const fs = require('node:fs');
const path = require('node:path');
const { Vod, Type } = require('./models');
const helpers = require('./helpers');

const VIEW_DIR = path.join(__dirname, 'views');
const fileCache = new Map();

/**
 * 极简模板引擎，支持的语法：
 *   {$obj.vod_name}                       输出变量（自动 HTML 转义）
 *   {:mac_url_vod_detail($vo)}             输出表达式（不转义）
 *   {foreach $obj.play_list as $line}...{/foreach}
 *   {if $obj.vod_id}...{else}...{/if}
 *   {maccms:vod num="12" type="1"}...{/maccms:vod}
 *   {maccms:type parent="0"}...{/maccms:type}
 *   {include file="partials/header"}
 *
 * 它对应苹果CMS的 taglib：把标签编译成 PHP/JS 查询 + 循环。
 */

function readView(name) {
  const clean = String(name || '').replace(/\.html$/, '');
  if (clean.includes('..') || path.isAbsolute(clean)) throw new Error('非法模板名');
  const file = path.join(VIEW_DIR, `${clean}.html`);
  if (!file.startsWith(VIEW_DIR)) throw new Error('非法模板路径');
  return { file, source: fs.readFileSync(file, 'utf8') };
}

function parseAttrs(text) {
  const attrs = {};
  const re = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  let m;
  while ((m = re.exec(text))) {
    attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

/**
 * 解析模板为节点树。
 * stops：当前层期待的结束标签，例如 ['maccms:vod']。
 */
function parseNodes(source, start, stops, fileName, includeStack) {
  const nodes = [];
  let pos = start;

  while (pos < source.length) {
    const open = source.indexOf('{', pos);
    if (open === -1) {
      nodes.push({ type: 'text', value: source.slice(pos) });
      break;
    }
    if (open > pos) nodes.push({ type: 'text', value: source.slice(pos, open) });

    const close = source.indexOf('}', open + 1);
    if (close === -1) {
      nodes.push({ type: 'text', value: source.slice(open) });
      break;
    }

    const rawTag = source.slice(open + 1, close).trim();
    pos = close + 1;

    // 结束标签
    if (rawTag.startsWith('/')) {
      const name = rawTag.slice(1).trim();
      if (stops.includes(name)) return { nodes, pos, stop: name };
      // 未知的 } 可能是 CSS/JS，原样保留左花括号，继续扫描
      nodes.push({ type: 'text', value: '{' });
      pos = open + 1;
      continue;
    }

    // else：交给 if 块处理
    if (rawTag === 'else') {
      if (stops.includes('if')) return { nodes, pos, stop: 'else' };
      nodes.push({ type: 'text', value: '{' });
      pos = open + 1;
      continue;
    }

    // 变量输出（保留 $，交给 toJsExpr 按作用域转换）
    if (rawTag.startsWith('$')) {
      nodes.push({ type: 'var', expr: rawTag });
      continue;
    }

    // 表达式原样输出
    if (rawTag.startsWith(':')) {
      nodes.push({ type: 'raw', expr: rawTag.slice(1) });
      continue;
    }

    // include
    if (rawTag.startsWith('include ')) {
      const attrs = parseAttrs(rawTag.slice('include '.length));
      const incName = attrs.file;
      if (!incName) {
        nodes.push({ type: 'text', value: '[include 缺少 file]' });
        continue;
      }
      const inc = readView(incName);
      const key = path.resolve(inc.file);
      if (includeStack.includes(key)) {
        nodes.push({ type: 'text', value: `[循环 include: ${incName}]` });
        continue;
      }
      const parsed = parseNodes(inc.source, 0, [], IncName(incName), [...includeStack, key]);
      nodes.push(...parsed.nodes);
      continue;
    }

    // {maccms:vod} / {maccms:type}
    if (rawTag.startsWith('maccms:vod') || rawTag.startsWith('maccms:type')) {
      const isVod = rawTag.startsWith('maccms:vod');
      const tagName = isVod ? 'maccms:vod' : 'maccms:type';
      const attrsText = rawTag.slice(tagName.length).trim();
      const attrs = parseAttrs(attrsText);
      const inner = parseNodes(source, pos, [tagName], fileName, includeStack);
      if (!inner.stop) throw new Error(`模板 ${fileName}：<${tagName}> 未闭合`);
      nodes.push({ type: isVod ? 'vod' : 'type', attrs, children: inner.nodes });
      pos = inner.pos;
      continue;
    }

    // {foreach $list as $item}
    if (rawTag.startsWith('foreach ')) {
      const expr = rawTag.slice('foreach '.length).trim();
      const inner = parseNodes(source, pos, ['foreach'], fileName, includeStack);
      if (!inner.stop) throw new Error(`模板 ${fileName}：<foreach> 未闭合`);
      nodes.push({ type: 'foreach', expr, children: inner.nodes });
      pos = inner.pos;
      continue;
    }

    // {if expr} ... {else} ... {/if}
    if (rawTag.startsWith('if ')) {
      const cond = rawTag.slice('if '.length).trim();
      const inner = parseNodes(source, pos, ['if'], fileName, includeStack);
      if (!inner.stop) throw new Error(`模板 ${fileName}：<if> 未闭合`);

      let elseNodes = null;
      let endPos = inner.pos;
      if (inner.stop === 'else') {
        const elsePart = parseNodes(source, inner.pos, ['if'], fileName, includeStack);
        if (!elsePart.stop) throw new Error(`模板 ${fileName}：<if> 缺少 {/if}`);
        elseNodes = elsePart.nodes;
        endPos = elsePart.pos;
      }

      nodes.push({ type: 'if', cond, children: inner.nodes, elseChildren: elseNodes });
      pos = endPos;
      continue;
    }

    // 未知标签：只输出左花括号，继续扫描，避免破坏 CSS/JS
    nodes.push({ type: 'text', value: '{' });
    pos = open + 1;
  }

  return { nodes, pos, stop: null };
}

function IncName(name) {
  return String(name || '').replace(/\.html$/, '');
}

/**
 * 把 $obj.vod_name / $vo.name 转成 JS 表达式。
 * scope 里是当前可见的局部变量（循环变量），其余 $xxx 从 data.xxx 取。
 */
function toJsExpr(expr, scope) {
  return String(expr || '')
    .trim()
    .replace(/\$([a-zA-Z_]\w*)((?:\.[a-zA-Z_]\w*)*)/g, (_, name, rest) => {
      const base = scope.has(name) ? name : `data.${name}`;
      return base + rest;
    });
}

function compileNodes(nodes, fileName, scope) {
  let code = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      code += `out += ${JSON.stringify(node.value)};\n`;
    } else if (node.type === 'var') {
      code += `out += esc(${toJsExpr(node.expr, scope)});\n`;
    } else if (node.type === 'raw') {
      code += `out += (${toJsExpr(node.expr, scope)} ?? '');\n`;
    } else if (node.type === 'vod' || node.type === 'type') {
      const model = node.type === 'vod' ? 'Vod' : 'Type';
      const varName = node.attrs.id || (node.type === 'vod' ? 'vo' : 'type');
      const attrs = JSON.stringify(node.attrs);
      const innerScope = new Set(scope);
      innerScope.add(varName);
      code += `for (const ${varName} of ${model}.list(${attrs})) {\n`;
      code += compileNodes(node.children, fileName, innerScope);
      code += '}\n';
    } else if (node.type === 'foreach') {
      const m = /^\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)\s+as\s+\$([a-zA-Z_]\w*)$/.exec(node.expr);
      if (!m) throw new Error(`模板 ${fileName}：foreach 语法错误，应为 {foreach $list as $item}`);
      const listExpr = toJsExpr(`$${m[1]}`, scope);
      const innerScope = new Set(scope);
      innerScope.add(m[2]);
      code += `for (const ${m[2]} of (${listExpr} || [])) {\n`;
      code += compileNodes(node.children, fileName, innerScope);
      code += '}\n';
    } else if (node.type === 'if') {
      code += `if (${toJsExpr(node.cond, scope)}) {\n`;
      code += compileNodes(node.children, fileName, scope);
      code += '}';
      if (node.elseChildren) {
        code += ' else {\n';
        code += compileNodes(node.elseChildren, fileName, scope);
        code += '}\n';
      } else {
        code += '\n';
      }
    }
  }
  return code;
}

function buildFunction(name, source, fileName) {
  const parsed = parseNodes(source, 0, [], fileName, [path.resolve(fileName)]);
  const scope = new Set(['obj', 'param', 'maccms', 'user']);
  const body = compileNodes(parsed.nodes, fileName, scope);
  const code = `
    const obj = data.obj || {};
    const param = data.param || {};
    const maccms = data.maccms || {};
    const user = data.user || {};
    const {
      esc, formatDate, formatDateTime, pageNumbers, pageUrl,
      mac_url_type, mac_url_vod_detail, mac_url_vod_play, mac_url_search
    } = helpers;
    let out = '';
    ${body}
    return out;
  `;
  return new Function('data', 'helpers', 'Vod', 'Type', code);
}

function getCompiled(name) {
  const { file, source } = readView(name);
  const stat = fs.statSync(file);
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.fn;

  const fn = buildFunction(name, source, file);
  fileCache.set(file, { mtimeMs: stat.mtimeMs, fn });
  return fn;
}

function render(name, data = {}) {
  const fn = getCompiled(name);
  return fn(data, helpers, Vod, Type);
}

function clearCache() {
  fileCache.clear();
}

module.exports = { render, clearCache };
