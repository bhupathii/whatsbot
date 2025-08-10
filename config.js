/*
  Bot Configuration
  Centralized configuration for all bot settings
*/

module.exports = {
  // Bot behavior
  bot: {
    name: 'WhatsApp Drive Bot',
    version: '2.0.0',
    maxFileSize: 100 * 1024 * 1024, // 100MB
    supportedTypes: [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
      'video/mp4', 'video/avi', 'video/mov', 'video/wmv', 'video/flv',
      'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp3', 'audio/aac',
      'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain', 'text/csv', 'application/json', 'application/xml'
    ],
    blockedTypes: [
      'image/webp', // WhatsApp stickers
      'application/x-vnd.whatsapp.sticker'
    ]
  },

  // Upload settings
  upload: {
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT_UPLOADS || '3', 10),
    maxQueueSize: 50,
    progressUpdateInterval: 1000, // ms
    duplicateDetection: true,
    autoCleanup: true,
    cleanupInterval: 24 * 60 * 60 * 1000 // 24 hours
  },

  // Health monitoring
  health: {
    checkInterval: 30000, // 30 seconds
    cleanupInterval: 60 * 60 * 1000, // 1 hour
    memoryThreshold: {
      warning: 80, // percentage
      critical: 90 // percentage
    },
    successRateThreshold: 80, // percentage
    maxQueueThreshold: 20
  },

  // File handling
  files: {
    tempDir: process.env.TEMP_DIR || '/app/temp',
    dataDir: process.env.DATA_DIR || '/app/data',
    maxTempFileAge: 60 * 60 * 1000, // 1 hour
    allowedExtensions: [
      'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp',
      'mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv',
      'mp3', 'wav', 'ogg', 'aac', 'm4a',
      'pdf', 'doc', 'docx', 'txt', 'csv', 'json', 'xml'
    ]
  },

  // WhatsApp settings
  whatsapp: {
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
      ]
    },
    authStrategy: 'LocalAuth',
    sessionTimeout: 24 * 60 * 60 * 1000 // 24 hours
  },

  // Web interface
  web: {
    port: parseInt(process.env.PORT || '3000', 10),
    host: '0.0.0.0',
    enableHealthEndpoint: true,
    enableStatusPage: true
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    enableConsole: true,
    enableFile: false,
    logFile: 'bot.log',
    maxLogSize: 10 * 1024 * 1024, // 10MB
    maxLogFiles: 5
  },

  // Commands
  commands: {
    prefix: '.',
    enabled: [
      'ping', 'help', 'status', 'queue', 'health', 'stats'
    ],
    aliases: {
      'p': 'ping',
      'h': 'help',
      's': 'status',
      'q': 'queue',
      'health': 'health',
      'stat': 'stats'
    }
  },

  // Messages
  messages: {
    welcome: [
      '🤖 **WhatsApp Drive Bot**',
      '',
      'I can upload your media to Google Drive and send you a shareable link.',
      '',
      'Type `.help` for more information.'
    ],
    help: [
      '🤖 **WhatsApp Drive Bot**',
      '',
      'I can upload your media to Google Drive and send you a public link.',
      '',
      '📤 **Supported Media**:',
      '• Images (JPG, PNG, GIF, etc.)',
      '• Videos (MP4, AVI, MOV, etc.)',
      '• Documents (PDF, DOC, TXT, etc.)',
      '• Audio files (MP3, WAV, etc.)',
      '',
      '❌ **Not Supported**:',
      '• Stickers',
      '• Contact cards',
      '• Location data',
      '',
      '💬 **Commands**:',
      '• `.ping` – Check if I am online',
      '• `.help` – Show this help',
      '• `.status` – Your upload status',
      '• `.queue` – Current upload queue',
      '• `.health` – Bot health report',
      '• `.stats` – Upload statistics',
      '',
      '📁 **How it works**:',
      '1. Send me any supported media file',
      '2. I\'ll add it to the upload queue',
      '3. Upload to Google Drive automatically',
      '4. Get a shareable link when done!',
      '',
      '⚠️ **Note**: Duplicate files are automatically detected and won\'t be uploaded again.'
    ],
    errors: {
      unsupportedType: '❌ This file type is not supported for upload.',
      fileTooLarge: '❌ File is too large. Maximum size is {maxSize}.',
      uploadFailed: '❌ Upload failed. Please try again later.',
      duplicateFile: '⚠️ This file appears to be a duplicate!',
      processingError: '❌ Error processing your file. Please try again.'
    },
    success: {
      queued: '📁 File queued for upload\nPosition: {position}\nFilename: {filename}',
      completed: '✅ Upload completed!\n\n📁 File: {filename}\n🔗 Link: {link}\n⏱️ Time: {duration}',
      duplicate: '⚠️ This file appears to be a duplicate!\n\nOriginal upload: {link}\nUploaded: {date}'
    }
  }
};
