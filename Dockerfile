FROM node:18-slim

# Install FFmpeg, Python3 (yt-dlp ke liye), aur curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp latest release
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Install Node.js dependencies
COPY package*.json ./
RUN npm install

# Copy project files
COPY . .

# Start Node.js server
CMD ["node", "server.js"]
