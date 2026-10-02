# 卡拉OK神 · 歡唱工作室 v2

本機 Eel 桌面 APP，支援 YouTube 搜尋、原唱導唱、快速人聲削弱與 AI 伴奏製作。

## 啟動

這次已在專案內建立 `.venv`（APP）與 `.venv-ai`（AI）環境。
原 `env` 指向已不存在的 Python，不再使用。

```powershell
.\start.ps1
# 或
.\.venv\Scripts\python.exe -X utf8 main.py
```

需要 Chrome；程式只監聽 localhost:8000。若埠號已被占用，先關閉先前的 APP。

新電腦建議使用 Python 3.11，重新安裝：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pip install --upgrade pip setuptools
.\.venv\Scripts\python.exe setup_runtime.py
.\setup-ai.ps1
.\start.ps1
```

若 Windows 應用程式控制原則阻擋新版 exe，以上 Python 啟動方式仍可使用。
exe 的簽章或允許清單須依電腦既有管理政策處理，本專案不修改系統防護設定。

`setup_runtime.py` 從 Deno 官方 GitHub release 下載 Windows x64 可攜版，驗證 SHA-256 後放到 `.tools`。
若 GitHub 下載停滯，可加 `--mirror` 使用官方 dl.deno.land 鏡像，仍須符合 GitHub release 的 SHA-256。
yt-dlp 新版 YouTube 擷取需要 JavaScript runtime 與 EJS；程式自動尋找這個 Deno，或系統 PATH 中的 Deno。
FFmpeg 優先使用系統版本，否則使用 imageio-ffmpeg 封裝的執行檔。

## 使用方式

1. 搜尋歌曲或輸入 YouTube 單一影片網址，點選加入待播清單。
2. 「導唱／歡唱」可直接切換快速模式；這種方法仍可能削弱中央樂器。
3. 要較完整保留伴奏，點「製作 AI 伴奏」，下載、分離與合成在背景執行。
   AI 影片優先使用最高 720p 來源，減少下載與快取成本。
4. 完成後勾選「使用 AI 伴奏」，再以導唱／歡唱切換原唱與分離伴奏。
   切換會短暫重新載入影片並保留播放位置；不是無縫音軌切換。
5. AI 影片支援拖曳進度；即時 FFmpeg 代理串流不提供任意跳轉。

清單自動儲存在此 APP 的瀏覽器中，也可匯入／匯出 JSON。
清單上限 500 首、匯入檔案上限 2MB。匯入不會自動播放。
空白鍵播放／暫停、左右鍵跳轉 5 秒（限可尋址來源）、Ctrl+N 下一首。

## AI 處理與限制

AI 支援 15 分鐘以內的非直播影片，同時製作一首；可取消目前歌曲的製作。
工作室每秒更新目前階段進度與總耗時：下載顯示影音軌、速度及該軌預估剩餘時間；
音訊準備／影片合成依實際處理時間顯示百分比；AI 分離依模型分段進度顯示百分比。
百分比是「目前階段」（下載時為目前影音軌），不是整首工作的總百分比。
模型下載／載入及來源解析期間，會顯示等待狀態；第一個音訊分段完成前百分比可能停留在 0%。
切歌不會取消已開始的 AI 工作，切回原歌曲可繼續查看進度。
首次使用會下載模型；CPU 處理可能需數分鐘或更久，逾 1 小時分離工作會中止。
預設 `htdemucs`，可透過 `KARAOKE_AI_MODEL=htdemucs_ft` 選較慢的微調模型。
所有模型仍可能留下人聲或傷害部分樂器，沒有「完全不影響背景音樂」的保證。
研究與評估方式見 [人聲分離說明](docs/VOCAL_SEPARATION.md)。

若使用自訂 AI 環境，設定 `KARAOKE_AI_PYTHON` 為該環境 python.exe 的絕對路徑。
AI 環境使用 Python 3.10／3.11 與固定版本 PyTorch 2.10.0 CPU、Demucs 4.0.1。
既有 AI 環境請重跑 `setup-ai.ps1` 更新。模型使用受限制的 weights-only 載入，並於每次載入前驗證官方校驗碼。
一般 APP 的 yt-dlp 在此 Python 3.10 尚可執行，但已提示未來將移除支援；新安裝請用 3.11。

快取在 `%LOCALAPPDATA%\ShenKaraoke\cache`，包含原影片、AI 影片、模型與每首的 `worker.log`。
新任務開始前若現有快取超過 2GB，會要求先清理；這不是寫入過程的硬性容量上限。
處理需要至少 2GB 可用空間。關閉 APP 後可手動刪除不需要的歌曲 ID 資料夾，模型位於 `.models`。
APP 日誌在 `%LOCALAPPDATA%\ShenKaraoke\karaoke.log`。
YouTube 部分影片可能因來源限制而無法擷取，請選其他來源或更新 yt-dlp。

## 驗證

提交前的防護修正、依賴漏洞與資訊洩漏檢查範圍見 [安全檢查紀錄](docs/SECURITY_REVIEW.md)。

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
node tests/frontend.test.cjs
# 額外的實際模型測試：會下載模型，產物保留在 tests/.smoke
.\.venv\Scripts\python.exe tests/smoke_ai.py
```

前端測試使用 DOM 替身驗證邏輯，不能取代瀏覽器視覺或聽感驗收。

## 打包

```powershell
.\.venv\Scripts\python.exe build_exe.py
```

打包包含 web、FFmpeg、EJS，並將 `.tools` 複製到 dist。AI 環境不內嵌進 exe：
在 exe 旁建立 `.venv-ai`，或設定 `KARAOKE_AI_PYTHON`。
直接使用 `.spec` 打包時，需自行將 `.tools` 放在 exe 同一目錄。
本次新版執行檔在 `dist-v2/karaoke-shen-v2.exe`，原 `dist` 保留舊版。
在目前專案中，新版 exe 也會尋找上層專案的 `.venv-ai`。
