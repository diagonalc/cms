const assert = require('node:assert');
const { Collect } = require('../app/models');
const { isDirectPlayUrl } = require('../app/helpers');

const sample = `<?xml version="1.0" encoding="utf-8"?>
<rss version="5.1">
  <list page="2" pagecount="9" pagesize="20" recordcount="170">
    <class>
      <ty id="1">电影</ty>
      <ty id="2"><![CDATA[电视剧]]></ty>
    </class>
    <video>
      <id>101</id>
      <tid>1</tid>
      <type>电影</type>
      <name><![CDATA[测试 & 片名]]></name>
      <actor>张三,李四</actor>
      <year>2026</year>
      <note>HD &amp; 中字</note>
      <des><![CDATA[简介<br>第二行]]></des>
      <dl>
        <dd flag="m3u8"><![CDATA[第1集$https://a/1.m3u8?x=1&y=2#第2集$https://a/2.m3u8]]></dd>
        <dd flag="iframe">第1集$https://b/embed/1</dd>
      </dl>
    </video>
  </list>
</rss>`;

const res = Collect.parseXmlResource(sample);

assert.equal(res.page, 2);
assert.equal(res.pagecount, 9);
assert.equal(res.total, 170);
assert.equal(res.class.length, 2);
assert.deepEqual(res.class[1], { type_id: 2, type_name: '电视剧' });

const item = res.list[0];
assert.equal(item.vod_name, '测试 & 片名');
assert.equal(item.type_name, '电影');
assert.equal(item.vod_remarks, 'HD & 中字');
assert.equal(item.vod_content, '简介<br>第二行');
assert.equal(item.dl.m3u8, '第1集$https://a/1.m3u8?x=1&y=2#第2集$https://a/2.m3u8');
assert.equal(item.dl.iframe, '第1集$https://b/embed/1');

assert.throws(() => Collect.parseXmlResource('<html>not xml</html>'), /不是有效的 XML/);

// 没有 <class> 节点时，应从每部影片的 <tid>/<type> 反推出分类表
const noClassXml = `<?xml version="1.0"?>
<rss version="5.1"><list page="1" pagecount="1" recordcount="1">
  <video><tid>30</tid><type>日韩动漫</type><name>测试日漫</name>
    <dl><dd flag="ffm3u8">第1集$https://a/1.m3u8</dd></dl>
  </video>
</list></rss>`;
const inferred = Collect.parseXmlResource(noClassXml);
assert.deepEqual(inferred.class, [{ type_id: 30, type_name: '日韩动漫' }]);

// 苹果CMS JSON 接口使用 vod_play_from / vod_play_url
assert.deepEqual(
  Collect.playStringsFromItem({
    vod_play_from: 'feifan$$$ffm3u8',
    vod_play_url: 'a$$$b',
  }),
  { vod_play_from: 'feifan$$$ffm3u8', vod_play_url: 'a$$$b' }
);
assert.deepEqual(
  Collect.playStringsFromItem({ dl: { m3u8: '第1集$url' } }),
  { vod_play_from: 'm3u8', vod_play_url: '第1集$url' }
);

// 采集地址规范化：自动补 ac=videolist，并带上分页/分类/地区
const normalized = Collect.normalizeResourceUrl(
  'https://api.ffzyapi.com/api.php/provide/vod/at/xml/',
  { page: 2, typeId: 30, area: '日本' }
);
assert.ok(normalized.includes('ac=videolist'));
assert.ok(normalized.includes('pg=2'));
assert.ok(normalized.includes('t=30'));
assert.ok(decodeURIComponent(normalized).includes('area=日本'));

// 直链判断：m3u8 / mp4 都算直链，分享页不算
assert.ok(isDirectPlayUrl('https://a/1.m3u8'));
assert.ok(isDirectPlayUrl('https://a/1.mp4?token=x'));
assert.ok(isDirectPlayUrl('https://a/1.webm'));
assert.ok(!isDirectPlayUrl('https://a/share/b8cca67f'));

console.log('XML parser tests passed');
