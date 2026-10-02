# 提交前安全與資訊洩漏檢查

日期：2026-10-03。範圍：本次提交的原始碼、前端、安裝腳本、Git 排除規則與本機依賴。

## 修正

- HTTP Host、Origin、Sec-Fetch-Site 檢查限制為本機 APP；WebSocket 在握手前檢查，拒絕跨站網頁與 DNS rebinding 使用非本機 Host。
- Eel RPC 的錯誤回應改為固定訊息，避免框架自動傳回例外 traceback、電腦路徑及簽名串流網址。
- APP 日誌隱去 URL、本機絕對路徑與常見機密欄位。每首歌曲的原始 `worker.log` 仍是本機診斷資料，不公開提供下載，不應直接分享。
- 加入 no-referrer、nosniff、DENY frame 與 no-store 回應標頭；移除外部圖示 CDN。
- Git 排除虛擬環境、日誌、環境變數檔、金鑰、cookie、影音快取、模型與打包產物。
- SVG 移除不影響可見圖形的 Illustrator 原始內嵌封包與外部 DTD；提交內容檢查常見金鑰、token、含帳密網址、簽名串流網址及私人絕對路徑，未發現符合這些規則的機密。
- 更新本機 pip／setuptools。AI 更新至 PyTorch／torchaudio 2.10.0 CPU；官方模型每次載入前校驗官方檔名的 SHA-256 前綴，使用 `weights_only=True` 及固定類別允許清單，拒絕回退至任意 pickle。
- 使用 SoundFile 讀寫已解碼 WAV，以相容新版 torchaudio 而不新增 TorchCodec 依賴。

## 依賴掃描與限制

以 pip-audit 查詢已安裝 APP／AI 環境，更新 pip／setuptools 後兩者未回報可辨識套件的已知漏洞。
CPU wheel 帶有 `+cpu` 的 PyTorch／torchaudio 被掃描工具略過，因此另用標準版本 2.10.0 單獨查詢；
PyTorch 仍列出 PYSEC-2026-139（pt2 載入，無修復版本）與 PYSEC-2025-194（torch.jit.script，資料庫列修復版 2.13.0）。
本 APP 的 Demucs 路徑使用 eager 推論與固定官方 checkpoint；沒有使用 pt2 載入或 `torch.jit.script`。
這是使用路徑的風險判斷，未宣稱套件或應用程式完全沒有漏洞；未略過這兩筆公告。

舊版模型載入漏洞的官方公告：[CVE-2025-32434](https://github.com/pytorch/pytorch/security/advisories/GHSA-53q9-r3pm-6pq6)。
PyTorch 2.10 亦修補 weights-only unpickler 記憶體問題；本次不再使用 2.5.1。

模型只允許 Demucs 套件提供的官方來源。官方校驗碼為 SHA-256 前綴，非本專案獨立驗證的完整雜湊；
仍信任套件發布者、官方模型來源與本機檔案權限。本機其他程式可存取 loopback 服務，此防護不隔離已在電腦上執行的惡意程式。

YouTube 搜尋、縮圖、影音下載及首次模型下載仍需要對外連線。
APP 不使用 YouTube 帳號 cookie；清單儲存在本機瀏覽器 localStorage。
檢查與掃描結果反映檢查當時資料庫及本次提交範圍，不包含滲透測試或完整供應鏈審計。
