# 🔐 WhatsApp Bot Admin System Guide

## Overview

The WhatsApp Bot now includes a comprehensive admin system with role-based access control, user management, and monitoring capabilities. The phone number **+916309513603** has been set as the **Super Administrator** with full access to all features.

## 👑 Admin Roles & Permissions

### 1. **Super Administrator** (Level 100)
- **Default User:** +916309513603
- **Full Access:** All permissions including emergency controls
- **Can:** Create/remove other admins, manage all roles, emergency shutdown

**Permissions:**
- `bot_control` - Full bot control
- `user_management` - Manage all users
- `system_config` - System configuration
- `upload_management` - Control uploads
- `health_monitoring` - Monitor bot health
- `queue_control` - Control upload queue
- `file_management` - Manage files
- `admin_management` - Manage other admins
- `user_restriction` - Restrict/unrestrict users
- `bot_shutdown` - Emergency shutdown
- `emergency_control` - Emergency controls
- `audit_logs` - View audit logs

### 2. **Administrator** (Level 80)
- **Can:** Manage users, uploads, health monitoring, queue control
- **Cannot:** Create super admins or emergency shutdown

**Permissions:**
- `user_management` - Manage users
- `upload_management` - Control uploads
- `health_monitoring` - Monitor bot health
- `queue_control` - Control upload queue
- `user_restriction` - Restrict/unrestrict users
- `moderator_management` - Manage moderators

### 3. **Moderator** (Level 60)
- **Can:** Manage uploads, monitor health, view queue, warn users
- **Cannot:** Restrict users or manage other admins

**Permissions:**
- `upload_management` - Control uploads
- `health_monitoring` - Monitor bot health
- `queue_view` - View queue status
- `user_warning` - Warn users

### 4. **Viewer** (Level 40)
- **Can:** View health status, queue status, statistics
- **Cannot:** Make any changes or manage users

**Permissions:**
- `health_monitoring` - Monitor bot health
- `queue_view` - View queue status
- `stats_view` - View statistics

## 🚀 Admin Commands

### Basic Admin Commands
```
.admin                    - Show admin command help
.admin list admins       - List all admin users
.admin system status     - Show system status
```

### User Management Commands
```
.admin add admin <phone> <role> <name>
Example: .admin add admin 919876543210@c.us admin John Doe

.admin remove admin <phone>
Example: .admin remove admin 919876543210@c.us

.admin update role <phone> <new_role>
Example: .admin update role 919876543210@c.us moderator
```

### User Control Commands
```
.admin restrict user <phone> <reason> [duration]
Example: .admin restrict user 919876543210@c.us Spam 24
Example: .admin restrict user 919876543210@c.us Violation

.admin unrestrict user <phone>
Example: .admin unrestrict user 919876543210@c.us

.admin warn user <phone> <reason>
Example: .admin warn user 919876543210@c.us Inappropriate content

.admin list restricted    - List all restricted users
```

### Monitoring Commands
```
.admin audit logs [limit]
Example: .admin audit logs 20

.admin system status     - Detailed system status
```

## 📱 Phone Number Format

**Important:** All phone numbers must be in the format: `91XXXXXXXXXX@c.us`

- **Country Code:** 91 (India)
- **Phone Number:** 10 digits
- **Suffix:** @c.us (WhatsApp format)

**Examples:**
- +916309513603 → `916309513603@c.us`
- +919876543210 → `919876543210@c.us`

## 🛡️ User Restriction System

### Restriction Types
1. **Temporary Restriction**
   - Set duration in hours
   - Automatically expires
   - Example: `.admin restrict user 919876543210@c.us Spam 24`

2. **Permanent Restriction**
   - No duration specified
   - Must be manually removed
   - Example: `.admin restrict user 919876543210@c.us Violation`

### Restriction Features
- **Automatic Expiry:** Temporary restrictions expire automatically
- **Audit Logging:** All restrictions are logged with timestamps
- **Reason Tracking:** Every restriction has a documented reason
- **Admin Accountability:** All actions are tracked by admin

## ⚠️ Warning System

### Warning Levels
1. **Warning** - First notice
2. **Final Warning** - Serious notice
3. **Last Warning** - Final notice before restriction

### Warning Features
- **Escalation:** Warnings can escalate to restrictions
- **Acknowledgment:** Users can acknowledge warnings
- **History:** Complete warning history per user
- **Audit Trail:** All warnings are logged

## 📊 Monitoring & Analytics

### System Status
- **Admin Count:** Total number of admin users
- **Active Admins:** Admins active in last 24 hours
- **Restricted Users:** Currently restricted users
- **Total Warnings:** All warnings issued
- **Audit Logs:** Total admin actions logged

### Audit Logs
- **Action Tracking:** Every admin action is logged
- **User Accountability:** All actions linked to admin
- **Timestamp:** Precise timing of all actions
- **Details:** Complete context for each action

## 🔧 Configuration

### Admin Configuration File
Location: `data/admin-config.json`

**Structure:**
```json
{
  "users": {
    "916309513603@c.us": {
      "role": "super_admin",
      "name": "Karthik (Super Admin)",
      "permissions": [...]
    }
  },
  "roles": {...},
  "restrictedUsers": {...},
  "userWarnings": {...},
  "auditLogs": [...]
}
```

### Environment Variables
```bash
DEFAULT_ADMIN_PHONE=916309513603@c.us
```

## 🚨 Emergency Controls

### Emergency Shutdown (Super Admin Only)
- **Command:** `.admin emergency shutdown`
- **Effect:** Initiates emergency shutdown procedure
- **Audit:** Logged with timestamp and admin
- **Recovery:** Requires manual restart

### System Recovery
- **Automatic:** Health monitoring continues
- **Manual:** Admin intervention may be required
- **Logs:** All actions are preserved

## 📋 Best Practices

### 1. **User Management**
- Always provide clear reasons for restrictions
- Use temporary restrictions for minor violations
- Document all admin actions
- Regular review of restricted users

### 2. **Security**
- Never share admin credentials
- Use temporary restrictions over permanent when possible
- Regular audit log review
- Monitor for suspicious activity

### 3. **Communication**
- Clear warning messages
- Consistent enforcement
- Transparent policies
- User appeal process

### 4. **Monitoring**
- Regular health checks
- Queue monitoring
- User activity tracking
- Performance metrics

## 🆘 Troubleshooting

### Common Issues

1. **Permission Denied**
   - Check user's admin role
   - Verify required permissions
   - Contact super admin

2. **Phone Number Format**
   - Ensure correct format: `91XXXXXXXXXX@c.us`
   - Include country code
   - Add @c.us suffix

3. **Command Not Working**
   - Check command syntax
   - Verify admin status
   - Review permission requirements

4. **System Errors**
   - Check bot logs
   - Verify configuration files
   - Contact super admin

### Support Commands
```
.help          - General bot help
.admin         - Admin command help
.status        - Your status and bot health
.health        - Detailed bot health
```

## 🔄 Updates & Maintenance

### Regular Tasks
- **Daily:** Monitor system health
- **Weekly:** Review audit logs
- **Monthly:** Clean up old data
- **Quarterly:** Review admin roles

### Data Cleanup
- **Audit Logs:** Kept for 1000 entries
- **Old Warnings:** Archived after acknowledgment
- **Expired Restrictions:** Automatically removed
- **Inactive Admins:** Marked for review

## 📞 Contact & Support

For admin system support:
- **Super Admin:** +916309513603
- **Documentation:** This guide
- **Logs:** Check audit logs for issues
- **Emergency:** Use emergency shutdown if needed

---

**⚠️ Important:** This admin system provides powerful controls. Use responsibly and always document your actions. All actions are logged and can be audited.
