# NicomusicBot

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/kongyo2/nicomusicbot-cli)
[![npm version](https://img.shields.io/npm/v/%40kongyo2%2Fnicomusicbot)](https://www.npmjs.com/package/@kongyo2/nicomusicbot)
[![CI](https://github.com/kongyo2/nicomusicbot-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/kongyo2/nicomusicbot-cli/actions/workflows/ci.yml)

[`NicomusicBot`](https://github.com/abeshinzo78/NicomusicBot) を元にしたTypeScript 移植版です。
Discordのボイスチャンネルでニコニコ動画の音声を再生するためのbotです。

## 必要条件

- Node.js >= 22.12.0

## 使い方

インストール不要で、`npx` コマンドを使用してすぐに起動できます。

```bash
npx @kongyo2/nicomusicbot
```

起動すると、インタラクティブなセットアップ画面が表示されます。必要な情報を入力してbotを起動してください。

## オプション

CLIオプションを指定して、初期設定を上書きしたり、インタラクティブな画面をスキップしたりできます。

```bash
npx @kongyo2/nicomusicbot [options]
```

### 利用可能なオプション

- `--token <token>`: Discord botのトークン
- `--prefix <prefix>`: コマンドのプレフィックス (デフォルト: `!`)
- `--niconico-user <value>`: ニコニコ動画のログインユーザー名/メールアドレス
- `--niconico-password <value>`: ニコニコ動画のログインパスワード
- `--config <path>`: 設定ファイルのパスを指定
- `--save-config`: セットアップ後に設定を保存する
- `--no-save-config`: 設定を保存しない
- `--skip-menu`: 設定が有効な場合、メニューをスキップして即座に起動する
- `-h, --help`: ヘルプを表示する

### 使用例

トークンなどを指定してメニューをスキップし、すぐに起動する例：

```bash
npx @kongyo2/nicomusicbot --token "YOUR_DISCORD_TOKEN" --skip-menu
```

## 環境変数

以下の環境変数を設定することでも、botの設定を行うことができます。

- `DISCORD_TOKEN`: Discord botのトークン
- `NICOMUSICBOT_PREFIX`: コマンドのプレフィックス
- `NICONICO_USER`: ニコニコ動画のログインユーザー名/メールアドレス
- `NICONICO_PASSWORD` または `NICONICO_PASS`: ニコニコ動画のログインパスワード

## 設定ファイルの保存場所

設定ファイルはデフォルトで以下の場所に保存されます。

- **Windows**: `%APPDATA%\nicomusicbot\config.json`
- **macOS / Linux**: `~/.config/nicomusicbot/config.json` (または `$XDG_CONFIG_HOME/nicomusicbot/config.json`)

## ライセンス

Unlicense
