const assert = require('node:assert');
const R = require('../app/rules');

/* ---------- JSONPath ---------- */
const json = {
  info: {
    total: 2,
    rows: [
      { vod_id: 1, vod_name: 'JSON一', vod_play_from: 'm3u8', vod_play_url: '第1集$https://a/1.m3u8' },
      { vod_id: 2, vod_name: 'JSON二', vod_play_from: 'm3u8' },
    ],
  },
};

assert.equal(R.extractList('json', json, '$.info.rows[*]').length, 2);
assert.equal(R.extractValue('json', json, '$.info.rows[0].vod_name'), 'JSON一');
assert.equal(R.extractValue('json', json, "$['info']['rows'][1]['vod_name']"), 'JSON二');
assert.equal(R.extractValue('json', json.info.rows[0], '$.vod_play_url'), '第1集$https://a/1.m3u8');

/* ---------- HTML + XPath ---------- */
const html = `<!doctype html>
<html><body>
  <div class="list">
    <div class="item"><a href="/detail/1"><h3>XPath一</h3></a></div>
    <div class="item"><a href="/detail/2"><h3>XPath二</h3></a></div>
  </div>
  <h1>XPath一</h1>
  <img class="cover" src="https://img/1.jpg">
  <span class="actor">演员A</span>
  <div class="desc">第一段<br>第二段</div>
  <div class="line" data-from="m3u8">
    <a href="https://a/1.m3u8">第1集</a>
    <a href="https://a/2.m3u8">第2集</a>
  </div>
</body></html>`;

const doc = R.parseDocument('xpath', html);
const items = R.extractList('xpath', doc, '//div[contains(@class,"item")]');
assert.equal(items.length, 2);
assert.equal(R.extractValue('xpath', doc, './/h3/text()', items[0]), 'XPath一');
assert.equal(R.extractValue('xpath', doc, './a/@href', items[0]), '/detail/1');

assert.equal(R.extractValue('xpath', doc, '//h1/text()'), 'XPath一');
assert.equal(R.extractValue('xpath', doc, '//img[@class="cover"]/@src'), 'https://img/1.jpg');
assert.equal(R.extractValue('xpath', doc, '//span[contains(@class,"actor")]/text()'), '演员A');
assert.equal(R.extractText('xpath', doc, '//div[@class="desc"]//text()'), '第一段第二段');

const groups = R.extractList('xpath', doc, '//div[@class="line"]');
assert.equal(groups.length, 1);
assert.equal(R.extractValue('xpath', doc, './@data-from', groups[0]), 'm3u8');
const eps = R.extractList('xpath', doc, './/a', groups[0]);
assert.equal(eps.length, 2);
assert.equal(R.extractValue('xpath', doc, './text()', eps[0]), '第1集');
assert.equal(R.extractValue('xpath', doc, './@href', eps[1]), 'https://a/2.m3u8');

/* ---------- XML + XPath ---------- */
const xml = `<?xml version="1.0"?>
<rss><list>
  <video><id>1</id><name><![CDATA[XML一]]></name><pic>https://img/x.jpg</pic>
    <dl><dd flag="m3u8"><![CDATA[第1集$https://x/1.m3u8#第2集$https://x/2.m3u8]]></dd></dl>
  </video>
</list></rss>`;
const xdoc = R.parseDocument('xml', xml);
const videos = R.extractList('xml', xdoc, '//video');
assert.equal(videos.length, 1);
assert.equal(R.extractValue('xml', xdoc, './name/text()', videos[0]), 'XML一');
assert.equal(R.extractValue('xml', xdoc, './pic/text()', videos[0]), 'https://img/x.jpg');
const dds = R.extractList('xml', xdoc, './dl/dd', videos[0]);
assert.equal(dds.length, 1);
assert.equal(R.extractValue('xml', xdoc, './@flag', dds[0]), 'm3u8');
assert.equal(
  R.extractValue('xml', xdoc, './text()', dds[0]),
  '第1集$https://x/1.m3u8#第2集$https://x/2.m3u8'
);

/* ---------- URL 模板 ---------- */
const url = R.buildUrl('https://site/search?wd=@keyword&id=@source&page=@page', {
  keyword: '芙莉莲',
  source: 26879,
  page: 2,
});
assert.ok(url.includes('%E8%8A%99%E8%8E%89%E8%8E%B2'));
assert.ok(url.includes('id=26879'));
assert.ok(url.includes('page=2'));

console.log('rules tests passed');
