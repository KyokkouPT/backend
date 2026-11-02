# KyokkouPT · backend

通用、可配置、可自部署的私有 PT 站引擎后端。**独立 Git 仓库**，不属于任何根 workspace。

- 运行时：Node.js 24+（ESM）
- 框架：Fastify 5 + Kysely 0.29
- 数据库：SQLite（better-sqlite3）默认，同时支持 MySQL/MariaDB/PostgreSQL
- 端口：`31001`
- 校验：zod 3

> 当前进度：Phase 5 纵切（2FA + 账号设置 + Staff 审核/举报/反作弊/审计/申诉 + 站点设置/分区编辑 + SMTP 邮件通知）。健康检查、配置、三库连接、迁移（001–007）、seed、认证/CSRF、site/bootstrap/home/rules/me、目录/上传/下载、审核与通知、announce/scrape、H&R、魔力值/兑换、RSS/downhash、邀请注册、求种悬赏、排行/主页、TOTP 2FA、设置与偏好、举报/反作弊/审计/申诉、站点设置与分区编辑、标准 SMTP 邮件通知已实现；MySQL/PG 实跑与部署验证尚未完成。

## 目录

```text
backend/
├── src/
│   ├── app.ts              # Fastify 组装（插件、错误处理、路由）
│   ├── server.ts           # 启动、自动迁移、优雅退出
│   ├── config.ts           # 环境变量 zod 校验（生产强制 secret）
│   ├── auth/               # scrypt、session、CSRF、权限
│   ├── db/
│   │   ├── db.ts           # Kysely + better-sqlite3 / mysql2 / pg
│   │   ├── types.ts        # Database 类型（迁移 001–007）
│   │   ├── migrate.ts      # 有序迁移执行器
│   │   ├── migrations/     # 001_init · 002_notifications · 003_tracker · 004_economy · 005_community · 006_twofa · 007_moderation
│   │   ├── seed.ts         # 幂等 seed
│   │   └── check.ts        # 库检查
│   ├── lib/                # bencode/.torrent、查询、通知、邮件、H&R、魔力、downhash、TOTP、申诉、problem+json
│   ├── tracker/            # 原始 query 解析、内存 peer 注册表、announce 持久化
│   └── routes/             # health / auth / site / me / torrents / staff / notifications / tracker / economy / invites / requests / top / users / settings / staff-admin / appeals / reports / staff-settings
├── test/                   # vitest（76 条）
├── vendor/contracts/       # 共享 DTO/zod（复制维护）
├── vendor/config/          # 站点设置 schema 与默认值
├── data/                   # 运行时 SQLite（git 忽略）
└── pnpm-workspace.yaml     # 仅 pnpm 设置，不是工作区
```

## 启动

```bash
pnpm install
cp .env.example .env        # Windows: Copy-Item .env.example .env
pnpm migrate                # 建表（server 启动时也会自动跑一次）
pnpm seed                   # 开发数据（可重复执行）
pnpm dev                    # http://127.0.0.1:31001
curl http://127.0.0.1:31001/api/v1/health
```

seed 开发账号（密码由 `SEED_PASSWORD` 控制，默认 `kyokkou-dev`）：

| 用户名 | 角色 | 说明 |
| --- | --- | --- |
| `lightbringer` | admin | 主测试账号 |
| `root` | admin | 站务/公告作者 |
| `阿雪` | user | 普通用户 |

## 命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | tsx + watch 启动，自动读取 `.env`（存在时） |
| `pnpm build` | `tsc -p tsconfig.build.json` 输出到 `dist/` |
| `pnpm start` | 用 tsx 加载器运行 `dist/server.js`（原因见下） |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | vitest（76 条：认证/CSRF、bootstrap/home/rules/me、目录筛选、上传审核、下载原始字节、通知、Tracker/compact/H&R、兑换/幂等/冻结、RSS/downhash、邀请注册、求种悬赏、排行/主页、迁移/seed 幂等、2FA/设置、Staff 处置/举报/申诉、站点设置/分区、SMTP 配置与邮件偏好） |
| `pnpm migrate` | 执行未应用的迁移 |
| `pnpm seed` | 幂等 seed |
| `pnpm db:check` | 打印驱动、schema 版本与各表行数 |

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `development` | production 下强制校验 secret |
| `HOST` / `PORT` | `127.0.0.1` / `31001` | 只监听本机，生产由 Nginx 反代 |
| `LOG_LEVEL` | `info` | fatal…trace |
| `DATABASE_DRIVER` | `sqlite` | sqlite / mysql / mariadb / postgres |
| `DATABASE_URL` | `file:./data/kyokkou.db` | mysql:// 或 postgres:// |
| `INSTANCE_ID` | 自动生成 | 多实例部署时每个后端实例的唯一标识，用于 cron 租约 |
| `KYOKKOU_BASE_URL` | `http://localhost:31002` | 公开前端地址（announce/download/RSS 链接）；不要用 `BASE_URL` |
| `SESSION_SECRET` | 开发默认值 | 32+ 字节；生产未替换会拒绝启动 |
| `SEED_PASSWORD` | `kyokkou-dev` | seed 账号密码；生产未替换会拒绝启动 |

## 数据库与迁移

- 迁移在 `src/db/migrations/NNN_name.ts`，按 `version` 顺序执行，记录在 `schema_migrations`。
- 当前：001_init 到 026_leechwarn_recovery（011 魔力公式/浮点/零魔；012 调度租约与索引；013 DB 化 Tracker peers；014 用户名规则与颗粒化 user_edit 权限；015 管理组默认字段清理；016 魔力值商店/H&R 机会/头衔；017 邀请预注册邮箱；018 邀请预注册用户名；019 邀请码统一大写；020 Tracker 会话流量；021 站内信群发任务；022 考核/任务系统；023 考核自动发现；024 做种积分；025 运营设置权限；026 受限等级恢复规则）。
- SQLite 只支持单实例；多实例必须 MySQL/MariaDB/PostgreSQL，详见 `../docs/23-performance-multi-instance.md`。
- SQLite / PostgreSQL 的迁移在一个事务里；MySQL/MariaDB 的 DDL 非事务，失败会明确抛错，重试前需人工检查。
- 主键按方言生成：SQLite `integer primary key autoincrement`、MySQL `bigint auto_increment`、PostgreSQL `bigserial`。
- 计数/时间戳是 bigint 列，应用层统一 number（写入 < 2^53）；PostgreSQL 的 int8 在 `db.ts` 里解析为 number。
- 换库：改 `DATABASE_DRIVER`/`DATABASE_URL` 后执行 `pnpm migrate && pnpm seed`。SQLite 是默认路径；MySQL 8.4、MariaDB 11、PostgreSQL 16 已实测 migrate/seed/db:check/API/Tracker/bonus。

## 已实现 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/health` | 探活 |
| GET | `/api/v1/site` | 站点身份/注册/页脚/主题/模块 |
| GET | `/api/v1/bootstrap` | site/nav/sections/permissions/counts/me |
| GET | `/api/v1/home` | 统计、最新发布、公告、促销 |
| GET | `/api/v1/rules` | 注册/审核/Tracker/H&R/分区规范 |
| GET | `/api/v1/auth/csrf` | 发放/轮换 CSRF（已登录时同步 session） |
| POST | `/api/v1/auth/login` | `{username,password}`，需 CSRF |
| POST | `/api/v1/auth/logout` | 需 session + CSRF |
| GET | `/api/v1/auth/me` | 当前用户/权限/待办 |
| GET | `/api/v1/me` | 用户/统计/H&R/snatches |
| GET | `/api/v1/torrents` | 列表；section/category/promo/uploader/q/sort/since/until/`field.*` + limit/cursor |
| GET | `/api/v1/torrents/:id` | 详情：files/description/info_hash/related |
| POST | `/api/v1/torrents` | multipart 上传（`file/section/category/name/description/promo/tags/meta`，≤5MB） |
| GET | `/t/:id/download` | `.torrent` 下载；替换 announce 并注入当前 passkey，info 原始字节不变 |
| GET | `/api/v1/staff/review` | 待审队列（`staff.review`） |
| GET | `/api/v1/staff/review/reasons` | 驳回模板 |
| POST | `/api/v1/staff/review/:id/:action` | approve / reject / return；写审计并通知发布者 |
| GET | `/api/v1/notifications` | 站内通知 + 未读数 |
| POST | `/api/v1/notifications/:id/read`、`/read-all` | 单条 / 全部已读 |
| GET | `/announce`、`/announce/:passkey` | Tracker announce；原始字节 info_hash/peer_id |
| GET | `/scrape`、`/scrape/:passkey` | scrape；返回 20 字节原始 info_hash |
| GET | `/rss`、`/rss.xml` | passkey RSS；enclosure 使用短期 downhash |
| GET | `/api/v1/me/bonus` | 余额/每小时产出/账本/兑换项/冻结 |
| GET | `/api/v1/me/ledger` | 魔力账本 |
| POST | `/api/v1/me/exchange/:key` | 兑换；支持 `Idempotency-Key` |
| GET | `/api/v1/me/rss` | 个人 RSS 地址 |
| GET/POST | `/api/v1/me/invites` | 邀请码列表 / 生成（30 天、一次性、上限 5） |
| GET | `/api/v1/invites/:code` | 邀请码公开预览 |
| POST | `/api/v1/auth/signup` | 邀请码注册并自动登录 |
| GET/POST | `/api/v1/requests` | 求种列表 / 发布（冻结悬赏） |
| POST | `/api/v1/requests/:id/cancel`、`/fulfill` | 取消退款 / Staff 结算 |
| GET | `/api/v1/top` | 用户与种子榜单 |
| GET | `/api/v1/users/:name` | 公开用户主页（尊重隐私偏好） |
| GET/PUT | `/api/v1/me/settings` | 账号设置；改密码会撤销全部 session |
| GET/PUT | `/api/v1/me/preferences` | 通知/隐私偏好 |
| POST | `/api/v1/me/passkey/rotate` | 轮换 passkey（旧 Tracker/RSS 地址立即失效） |
| POST | `/api/v1/me/2fa/setup`、`/enable`、`/disable`、`/recovery-codes` | TOTP 2FA 生命周期 |
| POST | `/api/v1/reports` | 举报种子/用户 |
| GET | `/api/v1/staff/summary` | 站务概览计数 + schema 版本 |
| GET | `/api/v1/staff/users?q=` | 用户搜索 |
| POST | `/api/v1/staff/users/:id/warn\|suspend\|ban\|restore` | 用户处置（停用/封禁撤销 session） |
| GET/POST | `/api/v1/staff/reports`、`/:id/resolve` | 举报队列与处理 |
| GET/POST | `/api/v1/staff/anomalies`、`/:id/resolve` | 反作弊队列；freeze/ban |
| GET | `/api/v1/staff/audit`、`/staff/audit/export` | 审计列表与 CSV |
| GET/POST | `/api/v1/staff/appeals`、`/:id/resolve` | 申诉队列与处理 |
| GET/POST | `/api/v1/me/appeals`、`/:id/messages`、`/withdraw` | 用户申诉 |
| POST | `/api/v1/appeals/public` | 免登录封禁申诉（校验邮箱+密码） |
| GET/PUT | `/api/v1/staff/settings` | 站点设置（仅 admin，schema 校验后写审计） |
| GET | `/api/v1/staff/sections` | 分区/分类读取 |
| PUT | `/api/v1/staff/sections/:slug`、`/staff/categories/:slug` | 分区/分类编辑（写审计） |

错误统一为 `application/problem+json`（`type/title/status/code/request_id/fields`）。

## 认证与安全

- 密码：`node:crypto` scrypt，存储 `scrypt$1$N$r$p$salt$hash`。
- Session：`kp_session` HttpOnly、SameSite=Lax、生产 Secure；数据库存 token 的 SHA-256。
- CSRF：`kp_csrf` 非 HttpOnly Cookie + `X-CSRF-Token` header；已登录时与 `sessions.csrf_hash` 绑定。
- 登录失败统一返回 `invalid_credentials`，不泄露账号是否存在；用户不存在也跑一次等价 KDF。
- 停用/封禁用户：`status` 非 active 时拒绝登录，并在解析 session 时清除旧会话。
- 全局 rate limit 600/min，登录 20/min；helmet 已启用。

## `.torrent` 与 info 原始字节

- 上传时用自研 bencode 解析器取 `info` 字典的原始区间，`info_hash = sha1(info 原始字节)`；数据库同时保存原始 `.torrent`（`torrents.torrent_blob`）。
- 下载时只重写顶层 `announce`（删除 `announce-list`），其余字段沿用原始字节片段，`info` 完全不动，所以 info_hash 不变。
- 下载端点接受 Cookie 或 `?downhash=`（RSS 场景）；两者都注入对应用户 passkey，未通过校验返回 401。
- 上传大小上限 5MB（multipart + handler 双重校验），`info_hash` 重复返回 409。

## Tracker、H&R 与经济

- announce/scrape 从 `request.raw.url` 自行解析，`info_hash`/`peer_id` percent-decode 成 Buffer，永不先做 UTF-8 解码。
- peer 注册表在内存（Map），重启后 peers 丢失是可接受行为；统计计数已持久化。维护任务按 TTL 清理过期 peer。
- 计数只增不减（`max(old, new)`）；`event=completed` 只累计一次；promo 影响站点统计（free 不计下载、2x 上传双倍、50/30 打折）。
- 下载量达到策略阈值创建 H&R 义务；维护任务每 10 分钟结算 `reached` / `unreached`。
- 魔力值在 `/me/bonus` 按 `last_bonus_at` 结算（按需，不依赖后台）；冻结期间产出 0、兑换返回 403。
- 兑换支持库存/限次/幂等键；余额变更写 `bonus_ledger`，兑换写 `redemptions`。
- RSS enclosure 使用 `uid|JWT` 形式的 downhash（HS256，key = sha256(SESSION_SECRET + passkey)），下载无需 Cookie。

> **Tracker 也走前端**：announce/scrape 由前端 `server.mjs` 在 Next 之前用原始 `req.url` 转发（保留 percent-encoding），本地经 `http://127.0.0.1:31002/announce/...` 即可验证；生产只需要一条 Nginx `location /` → 前端 31002（或直连后端 31001）。

## SMTP 邮件通知（可选）

- 配置 `SMTP_HOST` + `SMTP_FROM` 即启用；`SMTP_USER`/`SMTP_PASS` 必须成对配置；`SMTP_PORT` 默认 587（`SMTP_SECURE=true` 时 465）。
- 发送器基于 nodemailer（标准 SMTP），连接/握手超时 5s、socket 10s。
- 站内通知始终写库；邮件按用户偏好异步发送：`kind` 映射到 `email_review` / `email_hnr` / `email_invite` / `email_social` / `email_weekly`，未列出的 kind 不发邮件；未配置 SMTP 或偏好关闭直接跳过。
- 发送失败只写 `smtp send failed` warn 日志并返回 false，不阻塞 API；停用/封禁用户不发邮件。
- 开发环境通常不配置 SMTP；`.env.example` 有示例配置。

## 本地无 `X-Kyou-Secret`

本地开发不配置、不发送、不校验 `X-Kyou-Secret`；生产由前端 Nginx 注入、后端 Nginx 校验，**后端 Node 本身不校验该 header**。直连 Node 能工作是刻意设计。

## vendor 契约同步

- `vendor/contracts` 与 `frontend/vendor/contracts` **内容必须一致**。
- 改 DTO：先改本仓库契约，复制到 `../frontend/vendor/contracts`，两边各自 `pnpm install && pnpm typecheck` 后再分别提交。
- `file:` 目录依赖是复制（不是链接），**改完契约必须重新 `pnpm install`** 才会进入 `node_modules`。
- 依赖用 `file:vendor/...`，禁止 `workspace:*`。当前 `@kyokkou/contracts@0.1.0`（含 bootstrap/auth/torrent DTO）。

## 关于 `pnpm-workspace.yaml`

pnpm 11 只从 `pnpm-workspace.yaml` 读取 build scripts 严格度设置。本文件只有 `strictDepBuilds: false`，**没有 `packages`/`catalog`**，不构成工作区、不共享依赖；根目录仍然没有该文件。

## 为什么 `start` 用 tsx 加载器

`@kyokkou/contracts` 以 `file:vendor/contracts` 引入，包里是 TypeScript 源码。`tsc` 只编译 `src/`，运行 `dist/server.js` 时 Node 会去 `node_modules/.pnpm/.../node_modules/@kyokkou/contracts/index.ts` 加载契约；Node 24 的原生 type stripping 拒绝 `node_modules` 下的 `.ts`（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），已实测。因此 `start` 使用 `node --import tsx dist/server.js`：tsx 负责转译契约 TS，业务代码仍是 `tsc` 的构建产物。

若未来把契约改成“构建出 JS + d.ts”的发布形态，可以移除这个加载器。

## 路线

Phase 1 → 目录与上传审核 → Tracker/H&R/经济 → 社区 → 2FA/设置/Staff/站点设置（当前）→ SMTP 与部署验证。验收标准见仓库外 `docs/16`–`docs/20`。
