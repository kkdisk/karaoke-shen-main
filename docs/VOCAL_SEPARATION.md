# 人聲分離方案與驗證

本版目標是「盡量保留伴奏、減少人聲」，不保證完全消除人聲或完全不影響樂器。
沒有使用真實歌曲進行主觀聽感評比，不能以本版測試宣稱模型音質提升了多少。

## 為何改用音源分離

舊版 L−R 會同時消除中央定位的人聲與樂器，且將伴奏變成單聲道後再使用延遲製造寬度。
EQ、音量補償及低音回填不能重建已被消除的中央樂器。

新版提供兩條路徑：

| 路徑 | 方法 | 優點 | 限制 |
|---|---|---|---|
| 快速歡唱 | 保留原始 L/R，只減去約 300–6000Hz 的中央訊號 | 即時、保留頻帶外的立體聲資訊、可調削弱比例 | 同頻帶中央樂器仍會受影響，頻帶外人聲仍可能保留 |
| AI 伴奏 | Demucs Hybrid Transformer 分離，將 no_vocals 合成回原影片 | 不依賴人聲位於中央，可保留中央伴奏與雙聲道結構 | 須先處理整首、需要記憶體，可能有人聲殘留或分離瑕疵 |

AI 伴奏不再次經過中央相減、假立體聲或低音回填。EQ 預設平直，伴奏增益預設 1，
輸出端的壓縮器只用於抑制高音量峰值；它不是噪音閘，也不是絕對防削波保證。

## 模型選擇

- 預設 `htdemucs`：先讓一般 CPU 環境能使用。
- `htdemucs_ft`：官方提供的 fine-tuned 模型；官方指出處理約需四倍時間，可能有更好的結果。
  在 PowerShell 設定 `$env:KARAOKE_AI_MODEL='htdemucs_ft'` 後重新啟動。
  目前同一首歌只保留一個模型版本的成果，模型切換會重新製作。
- BS-RoFormer / Mel-Band RoFormer：列為後續候選。研究顯示其音源分離表現有競爭力，
  但模型權重、訓練資料、硬體需求與設定各異，本版未整合或實測，不能宣稱優於目前方案。

Demucs 原 Meta repository 已封存，作者的 fork 以重要修正為主。本版透過独立 Python 程序隔離依賴，
後續可替换分離引擎，而不必修改串流或清單介面。

## 驗證結果與後續音質評估

已實測 3 秒、44.1kHz、雙聲道合成音訊：模型載入、no_vocals WAV 產生、
影片與伴奏合成皆成功。這是流程驗證，不是音質證據。

音質驗收需要取得有原始獨立人聲與伴奏的授權音源，至少包含男／女人聲、合唱、
殘響、單聲道與中央定位鼓／貝斯。對同一混音比較原版 L−R、新版快速模式、
htdemucs、htdemucs_ft 與候選 RoFormer。先將音量匹配，再盲聽人聲殘留、
鼓／貝斯保留、瞬態損傷與立體聲定位；有參考 stem 時再計算 SDR／SI-SDR。

## 一手來源

- [Demucs 官方實作與使用說明](https://github.com/facebookresearch/demucs)
- [Demucs 作者維護的 fork](https://github.com/adefossez/demucs)
- [BS-RoFormer 論文](https://arxiv.org/abs/2309.02612)
- [Mel-Band RoFormer 論文](https://arxiv.org/abs/2310.01809)
- [Music Source Separation Training 作者實作](https://github.com/ZFTurbo/Music-Source-Separation-Training)
- [yt-dlp 官方 EJS 安裝指南](https://github.com/yt-dlp/yt-dlp/wiki/EJS)
