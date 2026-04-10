# NicomusicBot

`NicomusicBot-main.zip` を元にした、npm 配布前提の TypeScript 移植版です。  
Discord 側は `discord.js` / `@discordjs/voice`、CLI 側は `ink` / `@inkjs/ui` を使っています。

## Features

- Prefix command bot: `!play`, `!tag`, `!skip`, `!queue`, `!stop`, `!volume`, `!mute`
- NicoNico URL 正規化: `sm9`, `nico.ms/...`, `sp.nicovideo.jp/...`
- `yt-dlp` による単体動画 / マイリスト / シリーズ / ユーザー動画の取り込み
- NicoNico Snapshot Search API v2 を使ったタグ検索
- Ink ベースの TUI セットアップとランタイムダッシュボード
- JSON 設定ファイルの保存と再利用

## Requirements

- Node.js `>= 22.12.0`
- `yt-dlp` が `PATH` にあること
- `ffmpeg` が `PATH` にあること
- Discord Bot Token

## Install

ローカル開発:

```bash
npm install
npm run build
node dist/cli.js
```

将来の npm 配布想定:

```bash
npx @kongyo2/nicomusicbot
```

## CLI Options

```text
--token <token>
--prefix <prefix>
--niconico-user <value>
--niconico-password <value>
--config <path>
--save-config
--no-save-config
--skip-menu
--help
```

既定の設定ファイルパス:

- Windows: `%APPDATA%\\nicomusicbot\\config.json`
- Linux/macOS: `$XDG_CONFIG_HOME/nicomusicbot/config.json` または `~/.config/nicomusicbot/config.json`

## Usage

1. CLI を起動
2. Token / Prefix / 必要なら NicoNico 認証情報を入力
3. Discord サーバーで Bot を招待し、VC に参加
4. Discord テキストチャンネルでコマンドを使う

例:

```text
!play https://www.nicovideo.jp/watch/sm9
!play nico.ms/mylist/12345
!tag ボーカロイド 20
!queue
!skip
!volume 150
!mute
!stop
```

## Notes

- 設定ファイル保存を有効にすると、Token と NicoNico 認証情報は平文 JSON で保存されます。
- `yt-dlp` と `ffmpeg` は同梱していません。
- 実環境での Discord 接続や NicoNico 再生はこの作業中には実行していません。ビルドと CLI 起動確認のみ完了しています。
