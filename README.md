# ⚡ ClipFlow AI - 100% Free AI Video Clipper (Opus Clip & Klap Alternative)

Turn long videos (podcasts, speeches, interviews, YouTube videos) into viral shorts in 1 click with auto 9:16 vertical reframing and dynamic Alex Hormozi style animated subtitles.

---

## 🌟 Key Features
- **100% Free Forever**: No monthly subscriptions, no token limits, and **0 Watermarks**.
- **Monetized with Ads**: Built-in high-CTR ad slots (Leaderboard, Interstitial render modal, and Sidebar) for Google AdSense, Adsterra, or Media.net.
- **Dual Input Methods**:
  - Paste any YouTube link (fetches title, duration, and extracts video directly).
  - Drag & drop local video files (MP4, MOV, WebM).
- **AI Virality Scoring (Opus Clip Style)**:
  - Generates virality score (85 - 99/100).
  - Generates hook score, hook reasoning, and engaging headlines with emojis.
- **Auto 9:16 Vertical Cropping**:
  - Automatically reframes standard 16:9 widescreen videos into vertical TikTok / Instagram Reels / YouTube Shorts format.
- **Dynamic Animated Subtitles**:
  - **Hormozi Gold**: Bold yellow/white with thick black drop shadow.
  - **MrBeast Pop**: Vibrant green and bold impact font.
  - **Neon Cyber**: Glowing cyan and magenta aesthetic.
  - **Clean Minimal**: Sleek white sans-serif.
- **Interactive Studio**:
  - Live video preview player.
  - Start/End sliders to fine-tune trim points.
  - One-click HD MP4 export powered by FFmpeg.

---

## 🚀 How to Run Locally

### Prerequisites
- Node.js (v18+)
- FFmpeg
- yt-dlp

### Quick Start
1. Double-click `start.bat` OR run in your terminal:
   ```bash
   node server.js
   ```
2. Open your browser and visit:
   ```
   http://localhost:3000
   ```

---

## 💰 How to Make Money with Ads (Monetization Guide)

### 1. Google AdSense Setup
1. Sign up at [Google AdSense](https://www.google.com/adsense/).
2. Add your domain and get your **Publisher ID** (e.g., `pub-1234567890123456`).
3. Open the **Settings & Ads** menu in the top right of ClipFlow AI and enter your Publisher ID.
4. Replace the demo ad slots in `public/index.html` with your AdSense `<ins class="adsbygoogle">` script tags.

### 2. High-Converting Ad Placement Architecture
- **Top Leaderboard (728x90 / Responsive)**: First visual impression when visitors arrive.
- **In-Stream Processing Ad**: Users wait 10-20 seconds while AI processes the video — this produces near **100% viewability**!
- **Download Modal Ad**: Users see an ad right before clicking "Save MP4 to Device".
- **Sidebar Rectangle (300x250)**: Sits beside the video preview player.

### 3. Estimated Ad Earnings
- With 1,000 video clips generated per day (~5,000 page views and 3,000 ad impressions):
  - Average CPM: \$3 - \$8 (Tier 1/Global traffic)
  - Estimated Daily Revenue: **\$15 - \$40 / day**
  - Estimated Monthly Revenue: **\$450 - \$1,200 / month** on pure autopilot.

---

## 🌐 Free / Low-Cost Hosting for Public Launch
To make your website live on the internet for free:
- **Render.com / Railway.app / VPS (Hetzner \$4/mo)**: Host the Node.js + FFmpeg backend.
- Connect your custom domain (e.g., `freevideoclipper.com`).
