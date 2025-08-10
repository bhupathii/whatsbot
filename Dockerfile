# Base image
FROM node:18-bullseye

ENV NODE_ENV=production
WORKDIR /app

# Install Chromium and dependencies for Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnss3 \
    libnspr4 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    cron \
  && rm -rf /var/lib/apt/lists/*

# Prevent Puppeteer from downloading Chromium (we use system chromium)
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Persisted directories for session and temp files
ENV DATA_DIR=/app/data
ENV TEMP_DIR=/app/temp
ENV MAX_CONCURRENT_UPLOADS=3
RUN mkdir -p $DATA_DIR $TEMP_DIR

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production || npm install --only=production

# Copy app
COPY . .

# Create cron job for health monitoring (optional)
RUN echo "*/5 * * * * root cd /app && node -e \"console.log('Health check at', new Date().toISOString())\" >> /var/log/cron.log 2>&1" > /etc/cron.d/health-check
RUN chmod 0644 /etc/cron.d/health-check
RUN crontab /etc/cron.d/health-check

# Default command
CMD ["node", "index.js"]