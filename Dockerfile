FROM node:20-alpine

# Install FFmpeg and yt-dlp directly via Alpine package manager
RUN apk add --no-cache ffmpeg yt-dlp

WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm install --production

# Bundle app source
COPY . .

# Ensure working directories
RUN mkdir -p uploads output temp public

EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "server.js"]
