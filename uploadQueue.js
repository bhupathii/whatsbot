/*
  Upload Queue Manager
  Handles multiple uploads concurrently with progress tracking
*/

const EventEmitter = require('events');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');

class UploadQueue extends EventEmitter {
  constructor(maxConcurrent = 3) {
    super();
    this.maxConcurrent = maxConcurrent;
    this.queue = [];
    this.activeUploads = new Map();
    this.completedUploads = new Map();
    this.failedUploads = new Map();
    this.stats = {
      total: 0,
      completed: 0,
      failed: 0,
      inProgress: 0
    };
  }

  // Generate file hash for duplicate detection
  async generateFileHash(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      
      stream.on('data', (data) => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  // Check if file is duplicate
  async isDuplicate(filePath, userId) {
    try {
      const fileHash = await this.generateFileHash(filePath);
      const userKey = `${userId}_${fileHash}`;
      
      // Check if we've seen this file before
      if (this.completedUploads.has(userKey)) {
        return {
          isDuplicate: true,
          existingFile: this.completedUploads.get(userKey)
        };
      }
      
      return { isDuplicate: false, fileHash, userKey };
    } catch (error) {
      console.error('Error checking duplicate:', error);
      return { isDuplicate: false, fileHash: null, userKey: null };
    }
  }

  // Add upload to queue
  async addToQueue(uploadData) {
    const {
      userId,
      messageId,
      filePath,
      mimeType,
      filename,
      originalMessage
    } = uploadData;

    // Check for duplicates first
    const duplicateCheck = await this.isDuplicate(filePath, userId);
    if (duplicateCheck.isDuplicate) {
      const existingFile = duplicateCheck.existingFile;
      await originalMessage.reply(
        `⚠️ This file appears to be a duplicate!\n\n` +
        `Original upload: ${existingFile.shareLink}\n` +
        `Uploaded: ${new Date(existingFile.uploadTime).toLocaleString()}`
      );
      return { status: 'duplicate', existingFile };
    }

    const uploadItem = {
      id: `${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      userId,
      messageId,
      filePath,
      mimeType,
      filename,
      originalMessage,
      fileHash: duplicateCheck.fileHash,
      userKey: duplicateCheck.userKey,
      status: 'queued',
      progress: 0,
      addedAt: Date.now(),
      startedAt: null,
      completedAt: null,
      error: null
    };

    this.queue.push(uploadItem);
    this.stats.total++;
    
    // Notify user
    await originalMessage.reply(
      `📁 File queued for upload\n` +
      `Position: ${this.queue.length}\n` +
      `Filename: ${filename}`
    );

    this.processQueue();
    return { status: 'queued', uploadItem };
  }

  // Process queue
  async processQueue() {
    if (this.activeUploads.size >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const uploadItem = this.queue.shift();
    if (!uploadItem) return;

    uploadItem.status = 'processing';
    uploadItem.startedAt = Date.now();
    this.activeUploads.set(uploadItem.id, uploadItem);
    this.stats.inProgress++;

    // Start progress simulation (since we can't get real progress from Google Drive API)
    this.simulateProgress(uploadItem);

    try {
      // Import here to avoid circular dependency
      const { uploadFileToDrive } = require('./googleDrive');
      
      const shareLink = await uploadFileToDrive(
        uploadItem.filePath, 
        uploadItem.mimeType, 
        uploadItem.filename
      );

      // Mark as completed
      uploadItem.status = 'completed';
      uploadItem.progress = 100;
      uploadItem.completedAt = Date.now();
      uploadItem.shareLink = shareLink;

      // Store in completed uploads for duplicate detection
      if (uploadItem.userKey) {
        this.completedUploads.set(uploadItem.userKey, {
          shareLink,
          uploadTime: uploadItem.completedAt,
          filename: uploadItem.filename
        });
      }

      // Clean up
      this.activeUploads.delete(uploadItem.id);
      this.stats.inProgress--;
      this.stats.completed++;

      // Send completion message
      await uploadItem.originalMessage.reply(
        `✅ Upload completed!\n\n` +
        `📁 File: ${uploadItem.filename}\n` +
        `🔗 Link: ${shareLink}\n` +
        `⏱️ Time: ${this.formatDuration(uploadItem.startedAt, uploadItem.completedAt)}`
      );

      // Clean up temp file
      try {
        await fs.remove(uploadItem.filePath);
        console.log('Temporary file deleted:', uploadItem.filePath);
      } catch (error) {
        console.error('Error deleting temp file:', error);
      }

    } catch (error) {
      console.error('Upload failed:', error);
      
      uploadItem.status = 'failed';
      uploadItem.error = error.message;
      uploadItem.completedAt = Date.now();
      
      this.activeUploads.delete(uploadItem.id);
      this.stats.inProgress--;
      this.stats.failed++;

      // Send error message
      await uploadItem.originalMessage.reply(
        `❌ Upload failed!\n\n` +
        `📁 File: ${uploadItem.filename}\n` +
        `⚠️ Error: ${error.message}\n` +
        `🔄 Please try again later.`
      );
    }

    // Process next item in queue
    setImmediate(() => this.processQueue());
  }

  // Simulate upload progress
  simulateProgress(uploadItem) {
    const progressInterval = setInterval(() => {
      if (uploadItem.status !== 'processing') {
        clearInterval(progressInterval);
        return;
      }

      // Simulate realistic progress
      if (uploadItem.progress < 90) {
        uploadItem.progress += Math.random() * 15 + 5;
        if (uploadItem.progress > 90) uploadItem.progress = 90;
      }

      // Emit progress event
      this.emit('progress', {
        id: uploadItem.id,
        progress: Math.round(uploadItem.progress),
        filename: uploadItem.filename
      });
    }, 1000);
  }

  // Get queue status
  getStatus() {
    return {
      queueLength: this.queue.length,
      activeUploads: this.activeUploads.size,
      maxConcurrent: this.maxConcurrent,
      stats: { ...this.stats },
      queue: this.queue.map(item => ({
        id: item.id,
        filename: item.filename,
        status: item.status,
        progress: item.progress,
        addedAt: item.addedAt
      })),
      active: Array.from(this.activeUploads.values()).map(item => ({
        id: item.id,
        filename: item.filename,
        progress: item.progress,
        startedAt: item.startedAt
      }))
    };
  }

  // Get user-specific status
  getUserStatus(userId) {
    const userQueue = this.queue.filter(item => item.userId === userId);
    const userActive = Array.from(this.activeUploads.values())
      .filter(item => item.userId === userId);
    const userCompleted = Array.from(this.completedUploads.entries())
      .filter(([key]) => key.startsWith(userId + '_'))
      .map(([key, value]) => ({ ...value, key }));

    return {
      queue: userQueue.length,
      active: userActive.length,
      completed: userCompleted.length,
      total: userQueue.length + userActive.length + userCompleted.length
    };
  }

  // Format duration
  formatDuration(start, end) {
    const duration = end - start;
    const seconds = Math.floor(duration / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  // Clear completed uploads (for memory management)
  clearOldCompletedUploads(maxAge = 24 * 60 * 60 * 1000) { // 24 hours
    const now = Date.now();
    for (const [key, value] of this.completedUploads.entries()) {
      if (now - value.uploadTime > maxAge) {
        this.completedUploads.delete(key);
      }
    }
  }
}

module.exports = UploadQueue;
