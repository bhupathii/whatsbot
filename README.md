# 🤖 WhatsApp Drive Bot v2.0

A powerful WhatsApp bot that automatically uploads media files to Google Drive and returns shareable links. Now with advanced features including queue management, duplicate detection, progress tracking, and health monitoring.

## ✨ New Features in v2.0

### 🚀 **Progress Tracking & Queue System**
- **Concurrent Uploads**: Handle multiple uploads simultaneously (configurable)
- **Progress Bars**: Visual progress tracking with ASCII progress bars
- **Smart Queue**: Intelligent queue management with position tracking
- **Background Processing**: Uploads continue even when new files arrive

### 🔍 **Duplicate Detection**
- **File Hashing**: SHA-256 based duplicate detection
- **User-Specific**: Prevents re-uploading the same file for each user
- **Smart Notifications**: Shows original upload link when duplicates are detected
- **Memory Efficient**: Automatic cleanup of old duplicate records

### 🏥 **Health Monitoring**
- **Real-time Metrics**: Monitor bot health, memory usage, and performance
- **Automatic Checks**: Health monitoring every 30 seconds
- **Warning System**: Alerts for memory issues, low success rates, and queue overload
- **Performance Dashboard**: Web interface showing bot status and metrics

### 💬 **Enhanced Commands**
- **`.status`** - Your personal upload status and bot health
- **`.queue`** - View current upload queue with progress bars
- **`.health`** - Detailed bot health report and system metrics
- **`.stats`** - Upload statistics and success rates
- **`.ping`** - Check bot responsiveness
- **`.help`** - Comprehensive help information

### 🚫 **Sticker Filtering**
- **Automatic Detection**: Recognizes and blocks WhatsApp stickers
- **User Guidance**: Clear messages explaining why stickers aren't supported
- **Resource Saving**: Prevents unnecessary processing of unsupported content

## 🚀 Getting Started

### Prerequisites
- Node.js 18+ 
- Google Cloud Console account with Drive API enabled
- WhatsApp Web access

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd whatsbot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Google Drive Setup**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Enable Google Drive API
   - Create OAuth2 credentials (Desktop app)
   - Download `credentials.json` to project root

4. **Environment Variables** (optional)
   ```bash
   export MAX_CONCURRENT_UPLOADS=5
   export DATA_DIR=/app/data
   export TEMP_DIR=/app/temp
   export PORT=3000
   ```

5. **Run the bot**
   ```bash
   npm start
   ```

6. **Scan QR Code**
   - Open the web interface at `http://localhost:3000`
   - Scan the QR code with WhatsApp
   - Grant necessary permissions

## 📁 Project Structure

```
whatsbot/
├── index.js              # Main bot logic and web interface
├── uploadQueue.js        # Queue management and progress tracking
├── healthMonitor.js      # Health monitoring and metrics
├── googleDrive.js        # Google Drive API integration
├── config.js             # Centralized configuration
├── package.json          # Dependencies and scripts
├── Dockerfile            # Docker configuration
└── README.md            # This file
```

## ⚙️ Configuration

The bot is highly configurable through `config.js`:

- **Upload Settings**: Concurrent uploads, queue size, cleanup intervals
- **Health Monitoring**: Check intervals, thresholds, alert levels
- **File Handling**: Supported types, size limits, extensions
- **Commands**: Available commands and aliases
- **Messages**: Customizable user messages and responses

## 🔧 Commands Reference

| Command | Description | Example |
|---------|-------------|---------|
| `.ping` | Check bot responsiveness | `.ping` |
| `.help` | Show comprehensive help | `.help` |
| `.status` | Your upload status and bot health | `.status` |
| `.queue` | View current upload queue | `.queue` |
| `.health` | Detailed bot health report | `.health` |
| `.stats` | Upload statistics | `.stats` |

## 📊 Web Interface

The bot provides a beautiful web dashboard at the root URL (`/`) showing:

- **Bot Status**: Connection status and health
- **Upload Statistics**: Total uploads, success rates, queue status
- **System Metrics**: Memory usage, CPU, uptime
- **Real-time Queue**: Current uploads and waiting files

### Health Endpoint

Access health data via JSON API at `/health`:

```json
{
  "status": "ok",
  "whatsapp": "connected",
  "health": "healthy",
  "uptime": "2h 15m",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## 🚀 Docker Deployment

```bash
# Build the image
docker build -t whatsbot .

# Run with persistent storage
docker run -d \
  -p 3000:3000 \
  -v /path/to/data:/app/data \
  -v /path/to/temp:/app/temp \
  --name whatsbot \
  whatsbot
```

## 📈 Performance Features

### Queue Management
- **Configurable Concurrency**: Set maximum simultaneous uploads
- **Priority Handling**: First-in-first-out queue processing
- **Memory Management**: Automatic cleanup of completed uploads
- **Error Recovery**: Failed uploads don't block the queue

### Progress Tracking
- **Real-time Updates**: Progress bars update every second
- **Visual Feedback**: ASCII progress bars in chat
- **Duration Tracking**: Upload time measurement and reporting
- **Status Notifications**: Queue position and completion updates

### Health Monitoring
- **System Metrics**: Memory, CPU, disk usage monitoring
- **Performance Alerts**: Automatic warnings for issues
- **Historical Data**: Track performance over time
- **Resource Management**: Automatic cleanup of old data

## 🔒 Security Features

- **File Type Validation**: Only supported media types accepted
- **Size Limits**: Configurable maximum file sizes
- **Duplicate Prevention**: Prevents storage abuse
- **Session Persistence**: Secure WhatsApp session storage

## 🛠️ Troubleshooting

### Common Issues

1. **QR Code Not Appearing**
   - Check if Chromium is properly installed
   - Verify Puppeteer configuration
   - Check console for error messages

2. **Upload Failures**
   - Verify Google Drive API credentials
   - Check internet connectivity
   - Review error logs for specific issues

3. **High Memory Usage**
   - Reduce concurrent uploads
   - Check for memory leaks in logs
   - Monitor health dashboard

### Logs and Debugging

- **Console Logs**: Real-time bot activity
- **Health Dashboard**: System performance metrics
- **Queue Status**: Upload progress and status
- **Error Tracking**: Detailed error information

## 🔄 Updating

```bash
# Pull latest changes
git pull origin main

# Install new dependencies
npm install

# Restart the bot
npm start
```

## 📝 Changelog

### v2.0.0
- ✨ Added upload queue system with progress tracking
- 🔍 Implemented duplicate file detection
- 🏥 Added comprehensive health monitoring
- 💬 Enhanced command system with new interactive commands
- 🚫 Added sticker filtering
- 🌐 Improved web interface with status dashboard
- ⚙️ Centralized configuration system
- 📊 Added performance metrics and statistics

### v1.0.0
- 🚀 Initial release with basic upload functionality
- 🔗 Google Drive integration
- 📱 WhatsApp Web.js integration
- 🐳 Docker support

## 🤝 Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues for bugs and feature requests.

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgments

- [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) - WhatsApp Web API
- [Google APIs](https://github.com/googleapis/googleapis-nodejs) - Google Drive integration
- [Puppeteer](https://github.com/puppeteer/puppeteer) - Browser automation

---

**Made with ❤️ for the WhatsApp community**
