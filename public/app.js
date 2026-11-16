document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('clipForm');
  const youtubeUrlInput = document.getElementById('youtubeUrl');
  const videoFileInput = document.getElementById('videoFile');
  const progressContainer = document.getElementById('progressContainer');
  const progressBar = document.getElementById('progressBar');
  const progressMessage = document.getElementById('progressMessage');
  const resultsContainer = document.getElementById('resultsContainer');
  const clipsList = document.getElementById('clipsList');

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const formData = new FormData();
      if (youtubeUrlInput && youtubeUrlInput.value) {
        formData.append('youtubeUrl', youtubeUrlInput.value);
      }
      if (videoFileInput && videoFileInput.files[0]) {
        formData.append('videoFile', videoFileInput.files[0]);
      }
      
      formData.append('clipLength', document.getElementById('clipLength')?.value || '30-60');
      formData.append('aspectRatio', document.getElementById('aspectRatio')?.value || '9:16');
      formData.append('subtitleStyle', document.getElementById('subtitleStyle')?.value || 'hormozi');

      try {
        if (progressContainer) progressContainer.style.display = 'block';
        if (resultsContainer) resultsContainer.style.display = 'none';
        if (progressMessage) progressMessage.textContent = 'Uploading & initializing analysis...';

        const res = await fetch('/api/process-start', {
          method: 'POST',
          body: formData
        });
        const data = await res.json();

        if (!data.success) {
          throw new Error(data.error || 'Failed to start processing');
        }

        const projectId = data.projectId;
        pollProjectStatus(projectId);

      } catch (err) {
        alert('Error: ' + err.message);
        if (progressContainer) progressContainer.style.display = 'none';
      }
    });
  }

  function pollProjectStatus(projectId) {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/project-status/${projectId}`);
        const status = await res.json();

        if (progressBar) progressBar.style.width = `${status.progressPercent}%`;
        if (progressMessage) progressMessage.textContent = status.message;

        if (status.status === 'completed') {
          clearInterval(interval);
          if (progressContainer) progressContainer.style.display = 'none';
          displayClips(status.data);
        } else if (status.status === 'error') {
          clearInterval(interval);
          alert('Processing failed: ' + status.error);
          if (progressContainer) progressContainer.style.display = 'none';
        }
      } catch (e) {
        console.error('Polling error:', e);
      }
    }, 2000);
  }

  function displayClips(data) {
    if (!resultsContainer) return;
    resultsContainer.style.display = 'block';
    if (clipsList) clipsList.innerHTML = '';

    data.clips.forEach((clip, index) => {
      const card = document.createElement('div');
      card.className = 'clip-card';
      card.innerHTML = `
        <h3>${clip.headline}</h3>
        <p><b>Virality Score:</b> 🚀 ${clip.virality_score}/100</p>
        <p><b>Duration:</b> ${clip.start_time}s - ${clip.end_time}s</p>
        <p>${clip.summary}</p>
        <button onclick="renderClip('${data.projectId}', '${clip.id}')" class="render-btn">Render Clip (Free)</button>
      `;
      clipsList.appendChild(card);
    });
  }
});

window.renderClip = async function(projectId, clipId) {
  alert('Rendering clip ' + clipId + '... Please wait a few seconds.');
  try {
    const res = await fetch('/api/render-clip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, clipId })
    });
    const data = await res.json();
    if (data.success) {
      window.open(data.downloadUrl, '_blank');
    } else {
      alert('Render failed: ' + data.error);
    }
  } catch (err) {
    alert('Error rendering clip: ' + err.message);
  }
};
