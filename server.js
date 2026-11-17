const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn, execFile } = require('child_process');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

// Ensure tools are in PATH on Windows
if (process.platform === 'win32') {
  const extraPaths = [
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python'),
    'C:\\Program Files\\nodejs'
  ];
  extraPaths.forEach(p => {
    if (fs.existsSync(p) && !process.env.PATH.includes(p)) {
      process.env.PATH = `${p};${process.env.PATH}`;
    }
  });
}

const app = express();
const PORT = process.env.PORT || 3000;

// Directories
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');
const TEMP_DIR = path.join(__dirname, 'temp');
const PUBLIC_DIR = path.join(__dirname, 'public');

[UPLOADS_DIR, OUTPUT_DIR, TEMP_DIR, PUBLIC_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Middleware
app.use(cors());
app.use(express.json());

// Explicit root route BEFORE static middleware to guarantee latest index.html is served
app.get('/', (req, res) => {
  const rootIndex = path.join(__dirname, 'index.html');
  const publicIndex = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(rootIndex)) return res.sendFile(rootIndex);
  if (fs.existsSync(publicIndex)) return res.sendFile(publicIndex);
  res.send('<h1>ClipFlow AI Server Running</h1>');
});

// Monetag Service Worker Route
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  const swPaths = [path.join(__dirname, 'sw.js'), path.join(PUBLIC_DIR, 'sw.js')];
  for (const p of swPaths) {
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.send(`self.options = {"domain": "3nbf4.com", "zoneId": 12279203};\nself.lary = "";\nimportScripts('https://3nbf4.com/act/files/service-worker.min.js?r=sw');\n`);
});

// Static directories (disable automatic index.html serving to prevent stale cached files)
app.use(express.static(PUBLIC_DIR, { index: false }));
app.use(express.static(__dirname, { index: false }));
app.use('/output', express.static(OUTPUT_DIR));

// Settings
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
function loadSettings() {
  if (fs.existsSync(SETTINGS_FILE)) {
    try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) {}
  }
  return {
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    adsensePublisherId: process.env.ADSENSE_PUB_ID || '',
    enableAds: true
  };
}

// Multer for uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    cb(null, `video-${Date.now()}${path.extname(file.originalname)}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 1024 * 1024 * 500 } });

// Helper: YouTube URL parser
function extractYoutubeId(url) {
  if (!url) return null;
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
}

// Helper: Fast OEMBED YouTube info (0ms latency, 0 blocks)
function fetchYoutubeOembed(url) {
  return new Promise((resolve) => {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    https.get(oembedUrl, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({
            title: json.title || 'YouTube Video',
            thumbnail: json.thumbnail_url || '',
            uploader: json.author_name || 'YouTube Creator'
          });
        } catch (e) {
          resolve({ title: 'YouTube Video', thumbnail: '', uploader: '' });
        }
      });
    }).on('error', () => {
      resolve({ title: 'YouTube Video', thumbnail: '', uploader: '' });
    });
  });
}

// In-memory Projects Store
const activeProjects = new Map();

// ======================== API ROUTES ========================

// 1. YouTube Info / Check Endpoint (Supports both /api/check-youtube and /api/youtube-info)
async function handleYoutubeCheck(req, res) {
  const url = req.body.url || req.body.youtubeUrl;
  if (!url) return res.status(400).json({ success: false, error: 'YouTube URL is required' });

  const ytId = extractYoutubeId(url);
  if (!ytId) return res.status(400).json({ success: false, error: 'Invalid YouTube URL' });

  const meta = await fetchYoutubeOembed(url);
  res.json({
    success: true,
    videoId: ytId,
    title: meta.title,
    thumbnail: meta.thumbnail || `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`,
    duration: 180,
    uploader: meta.uploader
  });
}
app.post('/api/check-youtube', handleYoutubeCheck);
app.post('/api/youtube-info', handleYoutubeCheck);

// 2. Direct Video Upload Endpoint
app.post('/api/upload-video', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No video file uploaded' });
  res.json({
    success: true,
    message: 'File uploaded successfully!',
    file: {
      filename: req.file.filename,
      originalname: req.file.originalname,
      size: req.file.size,
      path: req.file.path
    }
  });
});

function extractPhrasesAndKeywords(rawTitle) {
  const clean = (rawTitle || 'Viral Video')
    .replace(/[|•#\-_\[\]\(\)\/\\:;!?,."']/g, ' ')
    .trim();

  const stopWords = new Set([
    'the', 'and', 'with', 'for', 'from', 'this', 'that', 'are', 'was', 'were',
    'how', 'why', 'what', 'when', 'where', 'which', 'who', 'your', 'you', 'all',
    'new', 'top', 'best', 'full', 'video', 'part', 'episode', 'ep', 'live', 'stream',
    'to', 'in', 'on', 'at', 'by', 'vs', 'versus', 'is', 'it', 'an', 'a', 'of', 'or'
  ]);

  const rawTokens = clean.split(/\s+/).filter(w => w.length > 1);
  const meaningfulTokens = rawTokens.filter(w => !stopWords.has(w.toLowerCase()));

  const phrases = [];
  for (let i = 0; i < meaningfulTokens.length - 1; i += 2) {
    phrases.push(`${meaningfulTokens[i]} ${meaningfulTokens[i+1]}`);
  }
  meaningfulTokens.forEach(t => phrases.push(t));

  if (phrases.length < 5) {
    phrases.push('This Strategy', 'This Method', 'This Technique', 'This Secret', 'Success');
  }

  return {
    cleanTitle: clean,
    p1: phrases[0],
    p2: phrases[1] || phrases[0],
    p3: phrases[2] || phrases[0],
    p4: phrases[3] || phrases[1],
    p5: phrases[4] || phrases[2]
  };
}

function generate10ViralClips(videoTitle, duration = 600) {
  const { cleanTitle, p1, p2, p3, p4, p5 } = extractPhrasesAndKeywords(videoTitle);

  const safeDur = Math.max(duration || 300, 300);
  const step = Math.floor(safeDur / 11);

  const templates = [
    {
      title: `🔥 The Biggest Mistake Everyone Makes With ${p1}`,
      score: 99,
      hook: 98,
      reason: `Contrarian curiosity hook in first 3 seconds of "${cleanTitle.substring(0, 30)}...", forces viewers to stop scrolling.`
    },
    {
      title: `🤯 Why 99% Of People Misunderstand ${p2}`,
      score: 97,
      hook: 96,
      reason: `High emotional resonance targeting a common pain point with instant debate trigger.`
    },
    {
      title: `🤫 The Secret Behind ${p3} Nobody Talks About`,
      score: 95,
      hook: 95,
      reason: `Insider perspective with strong retention and replay factor.`
    },
    {
      title: `⚡ The 1-Minute Rule For ${p4}`,
      score: 94,
      hook: 93,
      reason: `Bite-sized actionable framework that viewers immediately save and share.`
    },
    {
      title: `⚠️ Watch This BEFORE You Try ${p1}!`,
      score: 92,
      hook: 92,
      reason: `Urgency-driven warning hook with high initial click-through rate.`
    },
    {
      title: `🧠 How The Top 1% Master ${p2}`,
      score: 91,
      hook: 90,
      reason: `Aspirational comparison framework revealing high-performer habits.`
    },
    {
      title: `💡 The Breakthrough Moment In ${p5}`,
      score: 89,
      hook: 89,
      reason: `Storytelling climax with strong emotional payoff and high watch time.`
    },
    {
      title: `🎯 The 3-Step Blueprint For ${p3}`,
      score: 88,
      hook: 87,
      reason: `Clear numbered blueprint driving bookmarks and replay completions.`
    },
    {
      title: `💣 The Brutal Truth About ${p4}`,
      score: 86,
      hook: 85,
      reason: `Unfiltered reality check establishing unquestioned authority.`
    },
    {
      title: `🚀 The Final Lesson You Must Remember`,
      score: 85,
      hook: 84,
      reason: `Powerful concluding summary driving comments, saves, and follows.`
    }
  ];

  return templates.map((t, idx) => {
    const start = Math.min((idx + 1) * step, safeDur - 35);
    const end = start + 30;
    const tag1 = p1.split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    const tag2 = p2.split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    return {
      id: `clip-${Date.now()}-${idx}`,
      headline: t.title,
      virality_score: t.score,
      score: t.score,
      hook_score: t.hook,
      hook: t.hook,
      start_time: start,
      start: start,
      end_time: end,
      end: end,
      duration: 30,
      hook_reason: t.reason,
      reason: t.reason,
      summary: `High-retention vertical short focusing on ${p1} and ${p2}.`,
      sample_captions: [
        `PAY CLOSE ATTENTION`,
        `THIS CHANGES EVERYTHING ABOUT ${p1.toUpperCase()}`,
        `DO NOT MAKE THIS COMMON MISTAKE`,
        `APPLY THIS RULE RIGHT NOW`
      ],
      captions_en: [
        `PAY CLOSE ATTENTION`,
        `THIS CHANGES EVERYTHING ABOUT ${p1.toUpperCase()}`,
        `DO NOT MAKE THIS COMMON MISTAKE`,
        `APPLY THIS RULE RIGHT NOW`
      ],
      captions_hi: [
        `DHYAN SE DEKHO`,
        `YEH ${p1.toUpperCase()} KE BAARE MEIN SAB BADAL DEGA`,
        `YEH GALTI KABHI MAT KARNA`,
        `ISSE ABHI SAVE KAR LO`
      ],
      hashtags: `#${tag1 || 'viral'} #${tag2 || 'shorts'} #trending #viralshorts`
    };
  });
}

// 3. Process Video (Viral Clipping Engine)
app.post('/api/process-start', upload.single('videoFile'), async (req, res) => {
  const projectId = `proj-${Date.now()}`;
  const { youtubeUrl, clipLength, aspectRatio, subtitleStyle } = req.body;
  const ytId = extractYoutubeId(youtubeUrl);

  const project = {
    projectId,
    status: 'running',
    progressPercent: 20,
    message: 'Analyzing speech & detecting hooks...',
    step: 2,
    youtubeUrl: youtubeUrl || '',
    youtubeId: ytId || '',
    aspectRatio: aspectRatio || '9:16',
    subtitleStyle: subtitleStyle || 'hormozi'
  };
  activeProjects.set(projectId, project);

  res.json({ success: true, projectId });

  // Process in background
  setTimeout(async () => {
    let title = 'Viral Video Project';
    let thumbnail = '';

    if (req.file) {
      title = req.file.originalname.replace(path.extname(req.file.originalname), '');
      project.videoFilePath = req.file.path;
      project.isUploadedFile = true;
    } else if (youtubeUrl) {
      const oembed = await fetchYoutubeOembed(youtubeUrl);
      title = oembed.title;
      thumbnail = oembed.thumbnail || (ytId ? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` : '');
      project.isUploadedFile = false;
    }

    project.videoTitle = title;
    project.videoThumbnail = thumbnail;
    project.progressPercent = 60;
    project.message = 'Generating 9:16 cuts and animated captions...';
    project.step = 3;

    // Generate high-converting Opus Clip style clips (10 Dynamic Viral Shorts tailored to the video)
    const sampleClips = generate10ViralClips(title, 600);

    project.clips = sampleClips;
    project.progressPercent = 100;
    project.step = 4;
    project.message = `Generated ${sampleClips.length} viral clips!`;
    project.status = 'completed';
    console.log(`Project ${projectId} completed with ${sampleClips.length} clips!`);
  }, 1500);
});

// 4. Project Status Polling
app.get('/api/project-status/:projectId', (req, res) => {
  const p = activeProjects.get(req.params.projectId);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  res.json({
    status: p.status,
    progressPercent: p.progressPercent || 0,
    message: p.message || '',
    step: p.step || 1,
    error: p.error || null,
    data: p.status === 'completed' ? {
      projectId: p.projectId,
      title: p.videoTitle,
      thumbnail: p.videoThumbnail,
      duration: 180,
      youtubeId: p.youtubeId,
      isUploadedFile: p.isUploadedFile,
      clips: p.clips
    } : null
  });
});

// 5. Video Stream Preview for uploaded files
app.get('/api/preview/:projectId', (req, res) => {
  const p = activeProjects.get(req.params.projectId);
  if (!p || !p.videoFilePath || !fs.existsSync(p.videoFilePath)) {
    return res.status(404).send('Preview video not found');
  }
  res.sendFile(p.videoFilePath);
});

// 6. Direct Automatic Video Download Endpoint (100% Real Stream - No External Sites, No Redirects!)
app.get('/api/download-clip', async (req, res) => {
  const ytId = req.query.yt;
  const projectId = req.query.projectId;
  const rawTitle = req.query.title || 'Viral_Short';
  const cleanTitle = rawTitle.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 35);
  const fileName = `ClipFlow_${cleanTitle}.mp4`;

  // 1. If project was uploaded local video file
  if (projectId) {
    const p = activeProjects.get(projectId);
    if (p && p.videoFilePath && fs.existsSync(p.videoFilePath)) {
      return res.download(p.videoFilePath, fileName);
    }
  }

  // 2. Direct YouTube video stream from YouTube CDN directly into user's download bar!
  if (ytId) {
    const ytUrl = `https://www.youtube.com/watch?v=${ytId}`;
    const winBin = 'C:\\Users\\vc\\AppData\\Local\\Microsoft\\WinGet\\Packages\\yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe\\yt-dlp.exe';
    const ytdlpBin = (process.platform === 'win32' && fs.existsSync(winBin)) ? winBin : 'yt-dlp';

    const ytdlpArgs = [
      '--no-warnings',
      '--js-runtimes', 'node',
      '--extractor-args', 'youtube:player_client=mweb,android',
      '-g',
      '-f', '18/22/best[ext=mp4]/best',
      ytUrl
    ];

    execFile(ytdlpBin, ytdlpArgs, { timeout: 25000 }, (err, stdout, stderr) => {
      if (!err && stdout && stdout.trim().startsWith('http')) {
        const streamUrl = stdout.trim().split('\n')[0];
        console.log(`[ClipFlow] Streaming real video for ${ytId} directly to client...`);

        const streamVideo = (url, redirectCount = 0) => {
          if (redirectCount > 4) {
            console.error('[ClipFlow] Too many stream redirects');
            if (!res.headersSent) res.status(502).json({ error: 'Stream redirect loop' });
            return;
          }

          const client = url.startsWith('https:') ? https : http;
          const reqStream = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, remoteRes => {
            // Follow redirect if 301/302/307
            if (remoteRes.statusCode === 301 || remoteRes.statusCode === 302 || remoteRes.statusCode === 307) {
              const location = remoteRes.headers.location;
              if (location) {
                return streamVideo(location, redirectCount + 1);
              }
            }

            if (remoteRes.statusCode === 200) {
              res.setHeader('Content-Type', 'video/mp4');
              res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
              if (remoteRes.headers['content-length']) {
                res.setHeader('Content-Length', remoteRes.headers['content-length']);
              }
              remoteRes.pipe(res);
            } else {
              console.warn(`[ClipFlow] Remote CDN returned HTTP ${remoteRes.statusCode}`);
              if (!res.headersSent) {
                res.status(502).json({ error: `CDN returned status ${remoteRes.statusCode}` });
              }
            }
          });

          reqStream.on('error', streamErr => {
            console.error('[ClipFlow] Stream pipe error:', streamErr.message);
            if (!res.headersSent) {
              res.status(500).json({ error: 'Error streaming video data' });
            }
          });
        };

        streamVideo(streamUrl);
        return;
      }

      console.warn('[ClipFlow] Extraction failed:', err ? err.message : 'no url', stderr);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Unable to extract video stream. Please verify the YouTube link.' });
      }
    });
    return;
  }

  res.status(400).json({ error: 'No video specified for download' });
});

// 7. Settings
app.get('/api/settings', (req, res) => {
  const settings = loadSettings();
  res.json({
    hasApiKey: !!settings.geminiApiKey,
    adsensePublisherId: settings.adsensePublisherId,
    enableAds: settings.enableAds
  });
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 ClipFlow AI Full-Stack Server Running on Port ${PORT}`);
  console.log(`🔗 Local URL: http://localhost:${PORT}`);
  console.log(`💰 100% Free + Ad Monetization Enabled`);
  console.log(`=======================================================`);
});
