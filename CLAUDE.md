# CLAUDE.md

orm-d1 — a type-safe ORM built **exclusively** for Cloudflare D1 and Workers, plus its
migration CLI. `docs/01`–`docs/07` は使う側向けのドキュメント（挙動の差、機能、
移行、セキュリティ）で、`kit/README.md` が CLI のリファレンス。振る舞いを変えるなら
先に該当のものを読み、変えたら直す。設計ドキュメントは 2026-08-16 に削除した ——
判断の理由はコードのコメントとして、その判断の隣に置く。

## The split that governs everything

| | Ships to the Worker? | Rules |
|---|---|---|
| `src/` | **Yes** | Zero runtime dependencies, no Node builtins, no polyfills. Every byte is parsed on every cold isolate and billed as startup CPU (target ≤ 20 KB minified for the core entry). |
| `kit/` | **No** — devDependency | Runs in Node, may use dependencies freely, contributes zero bytes to the bundle. |
| `kit/src/core/` | No | …but must stay **Node-free and filesystem-free** anyway: it talks to a DB through the four-line `SqlRunner` interface so the migration engine can be tested *inside workerd against a real D1*. Node-only code goes in `kit/src/node/`. |

## 絶対に守ること

- **`src/` に依存関係や `node:` ビルトインを足さない。** 必要に見えたら設計が
  間違っている。止めて報告する。
- **スキーマに書ける記号は Drizzle にも存在しなければならない**（`docs/04`）。
  既存の `drizzle-orm/sqlite-core` スキーマは import 指定子を変えるだけで動くのが
  この ORM の存在理由で、アダプタ（Pothos の drizzle plugin など）は Drizzle の
  *内部表現*を読む。Drizzle に無い綴りを `sqliteTable` 系に足すのは API 変更であり、
  勝手にやらない。
- **テストを緩めて緑にしない。** 落ちたテストは「変更が間違っている」か「テストが
  本物の不変条件を書いている」かのどちらか。assertion の削除・期待値の緩和・skip の
  追加は最後の手段で、やったら必ず明示的に報告する。黙ってやらない。
- **`.git/` の中身を直接書き換えない。** 操作は git コマンドで行う。
- **頼まれていなければブランチを作らない。** 現在のブランチにそのままコミットする。
- **リリースは頼まれたときだけ。** バージョン採番・タグ・`Makefile` / `RELEASING.md` は
  自動化された手順があるので勝手に触らない。

## Completion Check (REQUIRED)

編集を終えてユーザーに制御を返すたびに:

```bash
npm run check     # typecheck → build → test → typecheck:kit → build:kit
```

失敗したら報告する前に直す。直せないときは「以下が失敗している。ここで判断を仰ぐ」と
明示してから止まる。作業中の速いループは:

```bash
npm run test:unit      # Node、ミリ秒。クエリ compilation / DDL / kit の diff エンジン
npm run test:workers   # workerd + 実 D1。runtime と applier を触ったら必須
```

リンタは無い（typecheck が兼ねる）。

## テストの置き場所

二段構えで、混ぜると意味が消える:

- `test/unit/`, `kit/test/unit/` — Node で走る純粋な assertion。`runtime/` より上は
  全部同期・純粋なので、スイートの大半はここ。
- `test/workers/`, `kit/test/workers/` — workerd + miniflare の D1 バインディング。
  **SQLite の実挙動に依存する主張は必ずこちら**。Node 形状の SQLite に対して
  assert しないための分離なので、`better-sqlite3` 等を持ち込まない。

新しい挙動を残す価値があるならテストが要る。`test/schema.ts` が横断フィクスチャで、
Drizzle 方言で書いてあるので互換性フィクスチャも兼ねている。

## この ORM で「バグ」が出る場所

深刻な順。詳しくは `docs/01`（drizzle との差）と `kit/README.md`（kit）。

1. **制約が黙って消える。** このプロジェクトが存在する理由そのもの —— drizzle-kit は
   64 表で列レベル `.unique()` を落とし、生成物同士は整合していたので CI は緑だった。
   DDL レンダリング / スナップショット / diff を触ったら必ず「何が落ちるか」を問う:
   `unique`、複合主キー、`check`、FK の `on delete`/`on update`、`not null`、デフォルト、
   collation、生成列、部分 index の `where`、`STRICT`、`WITHOUT ROWID`。
2. **パースは通るが間違っている SQL。** `and`/`or` の入れ子での括弧と優先順位、
   プレースホルダとバインド値の順序、join 順、集約前に効く `limit`。
3. **行が違う。** `Many` が単一オブジェクトとして解決される、join 後の親の重複、
   left join が実質 inner になる、全 null の行がオブジェクトとして実体化する。
4. **識別子のクォートと値のバインド。** 識別子は必ずクォートして内部のクォートを
   エスケープし、値は必ずバインドする（文字列連結しない）。
5. **D1 のプラットフォーム上限**（`src/limits.ts`, `docs/01`）: バインドパラメータ数、
   ステートメントサイズ、batch サイズ、subrequest 数。無制限に伸びる `in (...)` や
   batch は本番障害であってスタイルの問題ではない。

## 開発環境

`docker compose up -d` → `./dev-exec`（引数なしで zsh、引数ありでそのコマンドを実行）。
`node_modules` は**名前付きボリューム**で、ホストとは共有しない —— ホストが macOS、
コンテナが linux だと esbuild や tsgo のバイナリのアーキが食い違って
`Exec format error` になるため。初回だけコンテナの中で `npm install` が要る。
