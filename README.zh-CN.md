[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | **简体中文**

# naia-shell

**Naia Visual Agent 的可视化外壳代码库。它是用户看到并与之对话的桌面应用，也是 naia-os 发行版的核心用户界面。** Tauri/Rust 原生外壳
负责绘制对话 UI、语音和虚拟形象，并在后台启动“大脑”（naia-agent），通过 gRPC 与其对话。本仓库的应用核心已按六边形架构重建，发行版层则基于 Bazzite/titanoboa 构建。

> **名称说明**：本仓库是 `naia-shell`，用户直接接触的 **可视化外壳（应用）** 代码就在这里。`naia-os` 现在指的是基于 Bazzite/titanoboa、把这个外壳打包成可启动形式的 **发行版/ISO** 层。为避免两个名称混淆，代码用 `naia-shell`，发行版用 `naia-os`。产品类别是 **Naia Visual Agent**。

---

## 什么是 naia-shell？

naia-shell 是 **面向 Naia Visual Agent 的桌面外壳（应用）**。它是用户实际启动并
看到的界面，内部负责：

- **启动大脑** — 启动时以外部进程方式 spawn naia-agent，并通过 gRPC 连接。
- **只传递消息** — provider、模型、密钥和记忆全部归 agent 管辖。外壳无需知道“用的是
  哪个模型”，只负责发送用户输入并渲染流式响应。
- **负责表达** — 通过文本、语音和虚拟形象把 agent 的响应呈现给人。

```
用户 ─输入→ naia-shell(可视化外壳) ─(gRPC)→ naia-agent(大脑) ─→ provider / 记忆 / 工具
            ◀─表达(文本·语音·虚拟形象)── 流 ◀────────
```

---

## 能做什么（能力 · 状态）

| 能力 | 说明 | 状态 |
|------|------|:----:|
| **文本对话** | 外壳 spawn agent → 通过 gRPC `Chat` 流对话。new core 路径 | ✅ |
| **provider/模型设置** | 设置 UI → agent `SetWorkspace`/reload，无需重启应用即可切换模型 | ✅ |
| **环境 sidecar** | 与大脑分离的独立服务（例：BGM `bgm-sidecar`）。大脑崩溃后仍存活 | ✅ |
| **主动发言 profile** | 通过“开始个人电台”或“开始活动介绍” opt-in。把长期 activity stream 接到现有的文本·TTS·BGM 表达上 | ✅ 技术 slice / 产品验证部分完成 |
| **语音 I/O · 虚拟形象 · TTS** | 语音输入输出·虚拟形象表达 | 🔜 旧路径已存在，移植到新核心在 UC2 之后进行 |
| **多模态表达** | 同一个表达意图由语音/虚拟形象/机器人身体共同消费 | 🔜 已为 egress 分支预留位置 |

> ✅ = 已在新核心中实现并测试（含 Playwright e2e）。🔜 = 设计/旧路径已存在，正在移植。
> 精确跟踪请参阅 `docs/user-scenarios.md`（UC SoT）和 `docs/requirements.md`（韩语）。Windows RTX 6GB 纯语音以 [`docs/windows-6gb-voice.md`](docs/windows-6gb-voice.md) 为运行基准，8GB NVA 以 [`docs/windows-8gb-nva.md`](docs/windows-8gb-nva.md) 为运行基准。
> 实际 Tauri 验证覆盖到 profile 保存·恢复、DJ 真实 YouTube BGM·首个结果·stop、展会 greeting·stop。
> audible TTS、live 提问插话、全部控制、长时间/现场质量，尚未声称已通过 native 验证。

---

## 在生态中的位置

naia-shell 是 Naia Visual Agent 技术栈中的 **表达/外壳层**。

```
┌───────────────┐   gRPC    ┌───────────────┐  recall/save  ┌────────────────┐
│  naia-shell   │ ────────▶ │  naia-agent   │ ────────────▶ │  naia-memory   │
│  (本仓库)     │ ◀──────── │  (大脑/处理)  │ ◀──────────── │  (认知记忆)    │
│UI·语音·形象   │    流     │ provider·工具 │               │ 长期记忆·回忆  │
└───────────────┘           └───────┬───────┘               └────────────────┘
                                    │ 设置·技能加载
                                    ▼  naia-adk (工作区 — provider/模型/技能 SoT)
```

- **naia-shell**（本仓库当前代码的角色）— 用户外壳。spawn agent 并通过 gRPC 对话。
- **naia-os** — 基于 Bazzite/titanoboa 的定制发行版/ISO。把可视化 agent 技术栈打包成可启动工作站的发行层。
- **naia-agent** — 负责调用 provider、执行工具、组装对话的大脑。→ `../naia-agent`
- **naia-memory** — 长期记忆。agent 通过 recall/save 与之联动。
- **naia-adk** — 存放设置的工作区。agent 启动时加载。

**耦合方式 = 接口，而非运行时依赖。** shell↔agent 只通过 gRPC wire 契约
（`AgentOutbound`/`AgentMessage` 封闭 union）衔接。transport 是端口，因此
替换 stdio↔gRPC 不会触及领域层。

---

## 大脑 · 身体 · 环境模型（naia 的核心概念）

naia-shell 与其他桌面应用的不同之处在于这三层分离（SoT：`docs/brain-body-environment.md`，韩语）：

| 层 | 是什么 | 在哪里 |
|----|------|------|
| **大脑（brain）** | 认知·意图 — 说什么、用哪个工具 | naia-agent（独立进程） |
| **身体（body）** | 感知·表达器官 — 虚拟形象·语音 I/O | 外壳原生 |
| **环境（environment）** | agent 工作的世界 — 浏览器·终端·workspace·BGM | 外壳拥有的独立 sidecar |

要点：**工具和 BGM 属于“环境”而不是“身体”**，是与大脑分离的独立服务（大脑
崩溃后环境依然存活，大脑只发送 intent）。得益于这种分离，即使把大脑换成 Android/嵌入式，
身体、环境和领域也保持不变。

---

## 架构一览

- **外壳** = Tauri（Rust）+ 前端（`packages/shell`）。原生窗口·IPC·表达。
- **核心** = 六边形 TypeScript（`src/main`：domain/app/ports/adapters/composition）。与 agent 同一思想。
- **sidecar** = 环境独立服务（`packages/bgm-sidecar`）。
- 整体思想（两条正交轴·认知层级·新 UC 配方）的 **入门 SoT** = [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)（韩语）。

---

## 快速开始

> ⚠️ naia-shell 在运行·构建时会自动构建并 spawn `projects/` 中的 **naia-agent（大脑）**。
> 发行版还会先在工作区根目录构建 agent 的本地 production 依赖 `naia-kb-compiler`·`naia-memory`。
> `naia-memory` 只接受与 `packages/shell/agent-pairing.json` 中记录的精确
> commit·package version 一致的 clean checkout。请保持下面的规范布局和名称。

```bash
# 1) 按规范工作区布局 clone（不要更改目录名）
mkdir projects
cd projects
git clone https://github.com/nextain/naia-shell.git
git clone https://github.com/nextain/naia-agent.git
git clone https://github.com/nextain/naia-kb-compiler.git
git clone https://github.com/nextain/naia-memory.git
# agent-pairing.json pins the exact source revisions used by the shell.
git -C naia-agent fetch --depth 1 origin cb4c8d71ae24bb7ff042e275026fae3905a91a00
git -C naia-agent checkout --detach cb4c8d71ae24bb7ff042e275026fae3905a91a00
git -C naia-kb-compiler fetch --depth 1 origin 24f52c14ea906c250304f39d48866c7a47e1b596
git -C naia-kb-compiler checkout --detach 24f52c14ea906c250304f39d48866c7a47e1b596
git -C naia-memory fetch --depth 1 origin 630a0d2f19b559e3f0101bb141048485167fb959
git -C naia-memory checkout --detach 630a0d2f19b559e3f0101bb141048485167fb959
#  工作区/
#  ├── projects/
#  │   ├── naia-shell/  ← 下面的命令在这里执行
#  │   └── naia-agent/  ← 自动构建·spawn
#  │   ├── naia-kb-compiler/
#  │   └── naia-memory/

cd naia-shell
pnpm install --frozen-lockfile    # 安装依赖（根目录）
# naia-agent 是 shell workspace 之外的 sibling，不包含在根目录 install 中。
pnpm -C ../naia-kb-compiler install --frozen-lockfile
pnpm -C ../naia-kb-compiler run build
pnpm -C ../naia-memory install --frozen-lockfile
pnpm -C ../naia-memory run build
pnpm -C ../naia-agent install --frozen-lockfile

# 2) 核心单元·契约测试（根目录）
pnpm test                          # vitest run (src/test — 纯逻辑·UC 契约)

# 3) 运行桌面外壳（Tauri）— 自动构建并 spawn agent
pnpm -C packages/shell run tauri:dev

# 4) 构建发行版（安装包）— 3 个 OS 共用的唯一入口 (#377)
#    从 platform-matrix.json(SoT) 自动检测 OS：下载 node 运行时+SHA256、(win) MSVC 可再发行组件、
#    暂存 agent、生成 conf，然后执行 tauri build。产物 = packages/shell/src-tauri/target/release/bundle/
#    (win → NSIS+MSI · linux → deb/rpm/appimage · mac → app/dmg)
#    ⚠️ 不要用单纯的 `tauri build`(默认 conf) 构建 — base conf 已被中性化，
#    会产出缺少 agent/node 资源的安装包。
pnpm -C packages/shell run tauri:build:bundle

# 产物大小下限 + SHA256 校验（结果在 bundle/artifacts.sha256）
node packages/shell/scripts/verify-artifacts.mjs

# 5) 验证（P04 — GUI/Rust 也可无头运行）。test:e2e / test:e2e:tauri 只存在于 packages/shell：
cd packages/shell
pnpm test                          # vitest (外壳单元)
pnpm test:e2e                      # Playwright e2e (真实 UI，Tauri IPC mock)
xvfb-run pnpm test:e2e:tauri       # 真实 Tauri 二进制全栈 (wdio+tauri-driver，Linux)
```

即使 `tauri:dev` 会自动构建并 spawn paired Agent，它也不会替你安装 sibling 依赖，
也不会替你生成 KB·memory 的 `dist/`。在新 clone 中，必须先完成上面的 exact commit
checkout 和 sibling install/build；只要缺少任何一项或不是 clean checkout，
`agent-pairing.json` 校验就会以 fail-closed 方式阻止运行。Agent 的 proto 固定值为
`71e4cb6b3d19f9df08c88e6225babc11e30fe445723badd440decdb2a33e6f42`，memory package
version 为 `0.1.4`。

安装包 CI 由 [build-installers.yml](.github/workflows/build-installers.yml) 在 Windows·Ubuntu·macOS 上
运行同一个矩阵入口。在 Ubuntu 上安装 deb 后，会确认 agent 握手和内置 Node 的实际使用，
并验证移除内置 Node 后的反向运行会失败。

> Windows 安装包的 Authenticode 代码签名和 macOS 公证目前仍不在范围内。Windows 自动
> 更新产物使用 Tauri updater 密钥签名，发布时必须同时附带 `.sig` 和 `latest.json`。
> macOS CI 会验证 Intel·Apple Silicon 各架构的应用以及同时包含两种架构的 Universal 应用。
> 未公证的 macOS 产物需要在 Finder 中通过“打开”明确批准。Windows 流程请遵循
> [docs/progress/windows-release-process.md](docs/progress/windows-release-process.md)。

> **前置条件**：Node 22+ · pnpm · Rust(rustup) · WebView2(Windows)/webkit2gtk(Linux) · C++ 构建工具。
> 各 OS 的环境配置请参阅 [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md)（韩语）。

---

## 开发流程（面向贡献者）

**契约优先 + V 模型** — 在写下任何一行代码之前，先有场景·需求·测试。

| 关卡 | 产出 |
|--------|--------|
| P01 用户场景 | `docs/user-scenarios.md` UC |
| P02 测试场景 | Test Coverage Map 映射 |
| P03 需求 | `docs/requirements.md` FR/NFR |
| P04 集成测试 | vitest + Playwright e2e（UI/Rust 变更包含真实验证） |
| P05 完成 | 需求状态 → Done |

新增 UC 的配方（填槽，禁止推测）见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §6（韩语）。
所有 AI 工具的入口与规则在 **[`AGENTS.md`](AGENTS.md)**（韩语）— 初次接触请在本 README 之后阅读。
快速首次贡献指南见 [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md)（韩语，含 15 分钟 fast-path）。

---

## 项目结构

```
naia-shell/
├── AGENTS.md / CLAUDE.md / GEMINI.md / OPENCODE.md / CODEX.md   # AI 入口(章程) — AGENTS.md 为 SoT，其余为自动 mirror
├── .agents/        # AI 上下文(规则·状态·钩子) — 由人编辑
│   └── context/    #   agents-rules.json(规则 SoT) · process-status.json(进度)
├── .users/         # .agents/ 的人类可读 markdown mirror
├── src/
│   ├── main/       # 核心 — domain / app / ports / adapters / composition
│   └── test/       # 核心测试
├── packages/
│   ├── shell/      # Tauri 桌面外壳 (UI·虚拟形象·语音 I/O·e2e)
│   └── bgm-sidecar/# 环境 sidecar (BGM)
├── scripts/        # enforce-root-structure.sh(结构强制) · sync-harness-mirrors.sh 等
└── docs/           # ARCHITECTURE · brain-body-environment · user-scenarios · requirements · glossary · progress
```

结构规则：新的根目录文件/文件夹必须先在 `agents-rules.json`（F12/F13）中登记。
未登记时，`scripts/enforce-root-structure.sh --fix` 会将其 **删除**。

---

## 许可证

- **源代码**：Apache License 2.0 — [`LICENSE`](LICENSE)。
- **AI 上下文**（`.agents/`·`.users/`·`AGENTS.md`）：CC-BY-SA 4.0 — [`CONTEXT-LICENSE`](CONTEXT-LICENSE)。

**为什么采用双许可证？** 源代码采用 Apache 2.0，可以自由修改和商用；但 AI 上下文文件（项目理念·贡献结构·AI agent 协作原则）采用 CC-BY-SA 4.0。fork 时，上下文的改动也必须 **以相同许可证共享（ShareAlike）**，并注明原作者（Nextain）— 目的是保护上游生态（开源贡献结构 + AI 协作原则），使其传递到每一个 fork。详情 = [`CONTEXT-LICENSE`](CONTEXT-LICENSE)。

贡献指南·行为准则·安全策略请参阅 [`.github/`](.github/)。

## 链接

- **naia-agent**（大脑）— `../naia-agent`
- **naia-memory**（长期记忆）— [github.com/nextain/naia-memory](https://github.com/nextain/naia-memory)
- **naia-adk**（工作区）— [github.com/nextain/naia-adk](https://github.com/nextain/naia-adk)
- **Nextain** — [nextain.io](https://nextain.io)
