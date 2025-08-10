/*
  Admin System
  Manages admin access and role-based permissions for the WhatsApp bot
*/

const fs = require('fs-extra');
const path = require('path');

class AdminSystem {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.adminConfigPath = path.join(dataDir, 'admin-config.json');
    this.adminUsers = new Map();
    this.adminRoles = new Map();
    this.restrictedUsers = new Map(); // New: Track restricted users
    this.userWarnings = new Map(); // New: Track user warnings
    this.auditLogs = []; // New: Track admin actions
    this.loadAdminConfig();
    this.initializeDefaultRoles();
  }

  // Initialize default admin roles
  initializeDefaultRoles() {
    if (this.adminRoles.size === 0) {
      this.adminRoles.set('super_admin', {
        name: 'Super Administrator',
        permissions: [
          'bot_control', 'user_management', 'system_config', 'upload_management',
          'health_monitoring', 'queue_control', 'file_management', 'admin_management',
          'user_restriction', 'bot_shutdown', 'emergency_control', 'audit_logs'
        ],
        level: 100
      });

      this.adminRoles.set('admin', {
        name: 'Administrator',
        permissions: [
          'user_management', 'upload_management', 'health_monitoring', 'queue_control',
          'user_restriction', 'moderator_management'
        ],
        level: 80
      });

      this.adminRoles.set('moderator', {
        name: 'Moderator',
        permissions: [
          'upload_management', 'health_monitoring', 'queue_view', 'user_warning'
        ],
        level: 60
      });

      this.adminRoles.set('viewer', {
        name: 'Viewer',
        permissions: [
          'health_monitoring', 'queue_view', 'stats_view'
        ],
        level: 40
      });
    }
  }

  // Load admin configuration from file
  async loadAdminConfig() {
    try {
      if (await fs.pathExists(this.adminConfigPath)) {
        const config = await fs.readJson(this.adminConfigPath);
        
        // Load admin users
        if (config.users) {
          this.adminUsers.clear();
          for (const [phone, userData] of Object.entries(config.users)) {
            this.adminUsers.set(phone, userData);
          }
        }

        // Load custom roles
        if (config.roles) {
          this.adminRoles.clear();
          this.initializeDefaultRoles();
          for (const [roleName, roleData] of Object.entries(config.roles)) {
            this.adminRoles.set(roleName, roleData);
          }
        }

        // Load restricted users
        if (config.restrictedUsers) {
          this.restrictedUsers.clear();
          for (const [phone, restrictionData] of Object.entries(config.restrictedUsers)) {
            this.restrictedUsers.set(phone, restrictionData);
          }
        }

        // Load user warnings
        if (config.userWarnings) {
          this.userWarnings.clear();
          for (const [phone, warningsData] of Object.entries(config.userWarnings)) {
            this.userWarnings.set(phone, warningsData);
          }
        }

        // Load audit logs
        if (config.auditLogs) {
          this.auditLogs = config.auditLogs;
        }

        console.log(`Admin system loaded: ${this.adminUsers.size} admin users, ${this.adminRoles.size} roles, ${this.restrictedUsers.size} restricted users`);
      }
    } catch (error) {
      console.error('Error loading admin config:', error);
      // Create default admin if no config exists
      await this.createDefaultAdmin();
    }
    
    // Ensure default admin exists after loading config
    await this.ensureDefaultAdminExists();
  }

  // Save admin configuration to file
  async saveAdminConfig() {
    try {
      const config = {
        users: Object.fromEntries(this.adminUsers),
        roles: Object.fromEntries(this.adminRoles),
        restrictedUsers: Object.fromEntries(this.restrictedUsers),
        userWarnings: Object.fromEntries(this.userWarnings),
        auditLogs: this.auditLogs,
        lastUpdated: new Date().toISOString()
      };
      
      await fs.writeJson(this.adminConfigPath, config, { spaces: 2 });
      console.log('Admin configuration saved successfully');
    } catch (error) {
      console.error('Error saving admin config:', error);
    }
  }

  // Create default admin user
  async createDefaultAdmin() {
    // You can set your phone number as the default super admin
    const defaultAdminPhone = process.env.DEFAULT_ADMIN_PHONE || '916309513603@c.us';
    
    this.adminUsers.set(defaultAdminPhone, {
      role: 'super_admin',
      name: 'Karthik (Super Admin)',
      addedAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      permissions: this.adminRoles.get('super_admin').permissions
    });

    console.log(`Default admin created: ${defaultAdminPhone}`);
    await this.saveAdminConfig();
  }

  // Ensure default admin exists
  async ensureDefaultAdminExists() {
    const defaultAdminPhone = process.env.DEFAULT_ADMIN_PHONE || '916309513603@c.us';
    
    if (!this.adminUsers.has(defaultAdminPhone)) {
      console.log(`Default admin not found, creating: ${defaultAdminPhone}`);
      await this.createDefaultAdmin();
    } else {
      console.log(`Default admin already exists: ${defaultAdminPhone}`);
    }
  }

  // Normalize phone number to standard format
  normalizePhoneNumber(phone) {
    // Remove any non-digit characters
    let cleanPhone = phone.replace(/\D/g, '');
    
    // If it starts with 91 and is 12 digits, add @c.us
    if (cleanPhone.startsWith('91') && cleanPhone.length === 12) {
      return cleanPhone + '@c.us';
    }
    
    // If it's 10 digits and doesn't start with 91, add 91 and @c.us
    if (cleanPhone.length === 10 && !cleanPhone.startsWith('91')) {
      return '91' + cleanPhone + '@c.us';
    }
    
    // If it already has @c.us, return as is
    if (phone.includes('@c.us')) {
      return phone;
    }
    
    // Default: add @c.us if not present
    return phone.includes('@') ? phone : phone + '@c.us';
  }

  // Test admin access with different phone formats
  testAdminAccess(phone) {
    const normalized = this.normalizePhoneNumber(phone);
    const isAdminUser = this.adminUsers.has(normalized);
    const userData = this.adminUsers.get(normalized);
    
    return {
      originalPhone: phone,
      normalizedPhone: normalized,
      isAdmin: isAdminUser,
      userData: userData,
      allAdminPhones: Array.from(this.adminUsers.keys())
    };
  }

  // Force create default admin (useful for debugging)
  async forceCreateDefaultAdmin() {
    console.log('Force creating default admin...');
    await this.createDefaultAdmin();
    return this.testAdminAccess('6309513603');
  }

  // Force create admin (bypasses role restrictions)
  async forceCreateAdmin(phone, role, name, addedBy) {
    if (!this.adminRoles.has(role)) {
      throw new Error(`Invalid role: ${role}`);
    }

    const normalizedPhone = this.normalizePhoneNumber(phone);
    
    // Remove existing admin if exists
    if (this.adminUsers.has(normalizedPhone)) {
      this.adminUsers.delete(normalizedPhone);
    }

    const roleData = this.adminRoles.get(role);
    this.adminUsers.set(normalizedPhone, {
      role,
      name,
      addedAt: new Date().toISOString(),
      addedBy,
      lastActive: new Date().toISOString(),
      permissions: roleData.permissions
    });

    await this.saveAdminConfig();
    return this.adminUsers.get(normalizedPhone);
  }

  // Check if user is admin
  isAdmin(phone) {
    const normalizedPhone = this.normalizePhoneNumber(phone);
    return this.adminUsers.has(normalizedPhone);
  }

  // Get admin user data
  getAdminUser(phone) {
    const normalizedPhone = this.normalizePhoneNumber(phone);
    return this.adminUsers.get(normalizedPhone);
  }

  // Check if user has specific permission
  hasPermission(phone, permission) {
    const normalizedPhone = this.normalizePhoneNumber(phone);
    const user = this.adminUsers.get(normalizedPhone);
    if (!user) return false;

    const role = this.adminRoles.get(user.role);
    if (!role) return false;

    return role.permissions.includes(permission);
  }

  // Check if user has any of the specified permissions
  hasAnyPermission(phone, permissions) {
    return permissions.some(permission => this.hasPermission(phone, permission));
  }

  // Check if user has all of the specified permissions
  hasAllPermissions(phone, permissions) {
    return permissions.every(permission => this.hasPermission(phone, permission));
  }

  // Get user's permission level
  getPermissionLevel(phone) {
    const normalizedPhone = this.normalizePhoneNumber(phone);
    const user = this.adminUsers.get(normalizedPhone);
    if (!user) return 0;

    const role = this.adminRoles.get(user.role);
    return role ? role.level : 0;
  }

  // Add new admin user
  async addAdmin(phone, role, name, addedBy) {
    if (!this.adminRoles.has(role)) {
      throw new Error(`Invalid role: ${role}`);
    }

    const normalizedPhone = this.normalizePhoneNumber(phone);
    
    if (this.adminUsers.has(normalizedPhone)) {
      throw new Error('User is already an admin');
    }

    const roleData = this.adminRoles.get(role);
    this.adminUsers.set(normalizedPhone, {
      role,
      name,
      addedAt: new Date().toISOString(),
      addedBy,
      lastActive: new Date().toISOString(),
      permissions: roleData.permissions
    });

    await this.saveAdminConfig();
    return this.adminUsers.get(normalizedPhone);
  }

  // Remove admin user
  async removeAdmin(phone, removedBy) {
    const normalizedPhone = this.normalizePhoneNumber(phone);
    
    if (!this.adminUsers.has(normalizedPhone)) {
      throw new Error('User is not an admin');
    }

    const user = this.adminUsers.get(normalizedPhone);
    if (user.role === 'super_admin') {
      throw new Error('Cannot remove super admin');
    }

    this.adminUsers.delete(normalizedPhone);
    await this.saveAdminConfig();
    
    return {
      removedUser: user,
      removedBy,
      timestamp: new Date().toISOString()
    };
  }

  // Update admin role
  async updateAdminRole(phone, newRole, updatedBy) {
    const normalizedPhone = this.normalizePhoneNumber(phone);
    
    if (!this.adminUsers.has(normalizedPhone)) {
      throw new Error('User is not an admin');
    }

    if (!this.adminRoles.has(newRole)) {
      throw new Error(`Invalid role: ${newRole}`);
    }

    const user = this.adminUsers.get(normalizedPhone);
    if (user.role === 'super_admin' && newRole !== 'super_admin') {
      throw new Error('Cannot downgrade super admin');
    }

    const roleData = this.adminRoles.get(newRole);
    user.role = newRole;
    user.permissions = roleData.permissions;
    user.lastUpdated = new Date().toISOString();
    user.updatedBy = updatedBy;

    await this.saveAdminConfig();
    return user;
  }

  // Create custom role
  async createRole(roleName, roleData, createdBy) {
    if (this.adminRoles.has(roleName)) {
      throw new Error(`Role already exists: ${roleName}`);
    }

    this.adminRoles.set(roleName, {
      ...roleData,
      createdBy,
      createdAt: new Date().toISOString()
    });

    await this.saveAdminConfig();
    return this.adminRoles.get(roleName);
  }

  // Get all admin users
  getAllAdmins() {
    return Array.from(this.adminUsers.entries()).map(([phone, user]) => ({
      phone,
      ...user
    }));
  }

  // Get all roles
  getAllRoles() {
    return Array.from(this.adminRoles.entries()).map(([name, role]) => ({
      name,
      ...role
    }));
  }

  // Update user's last active time
  updateLastActive(phone) {
    const user = this.adminUsers.get(phone);
    if (user) {
      user.lastActive = new Date().toISOString();
      // Save periodically instead of on every update
      if (Math.random() < 0.1) { // 10% chance to save
        this.saveAdminConfig();
      }
    }
  }

  // Get admin statistics
  getAdminStats() {
    const totalAdmins = this.adminUsers.size;
    const roleCounts = {};
    const activeAdmins = Array.from(this.adminUsers.values())
      .filter(user => {
        const lastActive = new Date(user.lastActive);
        const now = new Date();
        return (now - lastActive) < (24 * 60 * 60 * 1000); // Active in last 24 hours
      }).length;

    for (const user of this.adminUsers.values()) {
      roleCounts[user.role] = (roleCounts[user.role] || 0) + 1;
    }

    return {
      totalAdmins,
      activeAdmins,
      roleCounts,
      roles: this.adminRoles.size
    };
  }

  // Validate admin command
  validateAdminCommand(phone, command, requiredPermissions = []) {
    if (!this.isAdmin(phone)) {
      return {
        allowed: false,
        reason: 'User is not an admin',
        requiredRole: null
      };
    }

    if (requiredPermissions.length > 0 && !this.hasAllPermissions(phone, requiredPermissions)) {
      return {
        allowed: false,
        reason: 'Insufficient permissions',
        requiredPermissions,
        userPermissions: this.getAdminUser(phone).permissions
      };
    }

    return {
      allowed: true,
      user: this.getAdminUser(phone),
      permissions: this.getAdminUser(phone).permissions
    };
  }

  // NEW FEATURES: User restriction system
  // Restrict a user (block them from using the bot)
  async restrictUser(phone, reason, restrictedBy, duration = null) {
    const restriction = {
      phone,
      reason,
      restrictedBy,
      restrictedAt: new Date().toISOString(),
      duration, // null = permanent, or number in hours
      active: true
    };

    this.restrictedUsers.set(phone, restriction);
    
    // Add to audit log
    this.addAuditLog('user_restricted', restrictedBy, {
      targetUser: phone,
      reason,
      duration
    });

    await this.saveAdminConfig();
    return restriction;
  }

  // Unrestrict a user
  async unrestrictUser(phone, unrestrictedBy) {
    if (!this.restrictedUsers.has(phone)) {
      throw new Error('User is not restricted');
    }

    const restriction = this.restrictedUsers.get(phone);
    restriction.active = false;
    restriction.unrestrictedAt = new Date().toISOString();
    restriction.unrestrictedBy = unrestrictedBy;

    // Add to audit log
    this.addAuditLog('user_unrestricted', unrestrictedBy, {
      targetUser: phone,
      previousReason: restriction.reason
    });

    await this.saveAdminConfig();
    return restriction;
  }

  // Check if user is restricted
  isUserRestricted(phone) {
    const restriction = this.restrictedUsers.get(phone);
    if (!restriction || !restriction.active) return false;

    // Check if temporary restriction has expired
    if (restriction.duration) {
      const restrictedAt = new Date(restriction.restrictedAt);
      const now = new Date();
      const hoursElapsed = (now - restrictedAt) / (1000 * 60 * 60);
      
      if (hoursElapsed >= restriction.duration) {
        restriction.active = false;
        this.saveAdminConfig();
        return false;
      }
    }

    return true;
  }

  // Get restriction info for a user
  getUserRestriction(phone) {
    return this.restrictedUsers.get(phone);
  }

  // Get all restricted users
  getAllRestrictedUsers() {
    return Array.from(this.restrictedUsers.values())
      .filter(restriction => restriction.active);
  }

  // Warn a user
  async warnUser(phone, reason, warnedBy, warningLevel = 'warning') {
    if (!this.userWarnings.has(phone)) {
      this.userWarnings.set(phone, []);
    }

    const warning = {
      reason,
      warnedBy,
      warningLevel, // 'warning', 'final_warning', 'last_warning'
      warnedAt: new Date().toISOString(),
      acknowledged: false
    };

    this.userWarnings.get(phone).push(warning);

    // Add to audit log
    this.addAuditLog('user_warned', warnedBy, {
      targetUser: phone,
      reason,
      warningLevel
    });

    await this.saveAdminConfig();
    return warning;
  }

  // Get user warnings
  getUserWarnings(phone) {
    return this.userWarnings.get(phone) || [];
  }

  // Acknowledge warning
  async acknowledgeWarning(phone, warningIndex, acknowledgedBy) {
    const warnings = this.userWarnings.get(phone);
    if (!warnings || !warnings[warningIndex]) {
      throw new Error('Warning not found');
    }

    warnings[warningIndex].acknowledged = true;
    warnings[warningIndex].acknowledgedAt = new Date().toISOString();
    warnings[warningIndex].acknowledgedBy = acknowledgedBy;

    await this.saveAdminConfig();
    return warnings[warningIndex];
  }

  // Add audit log entry
  addAuditLog(action, performedBy, details = {}) {
    const logEntry = {
      action,
      performedBy,
      timestamp: new Date().toISOString(),
      details
    };

    this.auditLogs.push(logEntry);

    // Keep only last 1000 audit logs
    if (this.auditLogs.length > 1000) {
      this.auditLogs = this.auditLogs.slice(-1000);
    }

    // Save periodically
    if (Math.random() < 0.2) { // 20% chance to save
      this.saveAdminConfig();
    }
  }

  // Get audit logs
  getAuditLogs(limit = 100, filter = null) {
    let logs = [...this.auditLogs].reverse(); // Most recent first

    if (filter) {
      logs = logs.filter(log => {
        if (filter.action && log.action !== filter.action) return false;
        if (filter.performedBy && log.performedBy !== filter.performedBy) return false;
        if (filter.targetUser && log.details.targetUser !== filter.targetUser) return false;
        return true;
      });
    }

    return logs.slice(0, limit);
  }

  // Get audit statistics
  getAuditStats() {
    const actionCounts = {};
    const userActionCounts = {};
    const recentActions = this.auditLogs
      .filter(log => {
        const logTime = new Date(log.timestamp);
        const now = new Date();
        return (now - logTime) < (24 * 60 * 60 * 1000); // Last 24 hours
      });

    for (const log of this.auditLogs) {
      actionCounts[log.action] = (actionCounts[log.action] || 0) + 1;
      userActionCounts[log.performedBy] = (userActionCounts[log.performedBy] || 0) + 1;
    }

    return {
      totalActions: this.auditLogs.length,
      recentActions: recentActions.length,
      actionCounts,
      userActionCounts
    };
  }

  // Emergency shutdown capability (super admin only)
  async emergencyShutdown(initiatedBy) {
    const user = this.adminUsers.get(initiatedBy);
    if (!user || user.role !== 'super_admin') {
      throw new Error('Only super admin can initiate emergency shutdown');
    }

    this.addAuditLog('emergency_shutdown_initiated', initiatedBy, {
      timestamp: new Date().toISOString()
    });

    return {
      initiated: true,
      initiatedBy,
      timestamp: new Date().toISOString()
    };
  }

  // Get system status for admins
  getSystemStatus() {
    return {
      adminCount: this.adminUsers.size,
      restrictedUserCount: this.getAllRestrictedUsers().length,
      totalWarnings: Array.from(this.userWarnings.values())
        .reduce((total, warnings) => total + warnings.length, 0),
      auditLogCount: this.auditLogs.length,
      lastUpdated: new Date().toISOString()
    };
  }
}

module.exports = AdminSystem;
