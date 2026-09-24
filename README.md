# Chaska Backend

Zero-dependency Node.js server (Node 22.13+): REST API + realtime (SSE) + SQLite + OTP login.

## Local run
    DEMO_OTP=1 node server.js        # OTP hamesha 1234 (sirf testing)
    node test.mjs                    # 25 automatic tests

## Deploy (Render / Railway / any VPS with Node 22+)
Start command: `node server.js`. Environment variables:

| Name | Kaam |
|---|---|
| JWT_SECRET | **Zaroori.** Lamba random text (login tokens isse sign hote hain) |
| OWNER_PHONE | Owner ka number (default 9939834950) |
| FAST2SMS_KEY | Asli SMS OTP ke liye Fast2SMS key. (DEMO_OTP=1 mat rakhein production me) |
| REST_LAT, REST_LNG | Restaurant ke exact coordinates (Google Maps se) — distance inhi se banti hai |
| OFFER_SECONDS | Rider ke paas order accept karne ka time (default 30 sec) |
| VAPID_SUBJECT | `mailto:aapki-email@example.com` (push ke liye) |
| DB_FILE | SQLite file path. Render par persistent disk mount karke uska path dein |
| ALLOWED_ORIGIN | Front-end ka domain (default *) |

## Teen alag links (ek hi server)
- `https://aapka-domain/` → **sirf customer website** (isme owner/rider ka code hi nahi hai)
- `https://aapka-domain/rider` → **sirf delivery partner app** (OTP login)
- `https://aapka-domain/owner` → **sirf owner app** (OTP login)
Rider/owner links kisi ko mat bhejein; unke andar ghusne ke liye registered number + OTP chahiye aur server har request par token check karta hai.

Rider pop-up: customer order karte hi online riders ko pop-up + sound + vibration aata hai (jab tak swipe/decline na ho). Rider ko ek baar app me tap karna hota hai (phone ki rule: bina tap ke sound/vibration allow nahi). Customer se "location add" karwane par asli doori aur live map chalta hai.

Tests: `node test.mjs` (API) · `PW_PATH=$(npm root -g)/playwright node e2e.mjs` (browser: order → rider pop-up → swipe → delivery).

## API
Public: `GET /api/menu` · `POST /api/orders` · `GET /api/track/:id?phone=` · `POST /api/contact`
Auth: `POST /api/auth/otp` · `POST /api/auth/verify` → token (`Authorization: Bearer`)
Owner: `GET /api/owner/orders` · `POST /api/owner/orders/:id/status` · products / banners / partners (POST, PATCH, DELETE)
Rider: `GET /api/rider/state` · `POST /api/rider/online|location` · `POST /api/rider/accept|pickup|deliver/:id`
Realtime: `GET /api/stream?token=…` (owner/rider) ya `?track=ID&phone=…` (customer)

## Suraksha (jo already hai)
Server khud price nikalta hai (client ka total nahi maanta) · OTP hash hokar save, 5 galat try par lock, 5 min expiry · rate limits · role-based tokens · swipe race atomic (ek hi rider ko order milta hai) · photo size/type check.


## Rider ka notification (app ki tarah, phone ke upar)
- Rider `/rider` kholkar **Install** dabaye (Android Chrome) ya iPhone me *Share → Add to Home Screen* kare. Phir **Online** karte waqt Notification **Allow** kare.
- Order aate hi phone par upar notification aata hai (phone ki default notification sound + vibration ke saath), tap karte hi app khulta hai aur countdown chalta hai. Time khatam → offer apne aap hat jaata hai; owner "🔁 Dobara bhejein" se phir bhej sakta hai.
- App khula ho to app khud bell sound + vibration bajata hai.
- Ye sirf **HTTPS** (deployed domain) par chalta hai. Web se custom ringtone set nahi hoti — phone ki notification sound hi bajti hai.
