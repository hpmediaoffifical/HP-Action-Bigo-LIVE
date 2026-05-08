# BIGO Action

Phần mềm desktop nhận quà từ phòng live Bigo qua **Bigo Open API** rồi phát hiệu ứng `mp3 / mp4 / webm`. Tương tự ý tưởng các tool TikTok gift effect, **nhưng cơ chế khác** vì Bigo không có WebSocket/Webhook public.

## Bigo vs TikTok — đọc trước khi dùng

| | TikTok-Live-Connector | Bigo Open API |
|---|---|---|
| Auth | Không cần (reverse-engineer WebSocket public) | OAuth2 Bearer + game_id Bigo cấp |
| Cách listen | WebSocket push | **Polling** `/broom/pull_data` mỗi 2s |
| Streamer phải làm gì? | Không | **Phải authorize app + nhúng game** vào phòng (deeplink `deeplink://game?openId=...&gameId=...`) |
| Chỉ cần ID là chạy? | ✅ | ❌ Cần `openid` (lấy từ OAuth flow), không phải BIGO ID public |

→ App này chỉ chạy được nếu bạn có:
1. `app_id` + `client_secret` từ Bigo Developer Console
2. `game_id` đã được Bigo phê duyệt
3. `openid` của streamer (sau khi họ click vào game của bạn từ trong app Bigo)
4. `access_token` OAuth còn hạn

Doc gốc: <https://github.com/yothen/Bigo-Open-Api/blob/main/danmu_data_api_cn.md>

## Cài đặt

```powershell
cd "$env:USERPROFILE\Desktop\BIGO Action"
npm install
npm start
```

## Cách dùng

1. Bỏ file hiệu ứng `.mp4 / .webm / .mp3 / .wav` vào `assets/effects/`.
2. Mở app → tab **Kết nối** điền `env / openid / game_id / access_token` → bấm **Lưu**.
3. Bấm **Test gift** để chắc chắn UI và phát hiệu ứng OK.
4. Vào tab **Mapping** thêm `gift_id` → file hiệu ứng (xem `gift_id` trong tab **Sự kiện** khi quà thật về).
5. Bấm **Kết nối & nghe quà** — app gọi `/broom/enable_danmu` rồi poll `/broom/pull_data` mỗi 2s.

## Cấu trúc

```
BIGO Action/
├─ src/
│  ├─ main.js           # Electron main, IPC, polling loop
│  ├─ preload.js        # IPC bridge
│  └─ bigo-client.js    # Bigo Open API wrapper
├─ renderer/
│  ├─ index.html, style.css, app.js
├─ assets/effects/      # mp3 / mp4 / webm hiệu ứng
├─ config/
│  ├─ settings.json     # auto-save credentials
│  └─ gift-mapping.json # gift_id → file
└─ package.json
```

## Hạn chế đã biết

- `/broom/ping` (keepalive 30s) yêu cầu signature header (HMAC) — chưa triển khai. Bigo sẽ reset session sau ~2 phút không ping → giải pháp tạm: client tự gọi lại `enable_danmu` khi thấy lỗi.
- App chưa hỗ trợ OAuth flow — bạn phải tự lấy `access_token` từ Bigo Developer Console hoặc backend riêng.
- Polling 2s → độ trễ sự kiện 1-3s (không real-time tuyệt đối như TikTok).
