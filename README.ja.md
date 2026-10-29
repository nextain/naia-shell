[English](README.md) | [한국어](README.ko.md) | **日本語** | [简体中文](README.zh-CN.md)

# naia-shell

**Naia Visual Agent のビジュアルシェルのコードベース。ユーザーが見て話しかけるデスクトップアプリであり、naia-os ディストリビューションの中核となるユーザー向けの面です。** Tauri/Rust ネイティブシェルが
会話 UI・音声・アバターを描画し、裏で「脳」(naia-agent) を起動して gRPC で対話します。このリポジトリのアプリコアはヘキサゴナルアーキテクチャで再構築されており、ディストリビューション層は Bazzite/titanoboa ベースで構成します。

> **名前の整理**: このリポジトリが `naia-shell` で、ユーザーが直接触れる **ビジュアルシェル（アプリ）** のコードがここにあります。`naia-os` は現在、このシェルを起動可能な形にまとめる Bazzite/titanoboa ベースの **ディストリビューション/ISO** 層を指します。2 つの名前が混同されないよう、コードは `naia-shell`、ディストリビューションは `naia-os` と使い分けます。製品カテゴリは **Naia Visual Agent** です。

---

## naia-shell とは？

naia-shell は **Naia Visual Agent のためのデスクトップシェル（アプリ）** です。ユーザーが実際に起動して
目にする画面であり、内部では次のことを行います。

- **脳を起動する** — 起動時に naia-agent を外部プロセスとして spawn し、gRPC で接続します。
- **メッセージを渡すだけ** — provider・モデル・キー・記憶はすべて agent の管轄です。シェルは「どの
  モデルか」を知る必要はありません。ユーザー入力を送り、ストリーミング応答を描画するだけです。
- **表現を担当する** — テキスト・音声・アバターでエージェントの応答を人に表現します。

```
ユーザー ─入力→ naia-shell(ビジュアルシェル) ─(gRPC)→ naia-agent(脳) ─→ provider / 記憶 / ツール
            ◀─表現(テキスト·音声·アバター)── ストリーム ◀────────
```

---

## 何をするか（機能・状態）

| 機能 | 説明 | 状態 |
|------|------|:----:|
| **テキスト会話** | シェルが agent を spawn → gRPC `Chat` ストリームで会話。new core 経路 | ✅ |
| **provider/モデル設定** | 設定 UI → agent `SetWorkspace`/reload でアプリを再起動せずにモデルを切り替え | ✅ |
| **環境サイドカー** | 脳から分離された独立サービス（例: BGM `bgm-sidecar`）。脳が落ちても生存 | ✅ |
| **能動発話 profile** | 「個人ラジオを始めて」または「イベント紹介を開始」で opt-in。長期 activity stream を既存のテキスト・TTS・BGM 表現に接続 | ✅ 技術 slice / 製品検証は一部 |
| **音声 I/O・アバター・TTS** | 音声入出力・アバター表現 | 🔜 旧経路あり、新コアへの移植は UC2 の後続 |
| **マルチモーダル表現** | 1 つの表現意図を音声/アバター/ロボットの身体が一緒に消費 | 🔜 egress 分岐の枠を予約 |

> ✅ = 新コアに実装+テスト済み（Playwright e2e を含む）。🔜 = 設計/旧経路あり、移植進行中。
> 正確な追跡は `docs/user-scenarios.md`（UC SoT）と `docs/requirements.md`（韓国語）を参照。Windows RTX 6GB の音声専用は [`docs/windows-6gb-voice.md`](docs/windows-6gb-voice.md)、8GB NVA は [`docs/windows-8gb-nva.md`](docs/windows-8gb-nva.md) が運用基準です。
> 実際の Tauri 検証は、profile の保存・復元、DJ の実際の YouTube BGM・最初の結果・stop、展示 greeting・stop までです。
> audible TTS・live 質問の割り込み・すべての制御・長時間/現場品質は、まだ native 検証済みとは主張しません。

---

## エコシステムにおける位置

naia-shell は Naia Visual Agent スタックの **表現/シェル層** です。

```
┌───────────────┐   gRPC    ┌───────────────┐  recall/save  ┌────────────────┐
│  naia-shell   │ ────────▶ │  naia-agent   │ ────────────▶ │  naia-memory   │
│(このリポジトリ)│ ◀──────── │  (脳/処理)    │ ◀──────────── │  (認知記憶)    │
│UI·音声·アバター│ ストリーム │ provider·ツール│               │ 長期記憶·想起  │
└───────────────┘           └───────┬───────┘               └────────────────┘
                                    │ 設定·スキル読み込み
                                    ▼  naia-adk (ワークスペース — provider/モデル/スキル SoT)
```

- **naia-shell**（このリポジトリの現在のコードの役割）— ユーザーシェル。agent を spawn し gRPC で対話。
- **naia-os** — Bazzite/titanoboa ベースのカスタムディストリビューション/ISO。ビジュアルエージェントスタックを起動可能な作業環境にまとめる配布層。
- **naia-agent** — provider 呼び出し・ツール実行・会話の組み立てを行う脳。→ `../naia-agent`
- **naia-memory** — 長期記憶。agent が recall/save で連携。
- **naia-adk** — 設定が置かれるワークスペース。agent が起動時に読み込む。

**結合方式 = インターフェース、ランタイム依存ではない。** shell↔agent は gRPC wire 契約
（`AgentOutbound`/`AgentMessage` の閉じた union）でのみ噛み合います。transport はポートなので、
stdio↔gRPC の差し替えはドメインに触れません。

---

## 脳・身体・環境モデル（naia の中核概念）

naia-shell が他のデスクトップアプリと異なる点は、この 3 層分離です（SoT: `docs/brain-body-environment.md`、韓国語）。

| 層 | 何か | どこに |
|----|------|------|
| **脳（brain）** | 認知・意図 — 何を話し、どのツールを使うか | naia-agent（別プロセス） |
| **身体（body）** | 感覚・表現器官 — アバター・音声 I/O | シェルネイティブ |
| **環境（environment）** | エージェントが作業する世界 — ブラウザ・ターミナル・workspace・BGM | シェルが所有する独立サイドカー |

要点: **ツール・BGM は「身体」ではなく「環境」** であり、脳から分離された独立サービスです（脳が
落ちても環境は生存し、脳は intent だけを送ります）。この分離のおかげで、脳を Android/組み込みに
差し替えても、身体・環境・ドメインは変わりません。

---

## アーキテクチャ早見

- **シェル** = Tauri（Rust）+ フロントエンド（`packages/shell`）。ネイティブウィンドウ・IPC・表現。
- **コア** = ヘキサゴナル TypeScript（`src/main`: domain/app/ports/adapters/composition）。agent と同じ思想。
- **サイドカー** = 環境の独立サービス（`packages/bgm-sidecar`）。
- 全体の思想（直交する 2 軸・認知階層・新しい UC のレシピ）の **オンボーディング SoT** = [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)（韓国語）。

---

## クイックスタート

> ⚠️ naia-shell は実行・ビルド時に `projects/` 内の **naia-agent（脳）** を自動でビルドして spawn します。
> 配布版は agent のローカル production 依存である `naia-kb-compiler`・`naia-memory` もワークスペース
> ルートで先にビルドします。`naia-memory` は `packages/shell/agent-pairing.json` に記録された正確な
> commit・package version の clean checkout のみを許可します。以下の正規レイアウトと名前を維持してください。

```bash
# 1) 正規ワークスペースレイアウトで clone（ディレクトリ名を変えないこと）
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
#  ワークスペース/
#  ├── projects/
#  │   ├── naia-shell/  ← 以下のコマンドはここで実行
#  │   └── naia-agent/  ← 自動ビルド・spawn
#  │   ├── naia-kb-compiler/
#  │   └── naia-memory/

cd naia-shell
pnpm install --frozen-lockfile    # 依存関係のインストール（ルート）
# naia-agent は shell workspace の外にある sibling で、ルートの install には含まれない。
pnpm -C ../naia-kb-compiler install --frozen-lockfile
pnpm -C ../naia-kb-compiler run build
pnpm -C ../naia-memory install --frozen-lockfile
pnpm -C ../naia-memory run build
pnpm -C ../naia-agent install --frozen-lockfile

# 2) コアの単体・契約テスト（ルート）
pnpm test                          # vitest run (src/test — 純粋ロジック・UC 契約)

# 3) デスクトップシェルの実行（Tauri）— agent を自動ビルド・spawn する
pnpm -C packages/shell run tauri:dev

# 4) 配布版（インストーラー）のビルド — 3 OS 共通のエントリポイント 1 つ (#377)
#    platform-matrix.json(SoT) から OS を自動検出: node ランタイムのダウンロード+SHA256、(win) MSVC 再頒布、
#    agent のステージング、conf 生成のあと tauri build まで実行。出力 = packages/shell/src-tauri/target/release/bundle/
#    (win → NSIS+MSI · linux → deb/rpm/appimage · mac → app/dmg)
#    ⚠️ 素の `tauri build`(デフォルト conf) ではビルドしないこと — base conf は中立化されており、
#    agent/node リソースが抜けたインストーラーが出力される。
pnpm -C packages/shell run tauri:build:bundle

# 成果物サイズの下限 + SHA256 検証（結果は bundle/artifacts.sha256）
node packages/shell/scripts/verify-artifacts.mjs

# 5) 検証（P04 — GUI/Rust もヘッドレスで）。test:e2e / test:e2e:tauri は packages/shell にのみ存在:
cd packages/shell
pnpm test                          # vitest (シェル単体)
pnpm test:e2e                      # Playwright e2e (実 UI、Tauri IPC mock)
xvfb-run pnpm test:e2e:tauri       # 実 Tauri バイナリのフルスタック (wdio+tauri-driver、Linux)
```

`tauri:dev` が paired Agent を自動ビルド・spawn するとしても、sibling 依存をインストールしたり
KB・memory の `dist/` を代わりに作ったりはしません。新しい clone では、上記の exact commit の
checkout と sibling の install/build を先に行う必要があり、1 つでも欠けているか clean checkout で
なければ、`agent-pairing.json` の検証が実行を fail-closed します。Agent の proto ピンは
`71e4cb6b3d19f9df08c88e6225babc11e30fe445723badd440decdb2a33e6f42`、memory package
version は `0.1.4` です。

インストーラーの CI は [build-installers.yml](.github/workflows/build-installers.yml) が Windows・Ubuntu・macOS で
同じマトリクスのエントリポイントを実行します。Ubuntu では deb のインストール後に agent ハンドシェイクと同梱 Node の実使用を
確認し、同梱 Node を取り除いた否定実行が失敗することも検証します。

> Windows インストーラーの Authenticode コード署名と macOS の公証はまだ範囲外です。Windows の自動
> 更新成果物は Tauri updater キーで署名し、リリースには `.sig` と `latest.json` が必ず揃って
> いなければなりません。macOS CI は Intel・Apple Silicon のアーキテクチャ別アプリと、両アーキテクチャを含む Universal アプリを
> 検証します。未公証の macOS 成果物は Finder の「開く」で明示的に承認する必要があります。Windows の手順は
> [docs/progress/windows-release-process.md](docs/progress/windows-release-process.md) に従います。

> **前提条件**: Node 22+ · pnpm · Rust(rustup) · WebView2(Windows)/webkit2gtk(Linux) · C++ ビルドツール。
> OS 別のセットアップは [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md)（韓国語）を参照。

---

## 開発プロセス（コントリビューター向け）

**契約優先 + V モデル** — コードを 1 行書く前に、シナリオ・要件・テストが先です。

| ゲート | 成果物 |
|--------|--------|
| P01 ユーザーシナリオ | `docs/user-scenarios.md` UC |
| P02 テストシナリオ | Test Coverage Map へのマッピング |
| P03 要件 | `docs/requirements.md` FR/NFR |
| P04 統合テスト | vitest + Playwright e2e（UI/Rust の変更は実検証を含む） |
| P05 完了 | 要件の状態 → Done |

新しい UC を追加するレシピ（スロットを埋める、推測禁止）は [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §6（韓国語）。
すべての AI ツールのエントリポイント・ルールは **[`AGENTS.md`](AGENTS.md)**（韓国語）— 初めての方はこの README の次に読んでください。
最初のコントリビューションのクイックガイドは [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md)（韓国語、15 分の fast-path を含む）。

---

## プロジェクト構成

```
naia-shell/
├── AGENTS.md / CLAUDE.md / GEMINI.md / OPENCODE.md / CODEX.md   # AI エントリポイント(憲章) — AGENTS.md が SoT、残りは自動 mirror
├── .agents/        # AI コンテキスト(ルール・状態・フック) — 人が編集
│   └── context/    #   agents-rules.json(ルール SoT) · process-status.json(進行)
├── .users/         # .agents/ の人向けマークダウン mirror
├── src/
│   ├── main/       # コア — domain / app / ports / adapters / composition
│   └── test/       # コアのテスト
├── packages/
│   ├── shell/      # Tauri デスクトップシェル (UI・アバター・音声 I/O・e2e)
│   └── bgm-sidecar/# 環境サイドカー (BGM)
├── scripts/        # enforce-root-structure.sh(構造強制) · sync-harness-mirrors.sh など
└── docs/           # ARCHITECTURE · brain-body-environment · user-scenarios · requirements · glossary · progress
```

構造ルール: 新しいルートのファイル/フォルダは、先に `agents-rules.json`（F12/F13）に登録する必要があります。
未登録の場合、`scripts/enforce-root-structure.sh --fix` が **削除** します。

---

## ライセンス

- **ソースコード**: Apache License 2.0 — [`LICENSE`](LICENSE)。
- **AI コンテキスト**（`.agents/`・`.users/`・`AGENTS.md`）: CC-BY-SA 4.0 — [`CONTEXT-LICENSE`](CONTEXT-LICENSE)。

**なぜデュアルライセンスなのか？** ソースコードは Apache 2.0 で自由に改変・商用利用できますが、AI コンテキストファイル（プロジェクトの哲学・コントリビューション構造・AI エージェント協働の原則）は CC-BY-SA 4.0 です。フォークする際は、コンテキストの変更分も **同一ライセンスで共有（ShareAlike）** し、原作者（Nextain）を明記する必要があります — アップストリームのエコシステム（オープンソースのコントリビューション構造 + AI 協働の原則）がすべてのフォークに伝播するよう保護するためです。詳細 = [`CONTEXT-LICENSE`](CONTEXT-LICENSE)。

コントリビューションガイド・行動規範・セキュリティポリシーは [`.github/`](.github/) を参照。

## リンク

- **naia-agent**（脳）— `../naia-agent`
- **naia-memory**（長期記憶）— [github.com/nextain/naia-memory](https://github.com/nextain/naia-memory)
- **naia-adk**（ワークスペース）— [github.com/nextain/naia-adk](https://github.com/nextain/naia-adk)
- **Nextain** — [nextain.io](https://nextain.io)
