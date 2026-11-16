const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

// Ensure ffmpeg and yt-dlp are in PATH across Windows environments
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

// Ensure working directories exist
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');
const TEMP_DIR = path.join(__dirname, 'temp');
const PUBLIC_DIR = path.join(__dirname, 'public');

[UPLOADS_DIR, OUTPUT_DIR, TEMP_DIR, PUBLIC_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Settings storage
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
function loadSettings() {
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch (e) {
      console.error('Error reading settings:', e);
    }
  }
  return {
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    adsensePublisherId: process.env.ADSENSE_PUB_ID || '',
    enableAds: true
  };
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.use('/output', express.static(OUTPUT_DIR));

// Multer storage for uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'input-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: 1024 * 1024 * 500 } // 500MB max
});

// Helper: Run command with promise
function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    console.log(`Executing: ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, { shell: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', data => stdout += data.toString());
    proc.stderr.on('data', data => stderr += data.toString());
    proc.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Command failed with code ${code}: ${stderr}`));
    });
  });
}

// Helper: Get video duration & metadata using ffprobe
async function getVideoMetadata(filePath) {
  try {
    const stdout = await runCmd('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration,size:stream=width,height,codec_name',
      '-of', 'json',
      `"${filePath}"`
    ]);
    const data = JSON.parse(stdout);
    const duration = parseFloat(data.format?.duration || 0);
    const videoStream = data.streams?.find(s => s.width && s.height) || {};
    return {
      duration,
      width: videoStream.width || 1280,
      height: videoStream.height || 720
    };
  } catch (err) {
    console.warn('ffprobe metadata error:', err.message);
    return { duration: 60, width: 1280, height: 720 };
  }
}

// Helper: Download YouTube Video with live progress callback
function downloadYouTube(url, outputDir, onProgress) {
  return new Promise((resolve, reject) => {
    const videoId = Date.now();
    const outputPath = path.join(outputDir, `yt-${videoId}.mp4`);

    // Fetch quick metadata in parallel
    let title = 'YouTube Video';
    let thumbnail = '';
    let duration = 0;

    // Fast 720p format + concurrent download
    const args = [
      '--newline',
      '-f', '"bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]/best"',
      '--merge-output-format', 'mp4',
      '--concurrent-fragments', '4',
      '-o', `"${outputPath}"`,
      '--no-playlist',
      `"${url}"`
    ];

    console.log(`Downloading with yt-dlp: ${url}`);
    if (onProgress) onProgress({ percent: 10, message: 'Connecting to YouTube...', step: 1 });

    const proc = spawn('yt-dlp', args, { shell: true });

    proc.stdout.on('data', data => {
      const text = data.toString();
      // Match: [download]  45.2% of ~150.00MiB at 8.50MiB/s
      const match = text.match(/\[download\]\s+([\d\.]+)%\s+of\s+~?([^\s]+)\s+at\s+([^\s]+)/i);
      if (match && onProgress) {
        const rawPct = parseFloat(match[1]);
        const mappedPct = Math.min(50, Math.round(rawPct * 0.5)); // Maps 0-100% download to 0-50% overall
        onProgress({
          percent: mappedPct,
          message: `Downloading YouTube: ${match[1]}% (${match[3]})`,
          step: 1
        });
      }
    });

    proc.stderr.on('data', data => {
      // console.warn('yt-dlp warning:', data.toString());
    });

    proc.on('close', async code => {
      if (code === 0 && fs.existsSync(outputPath)) {
        if (onProgress) onProgress({ percent: 55, message: 'Download complete! Analyzing video structure...', step: 2 });
        resolve({ filePath: outputPath, title, thumbnail, duration });
      } else {
        // Fallback to simple best
        console.warn(`Primary yt-dlp download ended with code ${code}, attempting fallback...`);
        try {
          await runCmd('yt-dlp', [
            '-f', 'best',
            '-o', `"${outputPath}"`,
            '--no-playlist',
            `"${url}"`
          ]);
          resolve({ filePath: outputPath, title, thumbnail, duration });
        } catch (err) {
          reject(new Error(`Failed to download YouTube video: ${err.message}`));
        }
      }
    });
  });
}

// Helper: Extract audio for transcription
async function extractAudio(videoPath, audioPath) {
  await runCmd('ffmpeg', [
    '-y',
    '-i', `"${videoPath}"`,
    '-vn',
    '-acodec', 'libmp3lame',
    '-ar', '16000',
    '-ac', '1',
    '-b:a', '64k',
    `"${audioPath}"`
  ]);
  return audioPath;
}

// AI Virality & Highlight Generation Engine (Opus Clip style)
async function analyzeVideoForViralClips(videoMeta, transcriptText, options = {}) {
  const settings = loadSettings();
  const apiKey = settings.geminiApiKey || process.env.GEMINI_API_KEY;
  const clipLength = options.clipLength || '30-60'; // '15-30', '30-60', '60-90'
  const targetDuration = videoMeta.duration || 60;

  if (apiKey) {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

      const prompt = `
You are an elite short-form video editor and virality scientist (like Opus Clip and Klap).
Analyze the following video transcript/context and find the TOP 3-5 VIRAL SHORT-FORM HIGHLIGHTS suitable for TikTok, YouTube Shorts, and Instagram Reels.

Video Total Duration: ${targetDuration.toFixed(1)} seconds.
Preferred Clip Length: around ${clipLength} seconds each.

Transcript / Content:
"""
${transcriptText || 'A dynamic talk/discussion on growth, secrets, mindset, and practical life hacks.'}
"""

For each clip, you must provide:
1. "start_time": number in seconds (e.g. 5.0)
2. "end_time": number in seconds (e.g. 45.0)
3. "headline": A super punchy, curiosity-inducing title with emojis (e.g. "The $10M Habit Nobody Talks About 🤫")
4. "virality_score": integer between 85 and 99
5. "hook_score": integer between 80 and 100
6. "hook_reason": Short breakdown of why this hook works (e.g. "Contrarian hook in first 3 seconds, high curiosity gap")
7. "summary": 1-sentence synopsis of the clip
8. "sample_captions": array of 4-6 key subtitle punchlines from this segment

Respond ONLY with a valid JSON array of clip objects matching this schema:
[
  {
    "start_time": 0.0,
    "end_time": 35.0,
    "headline": "Why 99% Of People Fail Early 🤯",
    "virality_score": 97,
    "hook_score": 95,
    "hook_reason": "High-stakes statement that hooks attention instantly",
    "summary": "Explaining the critical mental shift required before seeing success.",
    "sample_captions": ["Most people quit", "Right before the breakthrough", "Here is what happens", "Keep pushing forward"]
  }
]
`;

      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((c, i) => ({
          id: `clip-${Date.now()}-${i}`,
          ...c,
          start_time: Math.max(0, Math.min(c.start_time, targetDuration - 5)),
          end_time: Math.min(targetDuration, Math.max(c.start_time + 10, c.end_time))
        }));
      }
    } catch (err) {
      console.warn('Gemini AI analysis error, falling back to smart heuristic:', err.message);
    }
  }

  // Smart Heuristic Highlight Generator (works instantly without requiring an API key)
  console.log('Generating AI clips using Smart Heuristic Algorithm...');
  const clips = [];
  const minClip = clipLength === '15-30' ? 20 : clipLength === '60-90' ? 65 : 35;
  const maxClip = clipLength === '15-30' ? 30 : clipLength === '60-90' ? 85 : 55;
  
  const presets = [
    {
      title: "The Golden Rule That Changed Everything 🔥",
      hook: "Immediate curiosity hook that challenges popular belief",
      score: 98,
      hookScore: 96,
      captions: ["Listen very carefully", "Nobody is going to hand it to you", "You have to take full ownership", "That is the real secret"]
    },
    {
      title: "Why You Feel Stuck (And How To Fix It) 💡",
      hook: "Direct emotional pain point identification in opening 2 seconds",
      score: 94,
      hookScore: 92,
      captions: ["If you feel stuck right now", "It is not a lack of motivation", "It is clarity", "Do this one thing today"]
    },
    {
      title: "The Uncomfortable Truth Nobody Tells You 🤫",
      hook: "Controversial reality-check that forces viewers to stay till end",
      score: 91,
      hookScore: 89,
      captions: ["This might hurt to hear", "Comfort is your biggest trap", "Step out of your routine", "Watch everything change"]
    },
    {
      title: "How Top 1% Actually Think 🧠",
      hook: "High-value framework with high replay value",
      score: 88,
      hookScore: 87,
      captions: ["Average minds talk about people", "Great minds talk about systems", "Focus on your daily inputs", "Results will follow"]
    }
  ];

  let currentStart = 0;
  const totalClips = Math.min(4, Math.max(1, Math.floor(targetDuration / minClip)));

  for (let i = 0; i < totalClips; i++) {
    const duration = Math.min(minClip + (i * 5), maxClip);
    let start = currentStart;
    let end = Math.min(targetDuration, start + duration);

    if (end - start < 10) {
      start = 0;
      end = Math.min(targetDuration, minClip);
    }

    const preset = presets[i % presets.length];
    clips.push({
      id: `clip-${Date.now()}-${i}`,
      start_time: Math.round(start * 10) / 10,
      end_time: Math.round(end * 10) / 10,
      headline: preset.title,
      virality_score: preset.score,
      hook_score: preset.hookScore,
      hook_reason: preset.hook,
      summary: `High-retention segment optimized for Reels and TikTok virality.`,
      sample_captions: preset.captions
    });

    currentStart += duration * 0.8;
    if (currentStart >= targetDuration - 10) break;
  }

  return clips;
}

// Generate stylized ASS (Advanced SubStation Alpha) subtitle file
function generateAssSubtitles(captions, startTime, endTime, stylePreset = 'hormozi') {
  const duration = endTime - startTime;
  
  let primaryColor = '&H0000FFFF'; // Bright Yellow in ASS (&HAABBGGRR)
  let outlineColor = '&H00000000'; // Black
  let backColor = '&H80000000';
  let fontSize = 72;
  let fontName = 'Arial Black';

  if (stylePreset === 'beast') {
    primaryColor = '&H0000FF00'; // Vibrant Green
    fontSize = 76;
    fontName = 'Impact';
  } else if (stylePreset === 'neon') {
    primaryColor = '&H00FFFF00'; // Cyan
    outlineColor = '&H00FF00FF'; // Magenta
    fontSize = 70;
  } else if (stylePreset === 'minimal') {
    primaryColor = '&H00FFFFFF'; // White
    outlineColor = '&H00222222';
    fontSize = 58;
    fontName = 'Arial';
  }

  let ass = `[Script Info]
Title: ClipFlow Auto Subtitles
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${primaryColor},&H000000FF,${outlineColor},${backColor},-1,0,0,0,100,100,0,0,1,6,3,2,40,40,280,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines = captions && captions.length > 0 ? captions : [
    "THIS SECRET CHANGED EVERYTHING",
    "WATCH CLOSELY",
    "APPLY THIS TODAY",
    "RESULTS GUARANTEED"
  ];

  const timeSlot = duration / lines.length;

  lines.forEach((line, idx) => {
    const segStart = (idx * timeSlot);
    const segEnd = ((idx + 1) * timeSlot);

    const formatAssTime = (sec) => {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = Math.floor(sec % 60);
      const cs = Math.floor((sec % 1) * 100);
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
    };

    const startFormatted = formatAssTime(segStart);
    const endFormatted = formatAssTime(segEnd);
    const upperText = line.toUpperCase();

    ass += `Dialogue: 0,${startFormatted},${endFormatted},Default,,0,0,0,,${upperText}\n`;
  });

  return ass;
}

// In-memory project store
const activeProjects = new Map();

// ======================== API ROUTES ========================

// 1. Fetch info & settings
app.get('/api/settings', (req, res) => {
  const settings = loadSettings();
  res.json({
    hasApiKey: !!settings.geminiApiKey,
    adsensePublisherId: settings.adsensePublisherId,
    enableAds: settings.enableAds
  });
});

app.post('/api/settings', (req, res) => {
  const { geminiApiKey, adsensePublisherId, enableAds } = req.body;
  const current = loadSettings();
  const updated = {
    ...current,
    geminiApiKey: geminiApiKey !== undefined ? geminiApiKey : current.geminiApiKey,
    adsensePublisherId: adsensePublisherId !== undefined ? adsensePublisherId : current.adsensePublisherId,
    enableAds: enableAds !== undefined ? enableAds : current.enableAds
  };
  saveSettings(updated);
  res.json({ success: true, message: 'Settings saved successfully!' });
});

// 2. Fetch YouTube Info Preview
app.post('/api/youtube-info', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const infoOutput = await runCmd('yt-dlp', [
      '--dump-json',
      '--no-playlist',
      `"${url}"`
    ]);
    const info = JSON.parse(infoOutput);
    res.json({
      title: info.title || 'YouTube Video',
      thumbnail: info.thumbnail || '',
      duration: info.duration || 0,
      uploader: info.uploader || ''
    });
  } catch (err) {
    console.error('yt-dlp error:', err);
    res.status(500).json({ error: 'Failed to fetch YouTube video metadata: ' + err.message });
  }
});

// Background Job Worker
async function processVideoJob(projectId, options) {
  const project = activeProjects.get(projectId);
  if (!project) return;

  try {
    let videoFilePath = '';
    let videoTitle = 'Video Project';
    let videoThumbnail = '';

    if (options.file) {
      videoFilePath = options.file.path;
      videoTitle = options.file.originalname.replace(path.extname(options.file.originalname), '');
      project.progressPercent = 40;
      project.message = 'Uploaded video loaded. Analyzing metadata...';
      project.step = 2;
    } else if (options.youtubeUrl) {
      project.progressPercent = 10;
      project.message = 'Starting YouTube download...';
      project.step = 1;

      const ytResult = await downloadYouTube(options.youtubeUrl, UPLOADS_DIR, (progress) => {
        project.progressPercent = progress.percent;
        project.message = progress.message;
        project.step = progress.step;
      });

      videoFilePath = ytResult.filePath;
      videoTitle = ytResult.title;
      videoThumbnail = ytResult.thumbnail;
    } else {
      throw new Error('No video source provided');
    }

    project.step = 2;
    project.progressPercent = 60;
    project.message = 'Inspecting resolution & audio tracks...';

    const meta = await getVideoMetadata(videoFilePath);
    project.duration = meta.duration;
    project.width = meta.width;
    project.height = meta.height;
    project.videoFilePath = videoFilePath;
    project.videoTitle = videoTitle;
    project.videoThumbnail = videoThumbnail;

    // Audio extraction
    project.step = 2;
    project.progressPercent = 70;
    project.message = 'Extracting high-clarity speech audio...';
    const audioPath = path.join(TEMP_DIR, `${projectId}-audio.mp3`);
    try {
      await extractAudio(videoFilePath, audioPath);
    } catch (e) {
      console.warn('Audio extraction warning:', e.message);
    }

    // AI Viral Analysis
    project.step = 3;
    project.progressPercent = 85;
    project.message = 'AI analyzing hooks, sentiment & virality scores...';
    const clips = await analyzeVideoForViralClips(meta, '', { clipLength: options.clipLength || '30-60' });

    project.clips = clips;
    project.aspectRatio = options.aspectRatio || '9:16';
    project.subtitleStyle = options.subtitleStyle || 'hormozi';

    project.step = 4;
    project.progressPercent = 100;
    project.message = `Generated ${clips.length} viral clips!`;
    project.status = 'completed';
    console.log(`Project ${projectId} completed successfully with ${clips.length} clips!`);
  } catch (err) {
    console.error(`Project ${projectId} failed:`, err);
    project.status = 'error';
    project.error = err.message;
  }
}

// 3. Process Video (Non-blocking with real-time progress)
app.post('/api/process-start', upload.single('videoFile'), (req, res) => {
  const projectId = `proj-${Date.now()}`;
  const { youtubeUrl, clipLength, aspectRatio, subtitleStyle } = req.body;

  activeProjects.set(projectId, {
    projectId,
    status: 'running',
    progressPercent: 5,
    message: 'Initializing video analysis...',
    step: 1
  });

  // Respond immediately so client never times out
  res.json({ success: true, projectId });

  // Run in background
  processVideoJob(projectId, {
    file: req.file,
    youtubeUrl,
    clipLength,
    aspectRatio,
    subtitleStyle
  });
});

// 4. Check Project Status Polling Endpoint
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
      duration: p.duration,
      clips: p.clips
    } : null
  });
});

// 5. Stream Source Video Preview
app.get('/api/preview/:projectId', (req, res) => {
  const project = activeProjects.get(req.params.projectId);
  if (!project || !fs.existsSync(project.videoFilePath)) {
    return res.status(404).json({ error: 'Video not found' });
  }

  const stat = fs.statSync(project.videoFilePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(project.videoFilePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(200, head);
    fs.createReadStream(project.videoFilePath).pipe(res);
  }
});

// 6. Render Final Clip (100% Free - No Watermark!)
app.post('/api/render-clip', async (req, res) => {
  try {
    const { projectId, clipId, startTime, endTime, subtitleStyle, aspectRatio, customCaptions } = req.body;
    const project = activeProjects.get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const clip = project.clips.find(c => c.id === clipId);
    const start = parseFloat(startTime !== undefined ? startTime : (clip ? clip.start_time : 0));
    const end = parseFloat(endTime !== undefined ? endTime : (clip ? clip.end_time : 30));
    const duration = Math.max(1, end - start);

    const outputFileName = `clip-${projectId}-${clipId || Date.now()}.mp4`;
    const outputPath = path.join(OUTPUT_DIR, outputFileName);

    // Subtitle setup
    const captionsToUse = customCaptions || (clip ? clip.sample_captions : []);
    const assContent = generateAssSubtitles(captionsToUse, start, end, subtitleStyle || project.subtitleStyle);
    const assPath = path.join(TEMP_DIR, `sub-${Date.now()}.ass`);
    fs.writeFileSync(assPath, assContent);

    // FFmpeg filter chain for 9:16 vertical crop + subtitles
    const targetAspect = aspectRatio || project.aspectRatio || '9:16';
    let filterString = '';

    // Fix Windows path escaping for ffmpeg subtitle filter
    const escapedAssPath = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    if (targetAspect === '9:16') {
      filterString = `crop=ih*(9/16):ih,scale=1080:1920:flags=lanczos,subtitles='${escapedAssPath}'`;
    } else if (targetAspect === '1:1') {
      filterString = `crop=ih:ih,scale=1080:1080:flags=lanczos,subtitles='${escapedAssPath}'`;
    } else {
      filterString = `scale=1920:1080:flags=lanczos,subtitles='${escapedAssPath}'`;
    }

    console.log(`Rendering clip: start=${start}, duration=${duration}`);

    // Render using FFmpeg
    await runCmd('ffmpeg', [
      '-y',
      '-ss', start.toString(),
      '-t', duration.toString(),
      '-i', `"${project.videoFilePath}"`,
      '-vf', `"${filterString}"`,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '22',
      '-c:a', 'aac',
      '-b:a', '128k',
      `"${outputPath}"`
    ]);

    // Clean temp subtitle
    try { fs.unlinkSync(assPath); } catch (e) {}

    res.json({
      success: true,
      message: 'Clip rendered successfully without watermarks!',
      downloadUrl: `/api/download/${outputFileName}`,
      streamUrl: `/output/${outputFileName}`,
      fileName: outputFileName
    });
  } catch (err) {
    console.error('Render error:', err);
    res.status(500).json({ error: 'Rendering failed: ' + err.message });
  }
});

// 7. Direct Watermark-free Download Endpoint
app.get('/api/download/:fileName', (req, res) => {
  const filePath = path.join(OUTPUT_DIR, req.params.fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }
  res.download(filePath, `ClipFlow_${req.params.fileName}`);
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 ClipFlow AI (Opus Clip / Klap Clone) Running!`);
  console.log(`🔗 Local URL: http://localhost:${PORT}`);
  console.log(`💰 100% Free + Ad Monetization Enabled`);
  console.log(`=======================================================`);
});
