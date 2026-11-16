// ClipFlow AI - Frontend Controller

let currentProjectId = null;
let currentClips = [];
let activeClip = null;
let selectedFile = null;
let subtitleTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initUpload();
  initYouTube();
  initSettings();
  initPlayer();
  initRender();
});

// 1. Tab Switching
function initTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const target = tab.dataset.tab;
      document.getElementById('youtubeTab').classList.toggle('active', target === 'youtube');
      document.getElementById('uploadTab').classList.toggle('active', target === 'upload');
    });
  });
}

// 2. YouTube Input & Preview
function initYouTube() {
  const ytInput = document.getElementById('youtubeUrlInput');
  const fetchBtn = document.getElementById('fetchYtBtn');
  const previewCard = document.getElementById('ytPreviewCard');
  const ytThumb = document.getElementById('ytThumb');
  const ytTitle = document.getElementById('ytTitle');
  const ytDuration = document.getElementById('ytDuration');

  async function checkUrl() {
    const url = ytInput.value.trim();
    if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
      alert('Please enter a valid YouTube URL');
      return;
    }

    fetchBtn.textContent = 'Checking...';
    try {
      const res = await fetch('/api/youtube-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      ytThumb.src = data.thumbnail;
      ytTitle.textContent = data.title;
      const min = Math.floor(data.duration / 60);
      const sec = Math.floor(data.duration % 60);
      ytDuration.textContent = `Duration: ${min}m ${sec}s`;
      previewCard.classList.remove('hidden');
    } catch (e) {
      console.warn('Could not load preview:', e.message);
      // We still allow processing even if preview fails
    } finally {
      fetchBtn.textContent = 'Check';
    }
  }

  fetchBtn.addEventListener('click', checkUrl);
  ytInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') checkUrl();
  });
}

// 3. File Upload Drag & Drop
function initUpload() {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('videoFileInput');
  const selectedInfo = document.getElementById('selectedFileInfo');
  const fileNameSpan = document.getElementById('selectedFileName');
  const removeBtn = document.getElementById('removeFileBtn');

  ['dragenter', 'dragover'].forEach(name => {
    dropZone.addEventListener(name, (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(name => {
    dropZone.addEventListener(name, (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length > 0) handleFile(files[0]);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) handleFile(fileInput.files[0]);
  });

  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    selectedFile = null;
    fileInput.value = '';
    selectedInfo.classList.add('hidden');
    dropZone.querySelector('.drop-content').classList.remove('hidden');
  });

  function handleFile(file) {
    if (!file.type.startsWith('video/')) {
      alert('Please upload a valid video file (MP4, MOV, WebM)');
      return;
    }
    selectedFile = file;
    fileNameSpan.textContent = `${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)`;
    selectedInfo.classList.remove('hidden');
    dropZone.querySelector('.drop-content').classList.add('hidden');
  }
}

// 4. Generate Button & Real-time AI Processing
let pollingInterval = null;

document.getElementById('generateBtn').addEventListener('click', async () => {
  const isYtTab = document.querySelector('.tab-btn[data-tab="youtube"]').classList.contains('active');
  const ytUrl = document.getElementById('youtubeUrlInput').value.trim();
  const clipLength = document.getElementById('clipLengthSelect').value;
  const aspectRatio = document.getElementById('aspectRatioSelect').value;
  const subtitleStyle = document.getElementById('subtitleStyleSelect').value;

  if (isYtTab && !ytUrl) {
    alert('Please enter a YouTube video URL');
    return;
  }
  if (!isYtTab && !selectedFile) {
    alert('Please select or drop a video file');
    return;
  }

  // Show processing section
  document.querySelector('.hero-section').classList.add('hidden');
  document.getElementById('processingSection').classList.remove('hidden');
  document.getElementById('resultsSection').classList.add('hidden');

  const statusText = document.getElementById('processStatusText');
  const progressFill = document.getElementById('liveProcessFill');
  statusText.textContent = 'Initializing video ingestion...';
  progressFill.style.width = '8%';
  animateStep(1);

  try {
    let startRes;
    if (isYtTab) {
      startRes = await fetch('/api/process-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          youtubeUrl: ytUrl,
          clipLength,
          aspectRatio,
          subtitleStyle
        })
      });
    } else {
      const formData = new FormData();
      formData.append('videoFile', selectedFile);
      formData.append('clipLength', clipLength);
      formData.append('aspectRatio', aspectRatio);
      formData.append('subtitleStyle', subtitleStyle);

      startRes = await fetch('/api/process-start', {
        method: 'POST',
        body: formData
      });
    }

    const startData = await startRes.json();
    if (!startData.success) throw new Error(startData.error || 'Failed to start processing');

    currentProjectId = startData.projectId;

    // Start Real-Time Progress Polling
    if (pollingInterval) clearInterval(pollingInterval);
    pollingInterval = setInterval(async () => {
      try {
        const pollRes = await fetch(`/api/project-status/${currentProjectId}`);
        const pollData = await pollRes.json();

        if (pollData.error) {
          clearInterval(pollingInterval);
          throw new Error(pollData.error);
        }

        // Update live progress and status
        if (pollData.progressPercent) {
          progressFill.style.width = `${pollData.progressPercent}%`;
        }
        if (pollData.message) {
          statusText.textContent = pollData.message;
        }
        if (pollData.step) {
          animateStep(pollData.step);
        }

        // On complete
        if (pollData.status === 'completed' && pollData.data) {
          clearInterval(pollingInterval);
          currentClips = pollData.data.clips;
          showResults(pollData.data);
        }
      } catch (pollErr) {
        clearInterval(pollingInterval);
        alert('Processing error: ' + pollErr.message);
        document.querySelector('.hero-section').classList.remove('hidden');
        document.getElementById('processingSection').classList.add('hidden');
      }
    }, 800);

  } catch (err) {
    alert('Processing failed: ' + err.message);
    document.querySelector('.hero-section').classList.remove('hidden');
    document.getElementById('processingSection').classList.add('hidden');
  }
});

function animateStep(stepNum) {
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById(`step${i}`);
    if (i <= stepNum) el.classList.add('active');
    else el.classList.remove('active');
  }
}

// 5. Results Studio Display
function showResults(data) {
  document.getElementById('processingSection').classList.add('hidden');
  document.getElementById('resultsSection').classList.remove('hidden');

  document.getElementById('projectMetaSubtitle').textContent = 
    `Generated ${data.clips.length} viral clips from "${data.title}"`;
  document.getElementById('clipsCount').textContent = data.clips.length;

  // Setup video preview source
  const videoPlayer = document.getElementById('mainVideoPlayer');
  videoPlayer.src = `/api/preview/${data.projectId}`;

  // Populate clips list
  const listContainer = document.getElementById('clipsListContainer');
  listContainer.innerHTML = '';

  data.clips.forEach((clip, idx) => {
    const card = document.createElement('div');
    card.className = `clip-card ${idx === 0 ? 'active' : ''}`;
    card.dataset.clipId = clip.id;
    card.innerHTML = `
      <div class="clip-card-top">
        <h4 class="clip-card-title">${clip.headline}</h4>
        <span class="score-pill">🔥 ${clip.virality_score}/100</span>
      </div>
      <div class="clip-card-meta">
        <span>⏱️ ${(clip.end_time - clip.start_time).toFixed(1)}s</span>
        <span>🎯 Hook Score: ${clip.hook_score}/100</span>
      </div>
      <p class="clip-card-hook">${clip.hook_reason}</p>
    `;

    card.addEventListener('click', () => {
      document.querySelectorAll('.clip-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      selectClip(clip);
    });

    listContainer.appendChild(card);
  });

  if (data.clips.length > 0) {
    selectClip(data.clips[0]);
  }
}

// 6. Select and Play Clip
function selectClip(clip) {
  activeClip = clip;
  const videoPlayer = document.getElementById('mainVideoPlayer');
  const trimStart = document.getElementById('trimStartRange');
  const trimEnd = document.getElementById('trimEndRange');
  const startVal = document.getElementById('trimStartVal');
  const endVal = document.getElementById('trimEndVal');

  document.getElementById('activeClipHeadline').textContent = clip.headline;
  document.getElementById('activeClipScore').textContent = `Score: ${clip.virality_score}/100`;
  document.getElementById('activeClipReason').textContent = clip.hook_reason;

  // Set trim sliders
  trimStart.value = clip.start_time;
  trimEnd.value = clip.end_time;
  startVal.textContent = `${clip.start_time.toFixed(1)}s`;
  endVal.textContent = `${clip.end_time.toFixed(1)}s`;

  // Seek video
  videoPlayer.currentTime = clip.start_time;
  videoPlayer.play().catch(() => {});

  // Subtitles style update
  const stylePreset = document.getElementById('subtitleStyleSelect').value;
  const subOverlay = document.getElementById('subtitlesOverlay');
  subOverlay.className = `subtitles-overlay style-${stylePreset}`;

  // Start animated subtitle simulator
  startSubtitleAnimation(clip);
}

// 7. Subtitles Simulation on Preview Player
function startSubtitleAnimation(clip) {
  if (subtitleTimer) clearInterval(subtitleTimer);
  const videoPlayer = document.getElementById('mainVideoPlayer');
  const subText = document.getElementById('subtitlesText');
  const captions = clip.sample_captions || [
    "THIS SECRET CHANGED EVERYTHING",
    "WATCH CLOSELY",
    "APPLY THIS TODAY",
    "RESULTS GUARANTEED"
  ];

  videoPlayer.ontimeupdate = () => {
    // Loop back if passed end_time
    const currentEnd = parseFloat(document.getElementById('trimEndRange').value);
    const currentStart = parseFloat(document.getElementById('trimStartRange').value);

    if (videoPlayer.currentTime >= currentEnd || videoPlayer.currentTime < currentStart) {
      videoPlayer.currentTime = currentStart;
    }

    // Determine which subtitle line to show
    const clipProgress = (videoPlayer.currentTime - currentStart) / Math.max(1, currentEnd - currentStart);
    const lineIndex = Math.min(captions.length - 1, Math.floor(clipProgress * captions.length));
    if (captions[lineIndex]) {
      subText.textContent = captions[lineIndex].toUpperCase();
    }
  };
}

// 8. Player & Trim Controls
function initPlayer() {
  const trimStart = document.getElementById('trimStartRange');
  const trimEnd = document.getElementById('trimEndRange');
  const startVal = document.getElementById('trimStartVal');
  const endVal = document.getElementById('trimEndVal');
  const videoPlayer = document.getElementById('mainVideoPlayer');

  trimStart.addEventListener('input', () => {
    const s = parseFloat(trimStart.value);
    const e = parseFloat(trimEnd.value);
    if (s >= e) trimStart.value = e - 1;
    startVal.textContent = `${parseFloat(trimStart.value).toFixed(1)}s`;
    videoPlayer.currentTime = parseFloat(trimStart.value);
  });

  trimEnd.addEventListener('input', () => {
    const s = parseFloat(trimStart.value);
    const e = parseFloat(trimEnd.value);
    if (e <= s) trimEnd.value = s + 1;
    endVal.textContent = `${parseFloat(trimEnd.value).toFixed(1)}s`;
  });

  // "Create More Clips" button
  document.getElementById('newProjectBtn').addEventListener('click', () => {
    videoPlayer.pause();
    document.getElementById('resultsSection').classList.add('hidden');
    document.querySelector('.hero-section').classList.remove('hidden');
  });
}

// 9. Render & HD Watermark-free Download
function initRender() {
  const downloadBtn = document.getElementById('renderAndDownloadBtn');
  const modal = document.getElementById('downloadModal');
  const actions = document.getElementById('downloadReadyActions');
  const directLink = document.getElementById('directDownloadLink');
  const progressFill = document.getElementById('renderProgressFill');
  const modalTitle = document.getElementById('downloadModalTitle');
  const closeModalBtn = document.getElementById('closeModalBtn');

  closeModalBtn.addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  downloadBtn.addEventListener('click', async () => {
    if (!currentProjectId || !activeClip) return;

    const startTime = parseFloat(document.getElementById('trimStartRange').value);
    const endTime = parseFloat(document.getElementById('trimEndRange').value);
    const subtitleStyle = document.getElementById('subtitleStyleSelect').value;
    const aspectRatio = document.getElementById('aspectRatioSelect').value;

    // Show download modal
    modal.classList.remove('hidden');
    actions.classList.add('hidden');
    progressFill.style.width = '30%';
    modalTitle.textContent = 'Rendering 1080p Clip (No Watermark)...';

    try {
      const res = await fetch('/api/render-clip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: currentProjectId,
          clipId: activeClip.id,
          startTime,
          endTime,
          subtitleStyle,
          aspectRatio,
          customCaptions: activeClip.sample_captions
        })
      });

      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Render failed');

      progressFill.style.width = '100%';
      modalTitle.textContent = '🎉 Your Free HD Clip Is Ready!';
      directLink.href = data.downloadUrl;
      directLink.download = data.fileName;
      actions.classList.remove('hidden');
    } catch (err) {
      alert('Error rendering clip: ' + err.message);
      modal.classList.add('hidden');
    }
  });
}

// 10. Settings & Ads Configuration Modal
function initSettings() {
  const openBtn = document.getElementById('openSettingsBtn');
  const modal = document.getElementById('settingsModal');
  const closeBtn = document.getElementById('closeSettingsModalBtn');
  const saveBtn = document.getElementById('saveSettingsBtn');
  const geminiInput = document.getElementById('geminiKeyInput');
  const adsenseInput = document.getElementById('adsenseIdInput');
  const enableAdsCheckbox = document.getElementById('enableAdsCheckbox');

  openBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      adsenseInput.value = data.adsensePublisherId || '';
      enableAdsCheckbox.checked = data.enableAds !== false;
    } catch (e) {}
    modal.classList.remove('hidden');
  });

  closeBtn.addEventListener('click', () => modal.classList.add('hidden'));

  saveBtn.addEventListener('click', async () => {
    const geminiApiKey = geminiInput.value.trim();
    const adsensePublisherId = adsenseInput.value.trim();
    const enableAds = enableAdsCheckbox.checked;

    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ geminiApiKey, adsensePublisherId, enableAds })
    });

    modal.classList.add('hidden');
    alert('Settings saved successfully!');
  });
}
