# KyokkouPT · backend

通用、可配置、可自部署的私有 PT 站引擎后端。**独立 Git 仓库**，不属于任何根 workspace。

- 运行时：Node.js 24+（ESM）
- 框架：Fastify 5 + Kysely 0.29
- 数据库：SQLite（better-sqlite3）默认，同时支持 MySQL/MariaDB/PostgreSQL
- 端口：`31001`
- 校验：zod 3

> 当前处于 Phase 0：应用骨架 + 健康检查。数据库、迁移、seed、认证与业务接口按纵切逐步加入。

## 目录

```text
backend/
├── src/
│   ├── app.ts            # Fastify 组装（测试入口）
│   ├── server.ts         # 启动 / 优雅退出
│   ├── config.ts         # 环境变量 zod 校验
│   ├── version.ts        # 版本号
│   └── routes/health.ts  # GET /api/v1/health
├── test/                 # vitest
├── vendor/contracts/     # 共享 DTO/zod 契约（复制维护）
├── vendor/config/        # 站点设置 schema 与默认值（仅后端）
├── pnpm-workspace.yaml   # 仅 pnpm 设置，不是工作区（见下）
└── data/                 # 运行时 SQLite 文件（git 忽略）
```

## 启动

```bash
pnpm install
cp .env.example .env        # Windows: Copy-Item .env.example .env
pnpm dev                    # http://127.0.0.1:31001
curl http://127.0.0.1:31001/api/v1/health
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | tsx + watch 启动，自动读取 `.env`（存在时） |
| `pnpm build` | `tsc -p tsconfig.build.json` 输出到 `dist/` |
| `pnpm start` | 用 tsx 加载器运行 `dist/server.js`（原因见下） |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | vitest |

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `development` | development / test / production |
| `HOST` | `127.0.0.1` | 只监听本机；生产由 Nginx 反代 |
| `PORT` | `31001` | |
| `LOG_LEVEL` | `info` | fatal…trace |

后续纵切追加：`DATABASE_DRIVER`、`DATABASE_URL`、`KYOKKOU_BASE_URL`、`SESSION_SECRET`、`SEED_PASSWORD`、`SMTP_*`。**不要使用 `BASE_URL`**（会与构建工具注入的变量冲突）。

## 本地无 `X-Kyou-Secret`

本地开发不配置、不发送、不校验 `X-Kyou-Secret`；生产由前端 Nginx 注入、后端 Nginx 校验，**后端 Node 本身不校验该 header**。直连 Node 能工作是刻意设计。

## vendor 契约同步

- `vendor/contracts` 与 `frontend/vendor/contracts` **内容必须一致**。
- 改 DTO：先改本仓库契约，复制到 `../frontend/vendor/contracts`，两边各自 `pnpm typecheck` 后再分别提交。
- 每次改动在 commit body 记录契约版本变化；当前 `@kyokkou/contracts@0.1.0`。
- 依赖用 `file:vendor/...`，禁止 `workspace:*`。

## 关于 `pnpm-workspace.yaml`

pnpm 11 只从 `pnpm-workspace.yaml` 读取 build scripts 严格度设置。本文件只有 `strictDepBuilds: false`，**没有 `packages`/`catalog`**，不构成工作区、不共享依赖；根目录仍然没有该文件。

## 为什么 `start` 用 tsx 加载器

`@kyokkou/contracts` 以 `file:vendor/contracts` 引入，包里是 TypeScript 源码。`tsc` 只编译 `src/`，运行 `dist/server.js` 时 Node 会去 `node_modules/.pnpm/.../node_modules/@kyokkou/contracts/index.ts` 加载契约；Node 24 的原生 type stripping 明确拒绝 `node_modules` 下的 `.ts`（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），已实测。因此 `start` 使用 `node --import tsx dist/server.js`：tsx 负责转译契约 TS，业务代码仍是 `tsc` 的构建产物。

这条路径只影响运行时加载，不改变契约结构；`dev` 本来就用 tsx。若未来把契约改成“构建出 JS + d.ts”的发布形态，可以移除这个加载器。


## 路线

Phase 0（当前）→ 健康检查、配置、契约 → Phase 1 数据库/迁移/seed/认证/bootstrap → 目录与上传审核 → Tracker/H&R/经济 → 社区/Staff → 安全加固。验收标准见仓库外 `docs/16`–`docs/20`。
