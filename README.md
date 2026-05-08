# BIGO Action

Phần mềm desktop nhận **chat + quà** từ phòng live Bigo theo BIGO ID rồi phát hiệu ứng `mp3 / mp4 / webm`. Tương tự ý tưởng tool TikTok gift effect.

## Hai chế độ

### 🌐 Web Listener (mặc định, dùng được mọi BIGO ID đang LIVE)

App mở `https://www.bigo.tv/<BIGO_ID>` ngầm trong BrowserWindow Electron, inject preload-embed.js DOM-scrape chat/gift đã được player Bigo render. Không cần OAuth, không cần streamer authorize.

Quy trình:
1. Endpoint public `ta.bigo.tv/official_website/studio/getInternalStudioInfo` trả về `roomId/uid/alive/nick_name` từ BIGO ID (`siteId`).
2. Hidden window với `nodeIntegrationInSubFrames: true` load page Bigo.
3. Preload script poll DOM 800ms/lần, regex `/^Lv\.(\d+)\s+(.+?)\s*[:：]\s*(.+)$/u` tách chat. Pattern `sent (?:a )?<gift_name> ×N` tách gift. Hash dedup theo `level|user|content`.
4. Forward IPC sang renderer chính → hiển thị danh sách + tự trigger hiệu ứng theo mapping `gift_name → file`.

### 🔐 Open API (chính thức, cần streamer authorize)

Dùng nếu bạn tự là streamer hoặc có app đã được Bigo phê duyệt:

| Cần có | Lấy ở đâu |
|---|---|
| `app_id` + `client_secret` | Bigo Developer Console |
| `game_id` | Bigo cấp sau khi review app |
| `access_token` | OAuth callback khi streamer click vào game của bạn từ trong app Bigo |
| `openid` | Trả về cùng access_token |

Polling `/broom/pull_data` mỗi 2s, ping mỗi 30s. Doc: <https://github.com/yothen/Bigo-Open-Api/blob/main/danmu_data_api_cn.md>

## Cài đặt

```powershell
cd "$env:USERPROFILE\Desktop\BIGO Action"
npm install
npm start
```

## Cách dùng (Web Listener)

1. Bỏ file `.mp4 / .webm / .mp3 / .wav` vào `assets/effects/`.
2. Mở app → tab **🌐 Web Listener**.
3. Nhập BIGO ID đang live → **🔍 Check live** (xác nhận `🟢 LIVE`).
4. **▶ Bắt đầu nghe**. (Lần đầu có thể bấm **👁 Hiện cửa sổ Bigo** để verify page load OK.)
5. Chat và quà sẽ chảy vào panel "💬 Bình luận live" và "🎁 Quà đã nhận".
6. Vào tab **🎬 Hiệu ứng & Mapping** thêm `gift_name` (vd `お面`) → file `kitsune.mp4`. Lần sau khi có người tặng quà đó, app tự phát.

## Cấu trúc

```
BIGO Action/
├─ src/
│  ├─ main.js           # Electron main, IPC, OAuth client orchestration
│  ├─ preload.js        # Renderer bridge
│  ├─ bigo-client.js    # Open API polling client
│  ├─ web-embed.js      # Hidden BrowserWindow lifecycle
│  └─ preload-embed.js  # DOM scraper inject vào page Bigo
├─ renderer/
│  ├─ index.html, style.css, app.js
├─ assets/effects/      # mp3 / mp4 / webm hiệu ứng
├─ config/
│  ├─ settings.json     # auto-save credentials (gitignored)
│  └─ gift-mapping.json # gift_name|gift_id → file
└─ package.json
```

## Hạn chế đã biết

- Web Listener phụ thuộc vào HTML mà Bigo player render — Bigo đổi UI thì regex phải cập nhật. Pattern hiện tại (`Lv.X User : ...`) đã verify với UI tháng 5/2026.
- Gift trong Web Listener dùng `gift_name` làm khoá (Bigo không expose `gift_id` ra DOM). Mapping nên dùng tên emoji/text Bigo hiển thị.
- Open API mode: `/broom/ping` cần signature HMAC chưa triển khai — Bigo reset session sau ~2 phút không ping. Workaround: tự bấm Start lại nếu ngắt.
- Sử dụng cá nhân. Web scraping có thể vi phạm Bigo ToS — không khuyến khích phát hành thương mại.

## Stack

Electron 33 thuần, không build tool. Mọi logic trong vanilla JS.
