# v2 驗證記錄

日期：2026-10-03。

- 24 項 Python 回歸測試通過：YouTube 網址與 ID 驗證、格式相容性與空值、
  HTTP Range、斷線清理、來源標頭、安全快取路徑、失效快取、任務去重與取消程序。
  新增實際執行中的子程序進度、分段／多模型百分比、FFmpeg 進度、取消後拒絕舊更新與耗時測試。
- 前端 DOM 替身測試通過：清單內容安全輸出、缩圖來源限制、
  清空清單後拒絕舊播放請求、清單結束與 AI／原唱切換保留時間位置。
  新增進度條百分比、無法計算時的等待狀態、完成／取消顯示與耗時格式驗證。
- 真實 Eel 本機 HTTP／WebSocket 服務啟動通過，FFmpeg 與 AI 就緒檢查通過。
  加驗跨站 Origin、非本機 Host、cross-site 請求拒絕，WebSocket 握手前回傳 403，RPC 不回傳 traceback。
- PyTorch 2.10 CPU 與安全模型載入下，Demucs `htdemucs`／`htdemucs_ft` 均實測 3 秒合成音訊，產生雙聲道伴奏 WAV 與合成 MP4。
  同時確認取得實際 Demucs 分段進度及 FFmpeg 合成進度。
  此測試只驗證流程，未測量真實歌曲的分離音質。
- 公開 Blender 官方 Big Buck Bunny 影片成功解析相容的 1080p 影音軌，
  並實際收到包含 `moof` 的影音片段。擷取使用 IPv4，FFmpeg 沿用來源 HTTP 標頭。
- APP 與 AI 環境的 `pip check` 均通過。
  安全檢查及依賴掃描限制見 [提交前安全檢查](SECURITY_REVIEW.md)。
- 新版 exe 打包產物位於 `dist-v2`；本機 Windows 應用程式控制原則以 WinError 4551
  阻擋執行，因此未完成 exe 啟動驗證。Python 啟動方式已驗證。
- Browser 工具沒有可用連線，因此未完成瀏覽器視覺、實際媒體播放與聽感驗收。

目前的 `.venv` 基於本機可用的 Python 3.10.11。yt-dlp 已提示此版本支援將被移除，
新安裝建議 Python 3.11。AI 套件則固定在已通過本機實測的版本。
