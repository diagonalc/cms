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

## 已实现

- 分类树、分类 CRUD
- 影片 CRUD（含播放线路/剧集编辑）
- 前台首页、分类列表、详情页、播放页、搜索、分页
- 后台登录、session、CSRF、密码 scrypt 哈希
- 资源采集（离线测试接口：`/mock/resource`）
- 极简模板标签：`{maccms:vod}`、`{maccms:type}`、`{foreach}`、`{if}`、`{include}`
- 播放地址 `$$$` / `#` / `$` 解析

## 目录

```text
.
├─ server.js                  # HTTP 服务、路由、静态文件
├─ app/
│  ├─ db.js                   # 建表 + 演示数据
│  ├─ models.js               # Type / Vod / Admin / Collect
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

## 注意

这是教学项目，不是生产系统：

- session 存在内存里，重启后登录态丢失；
- 采集接口没有做 SSRF 防护，生产环境必须限制目标地址；
- 没有上传、会员、支付、静态化、插件、多主题；
- SQLite 适合单机小站，不适合高并发。

生产环境请参考苹果CMS的成熟实现，并做好备份、鉴权、限流和安全审计。
