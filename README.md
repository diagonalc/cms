# Mini MacCMS

一个用于学习苹果CMS（MacCMS10）核心架构的最简影视 CMS。

- 运行时：Node.js（>= 22.5，使用内置 `node:sqlite`）
- 数据库：SQLite（默认 `~/.mini-maccms/cms.db`，首次启动自动建表并写入演示数据；可用 `CMS_DB=/绝对路径/cms.db` 覆盖）
  - 之所以默认不放在项目目录：如果项目在 WSL 里、Node 却跑在 Windows 上，SQLite 通过 UNC 访问会出现 `database is locked`。
- 第三方依赖：**0**
- 架构：入口 → 路由 → 控制器 → 模型 → 模板标签 → HTML

## 启动

```bash
node server.js
```

打开：

- 前台：http://localhost:3000
- 后台：http://localhost:3000/admin
- 默认账号：`admin` / `admin123`

示例采集源使用 `@originRaw` 指向本机服务。换端口启动时同时设置：

```bash
APP_ORIGIN=http://localhost:3100 PORT=3100 node server.js
```

## 已实现

- 分类树、分类 CRUD
- 影片 CRUD（含播放线路/剧集编辑）
- 前台首页、分类列表、详情页、播放页、搜索、分页
- 后台登录、session、CSRF、密码 scrypt 哈希
- 资源采集（JSON / XML 自动识别，自动补 `ac=videolist`，支持分页、分类、地区、关键词；离线测试接口：`/mock/resource`、`/mock/resource.xml`、`/mock/resource.pages`）
- 采集源管理：JSONPath、XML XPath、HTML XPath 三种规则
- 定时采集任务：按分钟间隔自动运行，带运行日志
- 从 [KazumiRules](https://github.com/Predidit/KazumiRules) 拉取规则并自动转换成本站采集源
- 极简模板标签：`{maccms:vod}`、`{maccms:type}`、`{foreach}`、`{if}`、`{include}`
- 播放地址 `$$$` / `#` / `$` 解析

## 目录

```text
.
├─ server.js                  # HTTP 服务、路由、静态文件
├─ app/
│  ├─ db.js                   # 建表 + 演示数据
│  ├─ models.js               # Type / Vod / Admin / Collect
│  ├─ rules.js                # JSONPath / HTML/XML 解析 / XPath 子集
│  ├─ sources.js              # 采集源 CRUD + 规则执行 + 定时调度
│  ├─ kazumi.js               # KazumiRules 拉取、规则转换、导入
│  ├─ view.js                 # 极简模板引擎
│  ├─ helpers.js              # 转义、URL、分页、播放地址解析
│  ├─ security.js             # scrypt 密码、随机 token
│  ├─ session.js              # 进程内 session
│  ├─ controllers/
│  │  ├─ front.js             # 前台控制器
│  │  └─ admin.js             # 后台控制器
│  └─ views/                  # HTML 模板
└─ public/static/             # CSS / 播放器 JS

数据库默认生成在 ~/.mini-maccms/cms.db。
```

## 播放地址格式

```text
vod_play_from = "m3u8$$$iframe"
vod_play_url  = "第1集$https://a/1.m3u8#第2集$https://a/2.m3u8$$$第1集$https://b/embed/1"
```

- `$$$` 分隔线路
- `#` 分隔同一线路的剧集
- `$` 分隔剧集名和播放地址

## 采集格式

后台「资源采集」支持 JSON 和 XML，格式选择：

- `自动识别`：看 `Content-Type` 和响应开头，推荐；
- `JSON`：强制按 JSON 解析；
- `XML`：强制按苹果CMS资源站的 `rss > list > video > dl > dd` 格式解析。

XML 示例：

```xml
<rss version="5.1">
  <list page="1" pagecount="1" recordcount="1">
    <class><ty id="1">电影</ty></class>
    <video>
      <tid>1</tid>
      <name><![CDATA[片名]]></name>
      <year>2026</year>
      <dl>
        <dd flag="m3u8"><![CDATA[第1集$https://a/1.m3u8#第2集$https://a/2.m3u8]]></dd>
      </dl>
    </video>
  </list>
</rss>
```

离线测试：

```text
JSON:  http://localhost:3000/mock/resource
XML:   http://localhost:3000/mock/resource.xml
分页:  http://localhost:3000/mock/resource.pages
```

采集器会自动做这些事：

- 地址里没有 `ac` 或 `ac=list` 时，自动改成 `ac=videolist`；
- 支持 `vod_play_from`/`vod_play_url`（苹果CMS JSON 接口）和 `dl`（XML/部分接口）两种播放字段；
- 起始页/采集页数会变成 `pg` 参数，每页 20 条；
- 分类ID会变成 `t`，地区会变成 `area`，关键词会变成 `wd`；
- 详情页会把带 `.m3u8` 的直链线路排在前面，并标记“直链”/“需解析”。

### 实战：非凡资源（ffzy）

```text
XML 接口：https://api.ffzyapi.com/api.php/provide/vod/at/xml/
JSON 接口：https://api.ffzyapi.com/api.php/provide/vod/at/json/
```

只采日漫（日韩动漫分类 30，再限制地区日本）：

```text
分类ID：30
地区：日本
起始页：1
采集页数：1（每页 20 条，最多 50 页）
分类映射：30=3（3 是本站“动漫”分类；也可以在前台新建“日漫”分类后映射到它）
```

最终请求会变成：

```text
https://api.ffzyapi.com/api.php/provide/vod/at/xml/?ac=videolist&pg=1&t=30&area=%E6%97%A5%E6%9C%AC
```

老数据：改“起始页”，例如第 2 页、第 3 页；或者把“采集页数”调大。
该站 `ac=list` 只返回基本信息，没有播放地址，必须用 `ac=videolist`。

> ffzy 的 `feifan` 线路是分享页，需要解析；`ffm3u8` 才是直链 m3u8。本站会自动把直链线路排在前面。

## 采集源与定时任务

后台 →「采集源」：

- 新增/编辑 JSON、XML、XPath 三种规则；
- 手动运行、启用/停用、删除；
- 查看每次运行日志和统计；
- 设置定时间隔（分钟，0 表示只手动）。

规则是一个 JSON 对象：

```json
{
  "keyword": "测试",
  "typeId": 3,
  "pages": 1,
  "search": {
    "url": "https://api.example.com/list?wd=@keyword&page=@page",
    "list": "$.info.rows[*]",
    "name": "$.vod_name",
    "source": "$.vod_id"
  },
  "detail": {
    "url": "https://api.example.com/detail?id=@source"
  },
  "fields": {
    "vod_name": "$.info.vod_name",
    "vod_pic": "$.info.vod_pic",
    "vod_content": "$.info.vod_content"
  },
  "play": {
    "from": "$.info.vod_play_from",
    "url": "$.info.vod_play_url"
  }
}
```

- `search`：搜索/列表接口；`list` 是列表路径，`name`/`source` 是相对每个条目的路径；
- `detail`：可选；填了就对每个条目再请求一次详情；
- `fields`：影片字段路径；不写 `vod_name` 时用搜索结果的名称；
- `play`：两种写法：
  - 直接字段：`{ "from": "...", "url": "..." }`；
  - 线路分组：`{ "groups": "...", "from": "...", "episodes": "...", "episodeName": "...", "episodeUrl": "..." }`。

占位符：

```text
@keyword    关键词
@source     搜索得到的详情 ID
@page       页码（1 开始）
@offset     (page - 1) * limit，适合 offset/limit 接口
@limit      limit 值，默认 24
@typeId     本站分类 ID
@sourceRaw  不编码的 source（适合拼 URL 路径）
@originRaw  APP_ORIGIN 或 http://localhost:3000（示例源用）
```

JSON 用 JSONPath：`$.info.rows[*]`、`$.vod_name`、`$['data'][0]`。
XML / XPath 用 XPath 子集：

```text
//div  .//a  /html/body/div  ./text()
[@class="x"]  [contains(@class,"x")]  [1]  [last()]
@href  @src  text()
```

内置示例源：

```text
JSON:  http://localhost:3000/mock/rules/json/search
XML:   http://localhost:3000/mock/rules/xml/search
HTML:  http://localhost:3000/mock/rules/html/search
```

调度器：

- 服务启动后每 30 秒检查一次；
- 只运行「启用 + 间隔 > 0 + next_run_at 到期」的源；
- 同一个源不会并发运行；
- 运行结果写入 `collect_logs`，后台可查看。

注意：

- 调度器是进程内的，服务停止就不会执行；多实例部署会重复运行，生产环境应换成 cron/队列 + 分布式锁；
- XPath 是自实现的子集，不支持 `..`、`following-sibling`、`not()`、条件过滤等；
- 采集规则可以访问任意 http(s) 地址，生产环境必须做 SSRF 防护和限流。

### 从 KazumiRules 导入

仓库结构：

```text
index.json       规则索引
<name>.json      单条 Kazumi 规则
```

后台 →「采集源」→「导入规则」：

```text
index.json 地址：
https://raw.githubusercontent.com/Predidit/KazumiRules/main/index.json
```

如果 GitHub Raw 无法访问，用镜像：

```text
https://ghfast.top/https://raw.githubusercontent.com/Predidit/KazumiRules/main/index.json
```

导入流程：

1. 拉取 `index.json`，显示规则列表；
2. 选择一条规则导入；
3. 自动转换成我们的采集源（默认停用、手动运行）；
4. 跳转到编辑页，检查 `typeId`、`keyword`、`fields`、`play`。

自动转换覆盖：

- API 搜索 + API 选集（`delimited` / `nested`）；
- API 搜索 + XPath 选集（`sourceTemplate` + `chapterRoads` / `chapterResult`）；
- XPath 搜索 + XPath 选集。

不会自动转换（会写进 `_warnings`）：

- `episodePage`：只保留原始剧集地址，播放页构造被忽略；
- `variables`：响应变量不支持；
- `antiCrawlerConfig`：验证码/反爬需要手动处理；
- API 规则的额外字段（封面、简介等）：导入后可在 `fields` 里补；
- 高级 XPath / JSONPath：只支持前面列出的子集。

注意：

- XPath 规则依赖目标站当前 HTML，站点改版后就可能抽错字段；导入后一定要先点“运行”抽查。
- 多条采集源按影片名 upsert，同名影片会被后运行的源覆盖。
- 导入的源默认是「停用 + 间隔 0」，确认没问题后再启用定时。

实测：18 条 KazumiRules 全部能转换；`giriGiriLove` 可完整导入并拿到直链 mp4；`TvTFun` 混合规则能导入但部分详情 404；`7sefun` 的 XPath 规则能跑，但因站点 HTML 变化抽到了错误片名，需要手动调整。

## 注意

这是教学项目，不是生产系统：

- session 存在内存里，重启后登录态丢失；
- 采集接口没有做 SSRF 防护，生产环境必须限制目标地址；
- 没有上传、会员、支付、静态化、插件、多主题；
- SQLite 适合单机小站，不适合高并发。

生产环境请参考苹果CMS的成熟实现，并做好备份、鉴权、限流和安全审计。
