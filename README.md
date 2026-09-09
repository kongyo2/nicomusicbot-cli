# NicomusicBot

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/kongyo2/nicomusicbot-cli)
[![npm version](https://img.shields.io/npm/v/%40kongyo2%2Fnicomusicbot)](https://www.npmjs.com/package/@kongyo2/nicomusicbot)
[![CI](https://github.com/kongyo2/nicomusicbot-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/kongyo2/nicomusicbot-cli/actions/workflows/ci.yml)

[`NicomusicBot`](https://github.com/abeshinzo78/NicomusicBot) を元にしたTypeScript 移植版です。
Discordのボイスチャンネルでニコニコ動画の音声を再生するためのbotです。

音声の解決には [`@kongyo2/niconicojs`](https://www.npmjs.com/package/@kongyo2/niconicojs)
を使用し、ニコニコの DMS (Domand) API から**音声のみの HLS ストリーム**を直接取得します。
映像を一切ダウンロードしないため転送量が小さく、再生が途中で切れにくくなっています。

## 必要条件

- Node.js >= 22.12.0
- ffmpeg（必須）
- yt-dlp（任意。ネイティブ解決に失敗したときのフォールバックとしてのみ使用します）

`ffmpeg` と `yt-dlp` が見つからない場合、起動時に自動インストールを試みます
（Linux: apt-get / macOS: Homebrew / Windows: winget）。

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
- `--niconico-session <value>`: ニコニコ動画の `user_session` クッキー（**推奨**）
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

## 対応する入力（`!play`）

`!play` には以下の形式を指定できます。いずれも外部コマンドなしで解決されます。

| 形式             | 例                                                    |
| :--------------- | :---------------------------------------------------- |
| 動画ID           | `sm9`                                                 |
| 視聴URL          | `https://www.nicovideo.jp/watch/sm9`                  |
| 短縮URL          | `https://nico.ms/sm9`                                 |
| スマホ版URL      | `https://sp.nicovideo.jp/watch/sm9`                   |
| マイリスト       | `https://www.nicovideo.jp/mylist/79600395`            |
| シリーズ         | `https://www.nicovideo.jp/series/176162`              |
| ユーザー投稿動画 | `https://www.nicovideo.jp/user/9003560/video`         |
| ランキング       | `https://www.nicovideo.jp/ranking/genre/all?term=24h` |
| タグ             | `https://www.nicovideo.jp/tag/VOCALOID`               |
| 検索             | `https://www.nicovideo.jp/search/初音ミク`            |

Discordがリンクを `<...>` で囲んだ場合も、そのまま解釈します。
上記以外のURLは yt-dlp にフォールバックします。

## 環境変数

以下の環境変数を設定することでも、botの設定を行うことができます。

- `DISCORD_TOKEN`: Discord botのトークン
- `NICOMUSICBOT_PREFIX`: コマンドのプレフィックス
- `NICONICO_USER`: ニコニコ動画のログインユーザー名/メールアドレス
- `NICONICO_PASSWORD` または `NICONICO_PASS`: ニコニコ動画のログインパスワード
- `NICONICO_SESSION`: ニコニコ動画の `user_session` クッキー（推奨。下記参照）

## ニコニコのログインについて（推奨: セッションクッキー）

ニコニコのユーザー名/パスワードによるログインは、2段階認証やログインフローの仕様変更により
失敗することがあります。より確実なのは、ログイン済みブラウザの `user_session` クッキーを使う方法です。

1. ブラウザでニコニコ動画にログインする
2. 開発者ツール → Application/Storage → Cookies から `user_session` の値をコピーする
   （`user_session_XXXXXXXX_...` の形式）
3. `--niconico-session "<値>"` または環境変数 `NICONICO_SESSION` に設定する

セッションクッキーを設定すると、ユーザー名/パスワードより優先して使用されます。
ログイン済みセッションを使うことで、視聴制限のある動画でも途中で止まりにくくなります。

値は生のクッキー値・`user_session=...`・`Cookie: user_session=...` のいずれの形式でも
受け付けます。起動時にセッションの有効性を確認し、ログを表示します。

セッションを設定しない場合はゲストとして再生します（公開動画は再生可能です）。

## 設定ファイルの保存場所

設定ファイルはデフォルトで以下の場所に保存されます。

- **Windows**: `%APPDATA%\nicomusicbot\config.json`
- **macOS / Linux**: `~/.config/nicomusicbot/config.json` (または `$XDG_CONFIG_HOME/nicomusicbot/config.json`)

## ライセンス

Unlicense
