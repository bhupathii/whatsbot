/*
  Health Monitor
  Monitors bot health, performance, and system resources
*/

const os = require('os');
const fs = require('fs-extra');
const path = require('path');
const cron = require('node-cron');

class HealthMonitor {
  constructor(uploadQueue) {
    this.uploadQueue = uploadQueue;
    this.startTime = Date.now();
    this.healthChecks = new Map();
    this.metrics = {
      uptime: 0,
      memoryUsage: {},
      cpuUsage: 0,
      diskUsage: {},
      uploadStats: {},
      errors: [],
      lastCheck: null
    };
    
    this.startMonitoring();
  }

  // Start health monitoring
  startMonitoring() {
    // Check every 30 seconds
    cron.schedule('*/30 * * * * *', () => {
      this.performHealthCheck();
    });

    // Clean up old data every hour
    cron.schedule('0 * * * *', () => {
      this.cleanupOldData();
    });

    console.log('Health monitoring started');
  }

  // Perform health check
  async performHealthCheck() {
    try {
      const now = Date.now();
      
      // System metrics
      this.metrics.uptime = now - this.startTime;
      this.metrics.memoryUsage = this.getMemoryUsage();
      this.metrics.cpuUsage = await this.getCpuUsage();
      this.metrics.diskUsage = await this.getDiskUsage();
      
      // Upload queue metrics
      if (this.uploadQueue) {
        const queueStatus = this.uploadQueue.getStatus();
        this.metrics.uploadStats = {
          queueLength: queueStatus.queueLength,
          activeUploads: queueStatus.activeUploads,
          totalUploads: queueStatus.stats.total,
          completedUploads: queueStatus.stats.completed,
          failedUploads: queueStatus.stats.failed,
          successRate: queueStatus.stats.total > 0 
            ? ((queueStatus.stats.completed / queueStatus.stats.total) * 100).toFixed(2)
            : 100
        };
      }

      this.metrics.lastCheck = now;
      
      // Check for health issues
      const healthStatus = this.assessHealth();
      this.healthChecks.set(now, healthStatus);

      // Log warnings for critical issues
      if (healthStatus.status === 'critical') {
        console.warn('🚨 CRITICAL HEALTH ISSUE:', healthStatus.issues);
      } else if (healthStatus.status === 'warning') {
        console.warn('⚠️ Health warning:', healthStatus.issues);
      }

    } catch (error) {
      console.error('Health check failed:', error);
      this.metrics.errors.push({
        timestamp: Date.now(),
        error: error.message,
        stack: error.stack
      });
    }
  }

  // Get memory usage
  getMemoryUsage() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    
    return {
      total: this.formatBytes(total),
      used: this.formatBytes(used),
      free: this.formatBytes(free),
      percentage: ((used / total) * 100).toFixed(2)
    };
  }

  // Get CPU usage
  async getCpuUsage() {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });

    return {
      cores: cpus.length,
      loadAverage: os.loadavg(),
      idlePercentage: ((totalIdle / totalTick) * 100).toFixed(2)
    };
  }

  // Get disk usage
  async getDiskUsage() {
    try {
      const dataDir = process.env.DATA_DIR || '/app/data';
      const tempDir = process.env.TEMP_DIR || '/app/temp';
      
      const dataStats = await fs.stat(dataDir);
      const tempStats = await fs.stat(tempDir);
      
      return {
        dataDir: {
          path: dataDir,
          size: this.formatBytes(dataStats.size),
          modified: dataStats.mtime
        },
        tempDir: {
          path: tempDir,
          size: this.formatBytes(tempStats.size),
          modified: tempStats.mtime
        }
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  // Assess overall health
  assessHealth() {
    const issues = [];
    let status = 'healthy';

    // Memory check
    const memoryPercent = parseFloat(this.metrics.memoryUsage.percentage);
    if (memoryPercent > 90) {
      issues.push(`High memory usage: ${memoryPercent}%`);
      status = 'critical';
    } else if (memoryPercent > 80) {
      issues.push(`Elevated memory usage: ${memoryPercent}%`);
      status = status === 'healthy' ? 'warning' : status;
    }

    // Upload queue check
    if (this.metrics.uploadStats) {
      const successRate = parseFloat(this.metrics.uploadStats.successRate);
      if (successRate < 80) {
        issues.push(`Low upload success rate: ${successRate}%`);
        status = status === 'healthy' ? 'warning' : status;
      }

      if (this.metrics.uploadStats.queueLength > 20) {
        issues.push(`Large upload queue: ${this.metrics.uploadStats.queueLength} items`);
        status = status === 'healthy' ? 'warning' : status;
      }
    }

    // Uptime check
    const uptimeHours = this.metrics.uptime / (1000 * 60 * 60);
    if (uptimeHours > 168) { // 7 days
      issues.push(`Long uptime: ${uptimeHours.toFixed(1)} hours`);
      status = status === 'healthy' ? 'warning' : status;
    }

    return {
      status,
      issues,
      timestamp: Date.now()
    };
  }

  // Get current health status
  getHealthStatus() {
    const latestCheck = Array.from(this.healthChecks.keys()).pop();
    const latestHealth = latestCheck ? this.healthChecks.get(latestCheck) : null;
    
    return {
      current: {
        status: latestHealth?.status || 'unknown',
        issues: latestHealth?.issues || [],
        timestamp: latestHealth?.timestamp || null
      },
      metrics: this.metrics,
      uptime: this.formatUptime(this.metrics.uptime),
      system: {
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version,
        memory: this.metrics.memoryUsage,
        cpu: this.metrics.cpuUsage
      }
    };
  }

  // Format bytes to human readable
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // Format uptime
  formatUptime(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  // Clean up old health check data
  cleanupOldData() {
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    
    for (const [timestamp] of this.healthChecks) {
      if (timestamp < oneDayAgo) {
        this.healthChecks.delete(timestamp);
      }
    }

    // Keep only last 100 errors
    if (this.metrics.errors.length > 100) {
      this.metrics.errors = this.metrics.errors.slice(-100);
    }
  }

  // Get performance summary
  getPerformanceSummary() {
    const healthStatus = this.getHealthStatus();
    const uploadStats = this.metrics.uploadStats;
    
    return {
      status: healthStatus.current.status,
      uptime: healthStatus.uptime,
      memory: `${healthStatus.system.memory.percentage}% used`,
      uploads: {
        total: uploadStats.totalUploads || 0,
        success: uploadStats.completedUploads || 0,
        failed: uploadStats.failedUploads || 0,
        successRate: uploadStats.successRate || '100%',
        queue: uploadStats.queueLength || 0,
        active: uploadStats.activeUploads || 0
      },
      lastCheck: this.metrics.lastCheck ? new Date(this.metrics.lastCheck).toLocaleString() : 'Never'
    };
  }
}

module.exports = HealthMonitor;
