# 家庭分工日誌

Cloudflare Workers（內嵌頁面 `public/index.html`、API 在 `functions/api`）＋ D1（資料庫），兩人手機每 5 秒自動同步。部署：`wrangler deploy`。

## 部署到 home.easonsung.com

在自己的電腦執行（需 Node 18+，且 easonsung.com 已在 Cloudflare 管理）：

```bash
npm i -g wrangler && wrangler login
wrangler d1 create myhome                      # 把輸出的 database_id 貼進 wrangler.toml
wrangler d1 execute myhome --remote --file=schema.sql
wrangler pages project create myhome --production-branch=main
wrangler pages deploy public --project-name=myhome
```

之後到 Cloudflare Dashboard：
1. Workers & Pages → myhome → Custom domains → 新增 `home.easonsung.com`（DNS 會自動建立）。
2. Settings → Bindings → 確認 D1 binding `DB` 指向 `myhome`（Production）。若沒有就手動加，然後重新部署一次。
3. 建議開 Zero Trust → Access → 新增應用程式，只允許你和宇茹的 email 登入，避免外人改資料（免費方案 50 人以內）。

之後更新頁面只要再跑一次 `wrangler pages deploy public --project-name=myhome`。

## 功能
- 今天：依頻率只列出該做的項目（每日、上學日、每週、每月…），超過週期的會提醒；「依需求」的項目收在底下。
- 全部：所有項目與上次完成日。
- 統計：近 14 天兩人完成數、最久沒做的項目。
- 編輯項目：直接在頁面新增、修改、刪除（刪除只是隱藏，歷史紀錄保留）。
- 備註與代做：勾選後可加備註；由非負責人勾的會標「代做」。

## 資料庫
`schema.sql` 建表、`seed.sql` 放初始 39 個項目。既有資料庫新增欄位：`ALTER TABLE done ADD COLUMN note TEXT;`
