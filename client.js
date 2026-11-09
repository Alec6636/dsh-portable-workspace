/**
 * `dsh-portable-workspace` — Client half.
 *
 * One hand-written CommonJS factory registered into the browser module loader
 * (no bundler, no JSX, no TypeScript; the only runtime import is `react`).
 *
 * Surfaces:
 *  - `sidebar.panellist` — a "移动工作区" row in the sidebar's global-panel nav.
 *  - `main` (key `portable-workspace`) — the page that row opens: volumes on
 *    this machine, their workspaces, and the create / unlock / install /
 *    migrate / open actions.
 *
 * Both read and write through the authenticated, Connection-fenced
 * `/portable-workspace/*` routes, so the panel, the agent tool and the Host
 * half always agree on what a workspace is.
 *
 * @module dsh-portable-workspace/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-portable-workspace',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'portable-workspace'
    /** Host route prefix owned by the Host half. */
    const ROUTE_PREFIX = '/portable-workspace'
    /** Main-panel id of this page; the sidebar row reuses it as its list id. */
    const PANEL_ID = 'portable-workspace'

    // #region dictionaries
    const zh = {
      'panel.title': '移动工作区',
      'panel.subtitle': '会话、插件与交付都存放在移动盘上，不占这台电脑。',
      'panel.scan': '重新扫描',
      'panel.scanning': '正在扫描磁盘…',
      'panel.empty': '没有发现移动工作区。请插入移动盘，或在下面初始化一个。',
      'panel.offlineTitle': '脱机的盘',
      'panel.noWorkspace': '这块盘上还没有工作区。',
      'panel.createTitle': '新建移动工作区',
      'panel.createInstance': '新建便携实例',
      'panel.name': '名称',
      'panel.namePlaceholder': '例如：甲方案',
      'panel.passwordLabel': '密码（留空则不设密码）',
      'panel.passwordPlaceholder': '可留空',
      'panel.passwordConfirmLabel': '确认密码',
      'panel.passwordConfirmPlaceholder': '再输入一次',
      'panel.passwordMismatch': '两次输入的密码不一致。',
      'panel.showPassword': '显示密码',
      'panel.hidePassword': '隐藏密码',
      'panel.notes': '备注',
      'panel.create': '创建',
      'panel.cancel': '取消',
      'panel.open': '打开',
      'panel.opening': '正在打开…',
      'panel.unlockTitle': '工作区密码',
      'panel.unlock': '解锁',
      'panel.wrongPassword': '密码不正确。',
      'panel.pluginsTitle': '缺少插件',
      'panel.pluginsBody': '这台电脑上还缺少这个工作区依赖的插件。',
      'panel.install': '一键安装缺失插件',
      'panel.installOptional': '连可选插件一起装',
      'panel.skip': '跳过，直接打开',
      'panel.installing': '正在安装…',
      'panel.running': '运行中',
      'panel.stopped': '未运行',
      'panel.offline': '脱机',
      'panel.locked': '已加密',
      'panel.unlocked': '无密码',
      'panel.migrate': '迁移',
      'panel.delete': '删除',
      'panel.deleteConfirm': '删除这个工作区？它的会话与日志会一起删除。',
      'panel.settings': '设置',
      'panel.projectDir': '工程目录',
      'panel.logs': '启动日志',
      'panel.starter': '生成启动脚本',
      'panel.free': '可用',
      'panel.dshVersion': 'DSH 版本',
      'panel.unknownVersion': '未知',
      'panel.initRoot': '初始化这块盘',
      'panel.rootPath': '移动工作区根目录',
      'panel.rootPlaceholder': 'H:\\Portable-DSH',
      'panel.init': '初始化',
      'panel.ready': '已就绪',
      'panel.launchUrl': '便携实例地址',
      'panel.copy': '复制',
      'panel.copied': '已复制',
      'panel.openInstance': '在新窗口打开',
      'panel.retry': '重试',
      'panel.dismiss': '关闭',
      'panel.optional': '可选',
      'panel.required': '必需',
      'panel.noPlugins': '这个工作区没有声明插件依赖。',
      'panel.conflict': '兼容性冲突',
      'panel.conflictBody': '以下插件与本机 DeepSeek Harness 版本不兼容：',
      'panel.conflictAdvice': '处理方案',
      'panel.moveTo': '迁移到',
      'panel.migrateMove': '迁移后删除源工作区',
      'panel.migrateGo': '开始迁移',
      'panel.migrating': '正在迁移…',
      'panel.migratePasswordLabel': '工作区密码',
      'panel.migratePasswordPlaceholder': '这个工作区有密码，请输入后再迁移',
      'panel.migrateQueued': '已把 {count} 个插件写入清单；下次打开该工作区会提示「一键安装缺少的插件」（安装日志在 plugins.log）',
      'panel.volumeCount': '{count} 个工作区',
      'panel.machine': '这台电脑',
      'panel.refreshHint': '插拔移动盘后点「重新扫描」。',
      'panel.accountImport': '同步本机登录',
      'panel.accountReady': '已登录',
      'panel.accountMissing': '这块盘上的实例还没登录',
      'panel.accountNoLocal': '本机也没有登录信息',
      'panel.accountImported': '登录信息已同步',
      'panel.accountBody': '把这台电脑上的 DSH 登录信息复制到移动盘，之后在任何电脑上打开这个工作区都不用重新登录。只复制凭据文件，不改动本机数据。',
      'panel.working': '处理中…',
      'panel.logout': '登出',
      'panel.logoutDone': '已登出，下次打开需要重新验证密码。',
      'panel.unlockedBadge': '已解锁',
      'panel.changePassword': '修改密码',
      'panel.changePasswordTitle': '修改工作区密码',
      'panel.oldPassword': '当前密码',
      'panel.oldPasswordPlaceholder': '输入当前密码（无密码则留空）',
      'panel.newPassword': '新密码',
      'panel.newPasswordPlaceholder': '留空表示取消密码',
      'panel.confirmNewPassword': '确认新密码',
      'panel.confirmNewPasswordPlaceholder': '再输入一次新密码',
      'panel.passwordChanged': '密码已修改',
      'panel.addPlugin': '添加插件',
      'panel.addPluginTitle': '添加插件到这块盘',
      'panel.addPluginBody': '从 npm 官方源下载并安装到移动盘上的便携配置里（不复制本机插件），会自动把市场短名补全为完整包名、并挑选与本机 DSH 兼容的版本。安装后重启便携实例生效。',
      'panel.pluginSpec': '包名（完整 npm 包名，含 @作者/ 前缀）',
      'panel.pluginSpecPlaceholder': 'dsh-web-all 或 @linxin666/dsh-web-all@0.4.14',
      'panel.addPluginOptional': '作为可选插件（可跳过）',
      'panel.pluginAdded': '插件已添加：',
      'panel.deletePhrase': '请输入下面的文字确认删除',
      'panel.deletePhraseLabel': '确认文字',
      'panel.deletePhraseHint': '我已知晓删除该工作区，无法恢复！',
      'panel.deletePasswordLabel': '工作区密码',
      'panel.deletePasswordPlaceholder': '有密码则输入，无密码留空',
      'panel.deleteNow': '确认删除',
      'panel.accountLogout': '退出登录',
      'panel.accountLogoutBody': '删除移动盘上复制过来的登录凭据。下次打开如需使用账号，请重新点「同步本机登录」。',
      'panel.signedOut': '已退出登录',
      'panel.stopAll': '关闭全部便携实例',
      'panel.stopAllWorking': '正在关闭…',
      'panel.stopAllDone': '已关闭 {count} 个便携实例',
      'panel.leftover': '还有 {count} 个残留便携实例在运行，可能锁住升级文件',
      'panel.upgradeTitle': '升级 DeepSeek Harness 前',
      'panel.upgradeBody': '检测到待安装的升级或残留的便携实例。升级前请点「关闭全部便携实例」，然后完全退出主程序（含主窗口），再重试升级；否则安装文件会被占用。',
      'panel.rename': '重命名',
      'panel.renameTitle': '修改工作区名称',
      'panel.renamed': '名称已修改',
      'panel.renameGo': '保存名称',
      'panel.sessionMigrate': '迁移会话',
      'panel.sessionMigrateTitle': '迁移会话',
      'panel.sessionMigrateBody': '勾选要迁移的会话，选择来源和目标；会话日志、工程文件与交付物会一并复制。',
      'panel.sessionFrom': '来源',
      'panel.sessionTo': '目标',
      'panel.thisWorkspace': '当前工作区',
      'panel.localWorkspace': '本机（非移动工作区）',
      'panel.sessionSelectAll': '全选',
      'panel.sessionNone': '没有可迁移的会话',
      'panel.sessionMove': '迁移后从来源删除（移动而非复制）',
      'panel.sessionMigrateGo': '开始迁移',
      'panel.sessionMigrated': '已迁移 {count} 个会话',
      'panel.backup': '备份与恢复',
      'panel.backupTitle': '备份与恢复',
      'panel.backupNow': '立即备份',
      'panel.backupDone': '备份已创建',
      'panel.backupList': '已有备份',
      'panel.backupEmpty': '还没有备份',
      'panel.maxBackupCount': '最多保留份数',
      'panel.autoBackup': '每次打开工作区前自动备份',
      'panel.saveSettings': '保存设置',
      'panel.settingsSaved': '设置已保存',
      'panel.restore': '恢复',
      'panel.restoreTo': '恢复到',
      'panel.restorePhrase': '请输入下面的文字确认恢复',
      'panel.restorePhraseLabel': '确认文字',
      'panel.restorePhraseHint': '我已知晓恢复操作将覆盖原有移动工作区，请谨慎操作！',
      'panel.restorePasswordLabel': '被覆盖工作区的密码',
      'panel.restorePasswordPlaceholder': '有密码则输入，无密码留空',
      'panel.restoreNow': '确认恢复',
      'panel.restoreDone': '恢复完成',
      'panel.restoreWarning': '恢复会覆盖目标工作区的全部内容，请谨慎操作。',
      'panel.backupKindManual': '手动',
      'panel.backupKindAuto': '自动',
      'panel.backupKindPre': '恢复前留底',
      'panel.workspacePassword': '工作区密码',
      'panel.workspacePasswordPlaceholder': '有密码则输入，无密码留空',
      'panel.hintLabel': '密码提示（可选）',
      'panel.hintPlaceholder': '写一句帮自己想起密码的提示，别直接写密码',
      'panel.forgotPassword': '忘记密码？',
      'panel.showHint': '密码提示',
      'panel.recoveryTitle': '保存恢复密钥',
      'panel.recoveryWarn': '这串恢复密钥只显示这一次，请立即抄写并妥善保存；以后无法再查看。忘记密码时用它重设密码。',
      'panel.recoveryCodeLabel': '恢复密钥',
      'panel.recoveryCodePlaceholder': '例如 K7Q2-M9XP-3RTB-WH5N',
      'panel.recoveryGotIt': '我已抄写保存',
      'panel.recoverTitle': '用恢复密钥重设密码',
      'panel.recoverBody': '输入创建或修改密码时给你的恢复密钥，无需旧密码即可设置新密码。成功后会生成一串新的恢复密钥。',
      'panel.recoverGo': '重设密码',
      'panel.recovered': '密码已重设',
      'panel.sessionVerifyTitle': '先验证工作区密码',
      'panel.sessionVerifyBody': '该工作区设有密码。为保护会话隐私，请先验证密码，再进入迁移会话页面。',
      'panel.sessionVerifyGo': '验证并进入',
      'panel.sessionNoTitle': '（无主题会话）',
      'error.network': '无法连接 DSH 主机，请确认页面与主机的连接正常后重试。',
      'error.http': '请求失败（HTTP {status}）。',
      'error.unknown': '发生未知错误，请重试。',
    }
    const en = {
      'panel.title': 'Portable Workspace',
      'panel.subtitle': 'Sessions, plugins and deliverables live on the drive, not on this computer.',
      'panel.scan': 'Rescan',
      'panel.scanning': 'Scanning drives…',
      'panel.empty': 'No portable root found. Insert the drive, or initialize one below.',
      'panel.offlineTitle': 'Offline volumes',
      'panel.noWorkspace': 'No workspace on this volume yet.',
      'panel.createTitle': 'New workspace',
      'panel.createInstance': 'New portable instance',
      'panel.name': 'Name',
      'panel.namePlaceholder': 'e.g. Client Alpha',
      'panel.passwordLabel': 'Password (leave empty for none)',
      'panel.passwordPlaceholder': 'Optional',
      'panel.passwordConfirmLabel': 'Confirm password',
      'panel.passwordConfirmPlaceholder': 'Type it again',
      'panel.passwordMismatch': 'The two passwords do not match.',
      'panel.showPassword': 'Show password',
      'panel.hidePassword': 'Hide password',
      'panel.notes': 'Notes',
      'panel.create': 'Create',
      'panel.cancel': 'Cancel',
      'panel.open': 'Open',
      'panel.opening': 'Opening…',
      'panel.unlockTitle': 'Workspace password',
      'panel.unlock': 'Unlock',
      'panel.wrongPassword': 'Wrong password.',
      'panel.pluginsTitle': 'Missing plugins',
      'panel.pluginsBody': 'This computer does not have every plugin this workspace depends on.',
      'panel.install': 'Install missing plugins',
      'panel.installOptional': 'Install optional ones too',
      'panel.skip': 'Skip, open anyway',
      'panel.installing': 'Installing…',
      'panel.running': 'Running',
      'panel.stopped': 'Stopped',
      'panel.offline': 'Offline',
      'panel.locked': 'Password protected',
      'panel.unlocked': 'No password',
      'panel.migrate': 'Move',
      'panel.delete': 'Delete',
      'panel.deleteConfirm': 'Delete this workspace? Its sessions and logs are removed.',
      'panel.settings': 'Settings',
      'panel.projectDir': 'Project folder',
      'panel.logs': 'Launch log',
      'panel.starter': 'Write launcher script',
      'panel.free': 'free',
      'panel.dshVersion': 'DSH version',
      'panel.unknownVersion': 'unknown',
      'panel.initRoot': 'Initialize this drive',
      'panel.rootPath': 'Portable root path',
      'panel.rootPlaceholder': 'H:\\Portable-DSH',
      'panel.init': 'Initialize',
      'panel.ready': 'Ready',
      'panel.launchUrl': 'Portable instance URL',
      'panel.copy': 'Copy',
      'panel.copied': 'Copied',
      'panel.openInstance': 'Open in a new window',
      'panel.retry': 'Retry',
      'panel.dismiss': 'Dismiss',
      'panel.optional': 'optional',
      'panel.required': 'required',
      'panel.noPlugins': 'This workspace declares no plugin dependencies.',
      'panel.conflict': 'Compatibility conflict',
      'panel.conflictBody': 'These plugins are incompatible with the DeepSeek Harness version on this computer:',
      'panel.conflictAdvice': 'What to do',
      'panel.moveTo': 'Move to',
      'panel.migrateMove': 'Delete the source workspace after the move',
      'panel.migrateGo': 'Start moving',
      'panel.migrating': 'Moving…',
      'panel.migratePasswordLabel': 'Workspace password',
      'panel.migratePasswordPlaceholder': 'This workspace is protected — enter its password to move it',
      'panel.migrateQueued': '{count} plugins queued; the next open will prompt "Install missing plugins" (log: plugins.log)',
      'panel.volumeCount': '{count} workspaces',
      'panel.machine': 'This computer',
      'panel.refreshHint': 'Rescan after plugging or unplugging a drive.',
      'panel.accountImport': 'Copy my sign-in',
      'panel.accountReady': 'Signed in',
      'panel.accountMissing': 'The instance on this drive is not signed in',
      'panel.accountNoLocal': 'Nothing to copy from this machine',
      'panel.accountImported': 'Sign-in copied',
      'panel.accountBody': 'Copy this computer\'s DSH sign-in onto the removable drive, so the workspace needs no fresh login on any other computer. Only the credential files are copied; local data is untouched.',
      'panel.working': 'Working…',
      'panel.logout': 'Log out',
      'panel.logoutDone': 'Signed out. The password is required again on the next open.',
      'panel.unlockedBadge': 'Unlocked',
      'panel.changePassword': 'Change password',
      'panel.changePasswordTitle': 'Change workspace password',
      'panel.oldPassword': 'Current password',
      'panel.oldPasswordPlaceholder': 'Current password (leave empty if none)',
      'panel.newPassword': 'New password',
      'panel.newPasswordPlaceholder': 'Leave empty to remove the password',
      'panel.confirmNewPassword': 'Confirm new password',
      'panel.confirmNewPasswordPlaceholder': 'Type the new password again',
      'panel.passwordChanged': 'Password changed',
      'panel.addPlugin': 'Add plugin',
      'panel.addPluginTitle': 'Add a plugin to this drive',
      'panel.addPluginBody': 'Downloaded from the npm registry into the portable profile on the drive (not copied from this computer). Market short names and DSH-compatible versions are resolved automatically. Restart the portable instance for it to take effect.',
      'panel.pluginSpec': 'Package name (full npm name, with @scope/ prefix)',
      'panel.pluginSpecPlaceholder': 'dsh-web-all or @linxin666/dsh-web-all@0.4.14',
      'panel.addPluginOptional': 'Optional plugin (can be skipped)',
      'panel.pluginAdded': 'Plugin added:',
      'panel.deletePhrase': 'Type the phrase below to confirm deletion',
      'panel.deletePhraseLabel': 'Confirmation phrase',
      'panel.deletePhraseHint': '我已知晓删除该工作区，无法恢复！',
      'panel.deletePasswordLabel': 'Workspace password',
      'panel.deletePasswordPlaceholder': 'Enter it if set, otherwise leave empty',
      'panel.deleteNow': 'Delete now',
      'panel.accountLogout': 'Sign out',
      'panel.accountLogoutBody': 'Remove the copied sign-in credentials from the removable drive. Use "Copy my sign-in" again on the next open if you need the account.',
      'panel.signedOut': 'Signed out',
      'panel.stopAll': 'Stop all portable instances',
      'panel.stopAllWorking': 'Stopping…',
      'panel.stopAllDone': 'Stopped {count} portable instance(s)',
      'panel.leftover': '{count} leftover portable instance(s) are still running and may lock upgrade files',
      'panel.upgradeTitle': 'Before upgrading DeepSeek Harness',
      'panel.upgradeBody': 'A pending upgrade or leftover portable instance was detected. Before upgrading, click "Stop all portable instances", then fully quit the main app (including the main window) and retry the upgrade; otherwise the installer files stay locked.',
      'panel.rename': 'Rename',
      'panel.renameTitle': 'Rename workspace',
      'panel.renamed': 'Name updated',
      'panel.renameGo': 'Save name',
      'panel.sessionMigrate': 'Migrate sessions',
      'panel.sessionMigrateTitle': 'Migrate sessions',
      'panel.sessionMigrateBody': 'Select sessions, source and destination; logs, project files and deliverables are copied together.',
      'panel.sessionFrom': 'Source',
      'panel.sessionTo': 'Destination',
      'panel.thisWorkspace': 'This workspace',
      'panel.localWorkspace': 'This computer (local)',
      'panel.sessionSelectAll': 'Select all',
      'panel.sessionNone': 'No sessions to migrate',
      'panel.sessionMove': 'Delete from source after migrating (move, not copy)',
      'panel.sessionMigrateGo': 'Migrate selected',
      'panel.sessionMigrated': 'Migrated {count} session(s)',
      'panel.backup': 'Backup & restore',
      'panel.backupTitle': 'Backup & restore',
      'panel.backupNow': 'Back up now',
      'panel.backupDone': 'Backup created',
      'panel.backupList': 'Existing backups',
      'panel.backupEmpty': 'No backups yet',
      'panel.maxBackupCount': 'Max backups to keep',
      'panel.autoBackup': 'Auto-backup before each open',
      'panel.saveSettings': 'Save settings',
      'panel.settingsSaved': 'Settings saved',
      'panel.restore': 'Restore',
      'panel.restoreTo': 'Restore into',
      'panel.restorePhrase': 'Type the phrase below to confirm restore',
      'panel.restorePhraseLabel': 'Confirmation phrase',
      'panel.restorePhraseHint': '我已知晓恢复操作将覆盖原有移动工作区，请谨慎操作！',
      'panel.restorePasswordLabel': 'Password of the overwritten workspace',
      'panel.restorePasswordPlaceholder': 'Enter it if set, otherwise leave empty',
      'panel.restoreNow': 'Restore now',
      'panel.restoreDone': 'Restore complete',
      'panel.restoreWarning': 'Restore overwrites all content of the target workspace. Proceed carefully.',
      'panel.backupKindManual': 'Manual',
      'panel.backupKindAuto': 'Auto',
      'panel.backupKindPre': 'Pre-restore',
      'panel.workspacePassword': 'Workspace password',
      'panel.workspacePasswordPlaceholder': 'Enter it if set, otherwise leave empty',
      'panel.hintLabel': 'Password hint (optional)',
      'panel.hintPlaceholder': 'A hint that jogs your memory, not the password itself',
      'panel.forgotPassword': 'Forgot password?',
      'panel.showHint': 'Password hint',
      'panel.recoveryTitle': 'Save your recovery key',
      'panel.recoveryWarn': 'This one-time recovery key is shown ONLY once. Write it down and keep it safe - you cannot view it again. Use it to reset a forgotten password.',
      'panel.recoveryCodeLabel': 'Recovery key',
      'panel.recoveryCodePlaceholder': 'e.g. K7Q2-M9XP-3RTB-WH5N',
      'panel.recoveryGotIt': 'I saved it',
      'panel.recoverTitle': 'Reset password with recovery key',
      'panel.recoverBody': 'Enter the recovery key you received when creating or changing the password. No old password needed. A fresh key is generated on success.',
      'panel.recoverGo': 'Reset password',
      'panel.recovered': 'Password reset',
      'panel.sessionVerifyTitle': 'Verify workspace password first',
      'panel.sessionVerifyBody': 'This workspace is password-protected. To protect session privacy, verify the password before entering the session migration page.',
      'panel.sessionVerifyGo': 'Verify & continue',
      'panel.sessionNoTitle': '(untitled session)',
      'error.network': 'Cannot reach the DSH host. Check the page connection and try again.',
      'error.http': 'Request failed (HTTP {status}).',
      'error.unknown': 'Something went wrong. Please try again.',
    }
    // #endregion

    // #region theme tokens
    // Only host theme tokens: every surface follows light/dark switching
    // without a single literal colour.
    const T = {
      labelPrimary: 'var(--dsw-alias-label-primary)',
      labelSecondary: 'var(--dsw-alias-label-secondary)',
      labelTertiary: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
      bgBase: 'var(--dsw-alias-bg-base, Canvas)',
      bgLayer1: 'var(--dsw-alias-bg-layer-1, Canvas)',
      bgLayer2: 'var(--dsw-alias-bg-layer-2, Canvas)',
      border: 'var(--dsw-alias-border-l2)',
      borderL1: 'var(--dsw-alias-border-l1, var(--dsw-alias-border-l2))',
      brand: 'var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary))',
      hoverFill: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-secondary))',
      business: 'var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary))',
      focusRing:
        'var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))',
      radius: 'var(--dsw-radius-sm, 6px)',
      radiusLg: 'var(--dsw-radius-lg, 10px)',
      shadow: 'var(--dsw-shadow-md, 0 8px 24px rgba(0, 0, 0, 0.18))',
      font: 'var(--dsw-font-family, inherit)',
      mono: 'var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Consolas, monospace)',
    }
    // #endregion

    // #region icons
    /** Inline icon; artwork is our own and sized by the caller. */
    function Icon({ size = 16 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('rect', {
          x: 2.2,
          y: 4.4,
          width: 11.6,
          height: 7.4,
          rx: 1.5,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
        }),
        h('circle', { cx: 5.4, cy: 8.1, r: 0.9, fill: 'currentColor' }),
        h('path', {
          d: 'M7.6 8.1h4.2',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M6 2.4h4',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          opacity: 0.6,
        }),
      )
    }
    // #endregion

    // #region shared helpers

    /** Absolute URL of one Host route on the page's own origin. */
    function hostUrl(path) {
      return new URL(`${ROUTE_PREFIX}${path}`, window.location.href).toString()
    }

    /**
     * Identity translator used when the slot hands us no `t`.
     *
     * It must be a module-level constant: an inline arrow would be a new
     * function on every render, and any `useCallback`/`useEffect` keyed on the
     * translator would then re-run forever.
     */
    function identityTranslate(key) {
      return key
    }

    /** A translator that never throws and is stable across renders. */
    function translatorOf(t) {
      if (typeof t === 'function') return t
      try {
        const bound = window.__DSH_LOCALE_BIND__
        if (typeof bound === 'function') return bound
      } catch {
        // ignore: the fallback below is always safe.
      }
      return identityTranslate
    }

    /** A short, localizable error description for a thrown request failure. */
    function errorMessageOf(error, t) {
      if (error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message.trim() !== '') {
        return error.message.trim()
      }
      if (error !== null && typeof error === 'object' && typeof error.httpStatus === 'number') {
        return t('error.http', { status: error.httpStatus })
      }
      if (error instanceof TypeError) return t('error.network')
      return t('error.unknown')
    }

    /** A failure carrying either a Host payload or a transport status. */
    function requestFailure(payload, status) {
      const failure = new Error(
        payload !== null && typeof payload === 'object' && typeof payload.message === 'string'
          ? payload.message
          : `HTTP ${status}`,
      )
      failure.code = payload !== null && typeof payload === 'object' && typeof payload.code === 'string' ? payload.code : ''
      failure.httpStatus = status
      return failure
    }

    /**
     * POST one JSON body to a Host route and return its payload.
     * `timeoutMs` is optional: scanning/state calls pass it so a wedged Host
     * can never leave the panel stuck on "scanning" forever.
     */
    async function request(path, body, timeoutMs) {
      const controller = typeof timeoutMs === 'number' && typeof AbortController === 'function'
        ? new AbortController()
        : undefined
      const timer = controller === undefined ? undefined : window.setTimeout(() => controller.abort(), timeoutMs)
      let response
      try {
        response = await fetch(hostUrl(path), {
          method: body === undefined ? 'GET' : 'POST',
          headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller?.signal,
        })
      } catch (error) {
        if (controller?.signal.aborted === true) {
          const failure = new Error('request timed out')
          failure.code = 'timeout'
          throw failure
        }
        throw error
      } finally {
        if (timer !== undefined) window.clearTimeout(timer)
      }
      const text = await response.text()
      let payload
      try {
        payload = text === '' ? {} : JSON.parse(text)
      } catch {
        payload = {}
      }
      if (!response.ok) throw requestFailure(payload, response.status)
      return payload
    }

    /** Format a byte count the way a disk shows free space. */
    function formatBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return ''
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let size = value
      let index = 0
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024
        index += 1
      }
      return `${size >= 100 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`
    }

    /** Focus/escape handling shared by the small modal below. */
    function useModal(onClose) {
      const ref = React.useRef(null)
      React.useEffect(() => {
        const previous = document.activeElement
        const timer = window.setTimeout(() => {
          const node = ref.current
          const target = node === null ? null : node.querySelector('[data-autofocus="true"]')
          if (target !== null && typeof target.focus === 'function') target.focus()
          else if (node !== null && typeof node.focus === 'function') node.focus()
        }, 0)
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
        }
        window.addEventListener('keydown', onKey, true)
        return () => {
          window.clearTimeout(timer)
          window.removeEventListener('keydown', onKey, true)
          if (previous !== null && typeof previous.focus === 'function') previous.focus()
        }
      }, [onClose])
      return ref
    }

    /** A centred modal built from host-looking parts. */
    function Modal({ title, children, footer, onClose, width = 420 }) {
      const ref = useModal(onClose)
      return h(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 2147483000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.32)',
          },
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          {
            ref,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': title,
            tabIndex: -1,
            style: {
              width: Math.max(280, Math.min(width, window.innerWidth - 32)),
              maxHeight: '80vh',
              overflow: 'auto',
              boxSizing: 'border-box',
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              background: T.bgLayer1,
              border: `0.5px solid ${T.border}`,
              borderRadius: T.radiusLg,
              boxShadow: T.shadow,
              color: T.labelPrimary,
              font: `13px/20px ${T.font}`,
            },
          },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, title),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, children),
          footer === undefined ? null : h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } }, footer),
        ),
      )
    }

    /** One button in the host's own shape. */
    function Button({ children, onClick, kind = 'default', disabled = false, title, type = 'button' }) {
      const [hovered, setHovered] = React.useState(false)
      const [focused, setFocused] = React.useState(false)
      const primary = kind === 'primary'
      const danger = kind === 'danger'
      const background = disabled
        ? T.bgLayer2
        : primary
          ? T.brand
          : hovered
            ? T.hoverFill
            : 'transparent'
      const color = disabled
        ? T.labelTertiary
        : primary
          ? 'var(--dsw-alias-bg-base, #fff)'
          : danger
            ? T.error
            : T.labelPrimary
      return h(
        'button',
        {
          type,
          title,
          disabled,
          onClick,
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
          onFocus: () => setFocused(true),
          onBlur: () => setFocused(false),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            height: 28,
            padding: '0 12px',
            border: primary ? 'none' : `0.5px solid ${T.border}`,
            borderRadius: T.radius,
            background,
            color,
            cursor: disabled ? 'not-allowed' : 'pointer',
            outline: focused ? T.focusRing : 'none',
            outlineOffset: 1,
            font: `13px/20px ${T.font}`,
            whiteSpace: 'nowrap',
          },
        },
        children,
      )
    }

    /** One text input in the host's own shape. */
    function TextField({ value, onChange, placeholder, type = 'text', autoFocus = false, onEnter }) {
      const [focused, setFocused] = React.useState(false)
      return h('input', {
        type,
        value,
        placeholder,
        'data-autofocus': autoFocus ? 'true' : undefined,
        onChange: (event) => onChange(event.target.value),
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
        onKeyDown: (event) => {
          if (event.key === 'Enter' && typeof onEnter === 'function') onEnter()
        },
        style: {
          height: 30,
          width: '100%',
          boxSizing: 'border-box',
          padding: '0 10px',
          border: `0.5px solid ${focused ? T.brand : T.border}`,
          borderRadius: T.radius,
          background: T.bgBase,
          color: T.labelPrimary,
          outline: 'none',
          font: `13px/20px ${T.font}`,
        },
      })
    }

    /** Small eye icon, drawn by us. `open=false` adds the "hidden" slash. */
    function EyeIcon({ open = true, size = 15 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('path', {
          d: 'M1.2 8s2.4-4.1 6.8-4.1S14.8 8 14.8 8s-2.4 4.1-6.8 4.1S1.2 8 1.2 8z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 8, cy: 8, r: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
        open
          ? null
          : h('path', {
              d: 'M2.6 13.4 13.4 2.6',
              stroke: 'currentColor',
              strokeWidth: 1.4,
              strokeLinecap: 'round',
            }),
      )
    }

    /** Password input with a little eye button that reveals the value in plaintext. */
    function PasswordField({ t, value, onChange, placeholder, autoFocus = false, onEnter }) {
      const [visible, setVisible] = React.useState(false)
      const [focused, setFocused] = React.useState(false)
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            height: 30,
            width: '100%',
            boxSizing: 'border-box',
            border: `0.5px solid ${focused ? T.brand : T.border}`,
            borderRadius: T.radius,
            background: T.bgBase,
          },
        },
        h('input', {
          type: visible ? 'text' : 'password',
          value,
          placeholder,
          'data-autofocus': autoFocus ? 'true' : undefined,
          onChange: (event) => onChange(event.target.value),
          onFocus: () => setFocused(true),
          onBlur: () => setFocused(false),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && typeof onEnter === 'function') onEnter()
          },
          style: {
            flex: 1,
            minWidth: 0,
            height: '100%',
            boxSizing: 'border-box',
            padding: '0 10px',
            border: 'none',
            background: 'transparent',
            color: T.labelPrimary,
            outline: 'none',
            font: `13px/20px ${T.font}`,
          },
        }),
        h(
          'button',
          {
            type: 'button',
            title: visible ? t('panel.hidePassword') : t('panel.showPassword'),
            'aria-label': visible ? t('panel.hidePassword') : t('panel.showPassword'),
            'aria-pressed': visible ? 'true' : 'false',
            onClick: () => setVisible(!visible),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 30,
              height: '100%',
              flex: '0 0 30px',
              border: 'none',
              borderLeft: `0.5px solid ${T.border}`,
              background: 'transparent',
              color: T.labelSecondary,
              cursor: 'pointer',
              padding: 0,
            },
          },
          h(EyeIcon, { open: visible }),
        ),
      )
    }

    /** One labelled field. */
    function Field({ label, children }) {
      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: 4, color: T.labelSecondary, fontSize: 12 } },
        label,
        children,
      )
    }

    /** A small pill used for state (running, offline, locked…). */
    function Badge({ children, tone = 'neutral' }) {
      const color = tone === 'error' ? T.error : tone === 'success' ? T.success : tone === 'warn' ? T.warn : T.labelSecondary
      const background =
        tone === 'error'
          ? 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)'
          : tone === 'success'
            ? 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)'
            : T.bgLayer2
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            height: 18,
            padding: '0 7px',
            borderRadius: 999,
            background,
            color,
            font: `11px/18px ${T.font}`,
            whiteSpace: 'nowrap',
          },
        },
        children,
      )
    }
    // #endregion

    // #region panels

    /**
     * The page behind the sidebar row: volumes on this machine, their
     * workspaces, and the actions on one workspace.
     */
    function WorkspacePanel(props) {
      const t = translatorOf(props.t)
      // The slot may hand us a freshly bound translator on every render, so the
      // callbacks below read it through a ref instead of depending on it. Keying
      // an effect on the translator identity would refetch forever.
      const tRef = React.useRef(t)
      tRef.current = t
      // A duplicate mount (HMR / plugin reload) must never fan out two state
      // polls, and one pending poll must never be stacked on by a re-render.
      const loadInFlight = React.useRef(false)
      const mounted = React.useRef(true)
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [dialog, setDialog] = React.useState(null)
      const [showCreate, setShowCreate] = React.useState(false)
      const [showInit, setShowInit] = React.useState(false)

      const load = React.useCallback(
        async (viaScan = false) => {
          if (loadInFlight.current === true) return
          loadInFlight.current = true
          setBusy(viaScan ? 'scan' : 'state')
          setError('')
          try {
            const payload = viaScan
              ? await request('/scan', {}, 30000)
              : await request('/state', undefined, 30000)
            if (mounted.current === true) setData(payload)
          } catch (failure) {
            if (mounted.current === true) setError(errorMessageOf(failure, tRef.current))
          } finally {
            loadInFlight.current = false
            if (mounted.current === true) setBusy('')
          }
        },
        [],
      )

      React.useEffect(() => {
        mounted.current = true
        void load(false)
        return () => {
          mounted.current = false
        }
      }, [load])

      /** Run one action with a busy label and a uniform failure surface. */
      const run = React.useCallback(
        async (label, action) => {
          setBusy(label)
          setError('')
          try {
            const result = await action()
            return result
          } catch (failure) {
            setError(errorMessageOf(failure, tRef.current))
            return undefined
          } finally {
            setBusy('')
          }
        },
        [],
      )

      /**
       * Open one workspace: unlock when needed, then report the launch.
       *
       * `skipMissingPlugins` is the explicit "open anyway" escape hatch from the
       * plugin dialog. Keep the password with the dialog state: after an install
       * the workspace is re-opened automatically, and replaying an empty
       * password would make the Host ask for it a second time.
       */
      const openWorkspace = React.useCallback(
        async (volume, workspace, password, skipMissingPlugins) => {
          const result = await run('open', () =>
            request('/open', {
              root: volume.root,
              id: workspace.id,
              password: password ?? '',
              skipMissingPlugins: skipMissingPlugins === true,
            }),
          )
          if (result === undefined) return
          if (result.ok !== true) {
            if (result.stage === 'password') {
              setDialog({ kind: 'password', volume, workspace, message: result.message ?? '', hint: workspace.passwordHint ?? '' })
              return
            }
            if (result.stage === 'plugins') {
              setDialog({
                kind: 'plugins',
                volume,
                workspace,
                password: password ?? '',
                missing: result.missing ?? [],
                optional: result.optionalMissing ?? [],
                conflicts: result.conflicts ?? [],
              })
              return
            }
            setError(result.message ?? tRef.current('error.unknown'))
            return
          }
          if (result.stage === 'launched' || result.stage === 'running') {
            setDialog({ kind: 'launched', volume, workspace, url: result.url ?? '', password: password ?? '' })
          } else {
            setNotice(result.message ?? '')
            setDialog({ kind: 'launched', volume, workspace, url: result.url ?? '', pending: true, password: password ?? '' })
          }
          await load(false)
        },
        [run, load],
      )

      /**
       * Ask for a password before the first open, and after any re-plug.
       * A running instance only bypasses the dialog when this Host session
       * still holds the unlock (see /state -> unlocked).
       */
      const beginOpen = React.useCallback(
        (volume, workspace) => {
          if (workspace.running === true && workspace.unlocked === true) {
            setDialog({ kind: 'launched', volume, workspace, url: workspace.url ?? '', password: '' })
            return
          }
          if (workspace.passwordProtected === true) {
            setDialog({ kind: 'password', volume, workspace, message: '', hint: workspace.passwordHint ?? '' })
            return
          }
          void openWorkspace(volume, workspace, '')
        },
        [openWorkspace],
      )

      /** Delete a workspace after the typed-phrase + password dialog. */
      const deleteWorkspace = React.useCallback(
        async (volume, workspace, confirmPhrase, password) => {
          const result = await run('delete', () =>
            request('/delete', {
              root: volume.root,
              id: workspace.id,
              confirmPhrase,
              password: password ?? '',
            }),
          )
          if (result !== undefined) {
            setNotice(tRef.current('panel.delete'))
            await load(false)
          }
        },
        [run, load],
      )

      /** Log out: stop the instance, drop the unlock, refresh the list. */
      const logout = React.useCallback(
        async (volume, workspace) => {
          const result = await run('logout', () => request('/logout', { root: volume.root, id: workspace.id }))
          if (result !== undefined) {
            setNotice(tRef.current('panel.logoutDone'))
            await load(false)
          }
        },
        [run, load],
      )

      /** Change the workspace password (old / new / confirm). */
      const changePassword = React.useCallback(
        async (volume, workspace, oldPassword, newPassword, confirmPassword, hint) => {
          const result = await run('password/change', () =>
            request('/password/change', {
              root: volume.root,
              id: workspace.id,
              oldPassword,
              newPassword,
              confirmPassword,
              hint,
            }),
          )
          if (result !== undefined && result.ok === true) {
            await load(false)
          }
          return result
        },
        [run, load],
      )

      /** Add a plugin spec to the portable profile on this volume. */
      const addPlugin = React.useCallback(
        async (volume, workspace, spec, optional, password) => {
          const result = await run('plugins/add', () =>
            request('/plugins/add', {
              root: volume.root,
              id: workspace.id,
              spec,
              optional: optional === true,
              password,
            }, 300000),
          )
          if (result !== undefined && result.ok === true) {
            const detail = Array.isArray(result.hints) && result.hints.length > 0
              ? `（${result.hints.join(' ')}）`
              : ''
            setNotice(`${tRef.current('panel.pluginAdded')} ${result.name ?? spec}${detail}`)
            await load(false)
          } else if (result !== undefined && result.ok === false) {
            const tail = String(result.output ?? '').split('\n').filter(Boolean).slice(-3).join(' ')
            setError(tail || tRef.current('error.unknown'))
          }
          return result
        },
        [run, load],
      )

      /** Remove the copied account credentials from the portable home. */
      const accountLogout = React.useCallback(
        async (volume) => {
          const result = await run('account/logout', () => request('/account/logout', { root: volume.root }))
          if (result !== undefined) {
            setNotice(tRef.current('panel.signedOut'))
            await load(false)
          }
        },
        [run, load],
      )

      /** Stop every detached portable instance (the pre-upgrade escape hatch). */
      const stopAll = React.useCallback(
        async () => {
          const result = await run('stop-all', () => request('/stop-all', {}))
          if (result !== undefined) {
            setNotice(tRef.current('panel.stopAllDone', { count: result.killed ?? 0 }))
            await load(false)
          }
        },
        [run, load],
      )

      const heading = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('div', { style: { fontSize: 18, fontWeight: 600, color: T.labelPrimary } }, t('panel.title')),
        h('div', { style: { fontSize: 12, color: T.labelSecondary } }, t('panel.subtitle')),
      )

      const toolbar = h(
        'div',
        { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
        h(Button, { onClick: () => void load(true), disabled: busy === 'scan' }, busy === 'scan' ? t('panel.scanning') : t('panel.scan')),
        h(Button, { onClick: () => setShowCreate(true), kind: 'primary' }, t('panel.createInstance')),
        h(Button, { onClick: () => setShowInit(true) }, t('panel.initRoot')),
        h(Button, { onClick: () => void stopAll(), disabled: busy !== '' }, busy === 'stop-all' ? t('panel.stopAllWorking') : t('panel.stopAll')),
        data === null || data.dshVersion === '' || data.dshVersion === undefined
          ? null
          : h(
              'span',
              { style: { marginLeft: 'auto', fontSize: 11, color: T.labelTertiary } },
              `${t('panel.dshVersion')} ${data.dshVersion}`,
            ),
      )

      const volumes = data === null ? [] : data.volumes ?? []
      const offline = data === null ? [] : data.offline ?? []

      const volumeCards = volumes.map((volume) =>
        h(
          'section',
          {
            key: volume.root,
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              padding: 14,
              border: `0.5px solid ${T.border}`,
              borderRadius: T.radiusLg,
              background: T.bgLayer1,
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
            h('div', { style: { fontSize: 13, fontWeight: 600, fontFamily: T.mono } }, volume.root),
            h(Badge, { tone: 'neutral' }, t('panel.volumeCount', { count: volume.workspaces.length })),
            volume.space === undefined
              ? null
              : h(
                  'span',
                  { style: { fontSize: 11, color: T.labelTertiary } },
                  `${t('panel.free')} ${formatBytes(volume.space.free)}`,
                ),
            h(
              'div',
              { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
              h(
                Button,
                {
                  onClick: () => {
                    setDialog({ kind: 'create', volume })
                  },
                },
                t('panel.createTitle'),
              ),
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11 } },
            volume.account === undefined
              ? null
              : volume.account.portableSignedIn
                ? h(Badge, { tone: 'success' }, t('panel.accountReady'))
                : h(
                    'span',
                    { style: { color: T.labelTertiary } },
                    volume.account.localPresent ? t('panel.accountMissing') : t('panel.accountNoLocal'),
                  ),
            volume.account === undefined || volume.account.portableSignedIn || !volume.account.localPresent
              ? null
              : h(
                  Button,
                  {
                    onClick: () =>
                      setDialog({ kind: 'account', volume, message: '' }),
                  },
                  t('panel.accountImport'),
                ),
            volume.account !== undefined && volume.account.portableSignedIn === true
              ? h(Button, { onClick: () => setDialog({ kind: 'accountLogout', volume }) }, t('panel.accountLogout'))
              : null,
          ),
          volume.workspaces.length === 0
            ? h('div', { style: { fontSize: 12, color: T.labelTertiary } }, t('panel.noWorkspace'))            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                volume.workspaces.map((workspace) =>
                  h(
                    'div',
                    {
                      key: workspace.id,
                      style: {
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                        padding: '10px 12px',
                        border: `0.5px solid ${T.borderL1}`,
                        borderRadius: T.radius,
                        background: T.bgBase,
                      },
                    },
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                      h('div', { style: { fontSize: 13, fontWeight: 600 } }, workspace.name),
                      workspace.running
                        ? h(Badge, { tone: 'success' }, t('panel.running'))
                        : h(Badge, { tone: 'neutral' }, t('panel.stopped')),
                      workspace.passwordProtected
                        ? h(Badge, { tone: 'warn' }, t('panel.locked'))
                        : h(Badge, { tone: 'neutral' }, t('panel.unlocked')),
                      workspace.passwordProtected && workspace.unlocked === true
                        ? h(Badge, { tone: 'success' }, t('panel.unlockedBadge'))
                        : null,
                      workspace.reachable === false ? h(Badge, { tone: 'error' }, t('panel.offline')) : null,
                      h(
                        'div',
                        { style: { marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' } },
                        h(
                          Button,
                          { kind: 'primary', onClick: () => beginOpen(volume, workspace), disabled: busy === 'open' },
                          busy === 'open' ? t('panel.opening') : t('panel.open'),
                        ),
                        workspace.passwordProtected && workspace.unlocked === true
                          ? h(Button, { onClick: () => void logout(volume, workspace), disabled: busy !== '' }, t('panel.logout'))
                          : null,
                        h(Button, { onClick: () => setDialog({ kind: 'changePassword', volume, workspace }) }, t('panel.changePassword')),
                        h(Button, { onClick: () => setDialog({ kind: 'addPlugin', volume, workspace }) }, t('panel.addPlugin')),
                        h(
                          Button,
                          {
                            onClick: () =>
                              setDialog({ kind: 'migrate', volume, workspace, toRoot: '', move: false }),
                          },
                          t('panel.migrate'),
                        ),
                        h(Button, { onClick: () => setDialog({ kind: 'rename', volume, workspace }) }, t('panel.rename')),
                        h(Button, { onClick: () => setDialog({ kind: 'sessions', volume, workspace }) }, t('panel.sessionMigrate')),
                        h(Button, { onClick: () => setDialog({ kind: 'backup', volume, workspace }) }, t('panel.backup')),
                        h(
                          Button,
                          {
                            kind: 'danger',
                            onClick: () => setDialog({ kind: 'delete', volume, workspace }),
                          },
                          t('panel.delete'),
                        ),
                      ),
                    ),
                    h(
                      'div',
                      { style: { fontSize: 11, color: T.labelTertiary, fontFamily: T.mono, wordBreak: 'break-all' } },
                      `${t('panel.projectDir')}: ${workspace.projectDir}`,
                    ),
                    workspace.plugins !== undefined && workspace.plugins.length > 0
                      ? h(
                          'div',
                          { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                          workspace.plugins.map((entry) =>
                            h(Badge, { key: entry.name, tone: entry.optional ? 'neutral' : 'neutral' },
                              entry.optional ? `${entry.name} (${t('panel.optional')})` : entry.name),
                          ),
                        )
                      : null,
                  ),
                ),
              ),
        ),
      )

      const offlineCards =
        offline.length === 0
          ? null
          : h(
              'section',
              { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              h('div', { style: { fontSize: 12, fontWeight: 600, color: T.labelSecondary } }, t('panel.offlineTitle')),
              offline.map((entry) =>
                h(
                  'div',
                  {
                    key: entry.root,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 12px',
                      border: `0.5px solid ${T.borderL1}`,
                      borderRadius: T.radius,
                      background: T.bgLayer1,
                      color: T.labelSecondary,
                    },
                  },
                  h(Badge, { tone: 'error' }, t('panel.offline')),
                  h('span', { style: { fontFamily: T.mono, fontSize: 12 } }, entry.root),
                  h('span', { style: { marginLeft: 'auto', fontSize: 11, color: T.labelTertiary } }, entry.reason),
                ),
              ),
            )

      return h(
        'div',
        {
          style: {
            height: '100%',
            overflow: 'auto',
            boxSizing: 'border-box',
            padding: '20px 22px 32px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            background: T.bgBase,
            color: T.labelPrimary,
            font: `13px/20px ${T.font}`,
          },
        },
        heading,
        toolbar,
        data !== null && (data.upgradePending === true || (data.leftoverCount ?? 0) > 0)
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  padding: '10px 12px',
                  border: `0.5px solid ${T.warn}`,
                  borderRadius: T.radius,
                  background: T.bgLayer2,
                  fontSize: 12,
                },
              },
              h('div', { style: { fontWeight: 600, color: T.warn } }, t('panel.upgradeTitle')),
              (data.leftoverCount ?? 0) > 0
                ? h('div', { style: { color: T.labelSecondary } }, t('panel.leftover', { count: data.leftoverCount }))
                : null,
              h('div', { style: { color: T.labelSecondary } }, t('panel.upgradeBody')),
            )
          : null,
        error === '' ? null : h('div', { style: { color: T.error, fontSize: 12 } }, error),
        notice === '' ? null : h('div', { style: { color: T.success, fontSize: 12 } }, notice),
        busy === 'state' && data === null
          ? h('div', { style: { fontSize: 12, color: T.labelTertiary } }, t('panel.scanning'))
          : volumes.length === 0
            ? h('div', { style: { fontSize: 12, color: T.labelSecondary, padding: '18px 0' } }, t('panel.empty'))
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } }, volumeCards),
        offlineCards,
        h('div', { style: { fontSize: 11, color: T.labelTertiary, marginTop: 'auto' } }, t('panel.refreshHint')),

        showCreate
          ? h(CreateDialog, {
              t,
              fixedRoot: undefined,
              onClose: () => setShowCreate(false),
              onSubmit: async (values) => {
                const volumes0 = volumes
                const root = values.root !== '' ? values.root : volumes0[0]?.root ?? ''
                if (root === '') {
                  setError(t('panel.empty'))
                  return false
                }
                const result = await run('create', () =>
                  request('/create', {
                    root,
                    name: values.name,
                    password: values.password,
                    notes: values.notes,
                  }),
                )
                if (result === undefined) return false
                setShowCreate(false)
                setNotice(`${t('panel.createTitle')} ✓ ${result.name}`)
                await load(false)
                return true
              },
            })
          : null,

        showInit
          ? h(InitDialog, {
              t,
              onClose: () => setShowInit(false),
              onSubmit: async (root) => {
                const result = await run('init', () => request('/root/init', { root }))
                if (result === undefined) return false
                setShowInit(false)
                setNotice(`${root} ${t('panel.ready')}`)
                await load(false)
                return true
              },
            })
          : null,

        dialog === null
          ? null
          : dialog.kind === 'account'
            ? h(AccountDialog, {
                t,
                volume: dialog.volume,
                onClose: () => setDialog(null),
                onSubmit: async () => {
                  const current = dialog
                  const result = await run('account', () =>
                    request('/account/import', { root: current.volume.root, overwrite: true }),
                  )
                  if (result === undefined) return false
                  setDialog(null)
                  setNotice(`${t('panel.accountImported')} ✓ ${(result.copied ?? []).join(', ') || '—'}`)
                  await load(false)
                  return true
                },
              })
            : dialog.kind === 'accountLogout'
              ? h(ConfirmDialog, {
                  t,
                  title: t('panel.accountLogout'),
                  body: t('panel.accountLogoutBody'),
                  confirmLabel: t('panel.accountLogout'),
                  danger: true,
                  onClose: () => setDialog(null),
                  onConfirm: async () => {
                    const current = dialog
                    setDialog(null)
                    await accountLogout(current.volume)
                  },
                })
            : dialog.kind === 'changePassword'
              ? h(ChangePasswordDialog, {
                  t,
                  workspace: dialog.workspace,
                  busy: busy === 'password/change',
                  onClose: () => setDialog(null),
                  onSubmit: async (oldPassword, newPassword, confirmPassword, hint) => {
                    const current = dialog
                    const result = await changePassword(current.volume, current.workspace, oldPassword, newPassword, confirmPassword, hint)
                    if (result !== undefined && result.ok === true) {
                      if (result.recoveryCode) setDialog({ kind: 'recovery', code: result.recoveryCode, hint: result.passwordHint ?? '' })
                      else setDialog(null)
                    }
                  },
                })
            : dialog.kind === 'addPlugin'
              ? h(AddPluginDialog, {
                  t,
                  workspace: dialog.workspace,
                  busy: busy === 'plugins/add',
                  onClose: () => setDialog(null),
                  onSubmit: async (spec, optional, password) => {
                    const current = dialog
                    const result = await addPlugin(current.volume, current.workspace, spec, optional, password)
                    if (result !== undefined && result.ok === true) setDialog(null)
                  },
                })
            : dialog.kind === 'password'
            ? h(PasswordDialog, {
                t,
                workspace: dialog.workspace,
                message: dialog.message,
                hint: dialog.hint ?? dialog.workspace?.passwordHint ?? '',
                onClose: () => setDialog(null),
                onForgot: () => setDialog({ kind: 'forgot', volume: dialog.volume, workspace: dialog.workspace }),
                onSubmit: async (password) => {
                  const current = dialog
                  setDialog(null)
                  await openWorkspace(current.volume, current.workspace, password)
                },
              })
            : dialog.kind === 'plugins'
              ? h(PluginsDialog, {
                  t,
                  workspace: dialog.workspace,
                  missing: dialog.missing ?? [],
                  optional: dialog.optional ?? [],
                  conflicts: dialog.conflicts ?? [],
                  busy: busy === 'install',
                  onClose: () => setDialog(null),
                  // "Open anyway" keeps the password and asks the Host to
                  // launch without the missing plugins.
                  onSkip: async () => {
                    const current = dialog
                    setDialog(null)
                    await openWorkspace(current.volume, current.workspace, current.password ?? '', true)
                  },
                  onInstall: async (includeOptional) => {
                    const current = dialog
                    const result = await run('install', () =>
                      request('/install', {
                        root: current.volume.root,
                        id: current.workspace.id,
                        includeOptional,
                        password: current.password ?? '',
                      }),
                    )
                    if (result === undefined) return
                    if (result.ok === true) {
                      setDialog(null)
                      setNotice(`${t('panel.install')} ✓ ${(result.installed ?? []).join(', ') || '—'}`)
                      // Re-open with the password we already collected, so an
                      // encrypted workspace does not prompt a second time.
                      await openWorkspace(current.volume, current.workspace, current.password ?? '')
                      return
                    }
                    setError((result.output ?? '').split('\n').slice(-3).join(' '))
                  },
                })
              : dialog.kind === 'launched'
                ? h(LaunchedDialog, {
                    t,
                    workspace: dialog.workspace,
                    url: dialog.url,
                    pending: dialog.pending === true,
                    onClose: () => setDialog(null),
                    onRetry: async () => {
                      const current = dialog
                      setDialog(null)
                      await openWorkspace(current.volume, current.workspace, current.password ?? '')
                    },
                  })
                : dialog.kind === 'delete'
                  ? h(DeleteDialog, {
                      t,
                      workspace: dialog.workspace,
                      busy: busy === 'delete',
                      onClose: () => setDialog(null),
                      onSubmit: async (confirmPhrase, password) => {
                        const current = dialog
                        await deleteWorkspace(current.volume, current.workspace, confirmPhrase, password)
                        setDialog(null)
                      },
                    })
                  : dialog.kind === 'migrate'
                    ? h(MigrateDialog, {
                        t,
                        volume: dialog.volume,
                        workspace: dialog.workspace,
                        volumes,
                        onClose: () => setDialog(null),
                        onSubmit: async (toRoot, move, password) => {
                          const current = dialog
                          const result = await run('migrate', () =>
                            request('/migrate', {
                              root: current.volume.root,
                              id: current.workspace.id,
                              toRoot,
                              move,
                              password,
                            }),
                          )
                          if (result === undefined) return false
                          setDialog(null)
                          const queued = Number(result.pluginsQueued ?? 0)
                          const queuedText = t('panel.migrateQueued', { count: queued }).replace('{count}', String(queued))
                          setNotice(
                            `${t('panel.migrate')} ✓ ${result.name} → ${result.toRoot}` +
                            (queued > 0 ? ` · ${queuedText}` : ''),
                          )
                          await load(false)
                          return true
                        },
                      })
                    : dialog.kind === 'rename'
                      ? h(RenameDialog, { t, volume: dialog.volume, workspace: dialog.workspace, onClose: () => setDialog(null), onDone: async (msg) => { setDialog(null); setNotice(msg); await load(false) } })
                    : dialog.kind === 'sessions'
                      ? h(SessionMigrateDialog, { t, volume: dialog.volume, workspace: dialog.workspace, volumes, onClose: () => setDialog(null), onDone: async (msg) => { setDialog(null); setNotice(msg); await load(false) } })
                    : dialog.kind === 'backup'
                      ? h(BackupDialog, { t, volume: dialog.volume, workspace: dialog.workspace, volumes, onClose: () => setDialog(null), onDone: async (msg) => { setDialog(null); setNotice(msg); await load(false) } })
                    : dialog.kind === 'recovery'
                      ? h(RecoveryDialog, { t, code: dialog.code, hint: dialog.hint, onClose: () => setDialog(null) })
                    : dialog.kind === 'forgot'
                      ? h(ForgotPasswordDialog, { t, volume: dialog.volume, workspace: dialog.workspace, onClose: () => setDialog(null), onDone: async (r) => {
                          if (r && r.recoveryCode) setDialog({ kind: 'recovery', code: r.recoveryCode, hint: r.passwordHint ?? '' })
                          else { setDialog(null); setNotice(t('panel.recovered')) }
                          await load(false)
                        } })
                    : dialog.kind === 'create'
                      ? h(CreateDialog, {
                          t,
                          fixedRoot: dialog.volume?.root,
                          onClose: () => setDialog(null),
                          onSubmit: async (values) => {
                            if (dialog.volume === undefined) return false
                            const result = await run('create', () =>
                              request('/create', {
                                root: dialog.volume.root,
                                name: values.name,
                                password: values.password,
                                notes: values.notes,
                                hint: values.hint,
                              }),
                            )
                            if (result === undefined) return false
                            if (result.recoveryCode) setDialog({ kind: 'recovery', code: result.recoveryCode, hint: result.passwordHint ?? '' })
                            else setDialog(null)
                            setNotice(`${t('panel.createTitle')} ✓ ${result.name}`)
                            await load(false)
                            return true
                          },
                        })
                      : null,
      )
    }

    /** Create form, used both inline and per volume. */
    function CreateDialog({ t, fixedRoot, onClose, onSubmit }) {
      const [root, setRoot] = React.useState(fixedRoot ?? '')
      const [name, setName] = React.useState('')
      const [password, setPassword] = React.useState('')
      const [confirm, setConfirm] = React.useState('')
      const [notes, setNotes] = React.useState('')
      const [hint, setHint] = React.useState('')
      const [submitting, setSubmitting] = React.useState(false)
      const [mismatch, setMismatch] = React.useState(false)
      const submit = async () => {
        if (submitting) return
        if (password !== confirm) {
          setMismatch(true)
          return
        }
        setMismatch(false)
        setSubmitting(true)
        try {
          await onSubmit({ root: root.trim(), name: name.trim(), password, notes: notes.trim(), hint: hint.trim() })
        } finally {
          setSubmitting(false)
        }
      }
      return h(
        Modal,
        {
          title: t('panel.createTitle'),
          onClose,
          footer: [
            h(Button, { key: 'cancel', onClick: onClose }, t('panel.cancel')),
            h(Button, { key: 'ok', kind: 'primary', onClick: () => void submit(), disabled: submitting }, t('panel.create')),
          ],
        },
        fixedRoot === undefined
          ? h(Field, { label: t('panel.rootPath') }, h(TextField, {
              value: root,
              onChange: setRoot,
              placeholder: t('panel.rootPlaceholder'),
            }))
          : h('div', { style: { fontFamily: T.mono, fontSize: 12, color: T.labelSecondary } }, fixedRoot),
        h(Field, { label: t('panel.name') }, h(TextField, {
          value: name,
          onChange: setName,
          placeholder: t('panel.namePlaceholder'),
          autoFocus: true,
          onEnter: () => void submit(),
        })),
        h(Field, { label: t('panel.passwordLabel') }, h(PasswordField, {
          t,
          value: password,
          onChange: (value) => { setPassword(value); setMismatch(false) },
          placeholder: t('panel.passwordPlaceholder'),
          onEnter: () => void submit(),
        })),
        h(Field, { label: t('panel.passwordConfirmLabel') }, h(PasswordField, {
          t,
          value: confirm,
          onChange: (value) => { setConfirm(value); setMismatch(false) },
          placeholder: t('panel.passwordConfirmPlaceholder'),
          onEnter: () => void submit(),
        })),
        mismatch
          ? h('div', { style: { color: T.error, fontSize: 12 } }, t('panel.passwordMismatch'))
          : null,
        h(Field, { label: t('panel.hintLabel') }, h(TextField, { value: hint, onChange: setHint, placeholder: t('panel.hintPlaceholder') })),
        h(Field, { label: t('panel.notes') }, h(TextField, { value: notes, onChange: setNotes })),
      )
    }

    /** Initialize a portable root on a drive the user names. */
    function InitDialog({ t, onClose, onSubmit }) {
      const [root, setRoot] = React.useState('')
      const [submitting, setSubmitting] = React.useState(false)
      const submit = async () => {
        if (submitting || root.trim() === '') return
        setSubmitting(true)
        try {
          await onSubmit(root.trim())
        } finally {
          setSubmitting(false)
        }
      }
      return h(
        Modal,
        {
          title: t('panel.initRoot'),
          onClose,
          footer: [
            h(Button, { key: 'cancel', onClick: onClose }, t('panel.cancel')),
            h(Button, {
              key: 'ok',
              kind: 'primary',
              onClick: () => void submit(),
              disabled: submitting || root.trim() === '',
            }, t('panel.init')),
          ],
        },
        h(Field, { label: t('panel.rootPath') }, h(TextField, {
          value: root,
          onChange: setRoot,
          placeholder: t('panel.rootPlaceholder'),
          autoFocus: true,
          onEnter: () => void submit(),
        })),
      )
    }

    /** Password prompt of one locked workspace. */
    function PasswordDialog({ t, workspace, message, hint, onForgot, onClose, onSubmit }) {
      const [password, setPassword] = React.useState('')
      const [submitting, setSubmitting] = React.useState(false)
      const [failed, setFailed] = React.useState(message !== undefined && message !== '')
      const submit = async () => {
        if (submitting) return
        setSubmitting(true)
        try {
          await onSubmit(password)
        } finally {
          setSubmitting(false)
          setFailed(true)
        }
      }
      return h(
        Modal,
        {
          title: `${t('panel.unlockTitle')} · ${workspace.name}`,
          onClose,
          footer: [
            h(Button, { key: 'cancel', onClick: onClose }, t('panel.cancel')),
            ...(onForgot ? [h(Button, { key: 'forgot', onClick: onForgot }, t('panel.forgotPassword'))] : []),
            h(Button, { key: 'ok', kind: 'primary', onClick: () => void submit(), disabled: submitting }, t('panel.unlock')),
          ],
        },
        h(Field, { label: t('panel.passwordLabel') }, h(PasswordField, {
          t,
          value: password,
          onChange: (value) => { setPassword(value); setFailed(false) },
          autoFocus: true,
          onEnter: () => void submit(),
        })),
        hint && hint !== ''
          ? h('div', { style: { fontSize: 12, color: T.labelSecondary } }, t('panel.showHint') + '：' + hint)
          : null,
        failed ? h('div', { style: { color: T.error, fontSize: 12 } }, t('panel.wrongPassword')) : null,
      )
    }

    /** Missing-plugin report with the one-click install. */
    function PluginsDialog({ t, workspace, missing, optional, conflicts, busy, onClose, onInstall, onSkip }) {
      const conflictList = Array.isArray(conflicts) ? conflicts : []
      const hasGaps = missing.length > 0 || optional.length > 0
      return h(
        Modal,
        {
          title: `${t('panel.pluginsTitle')} · ${workspace.name}`,
          onClose,
          width: 460,
          footer: [
            h(Button, { key: 'skip', onClick: () => void onSkip(), disabled: busy }, busy ? t('panel.installing') : t('panel.skip')),
            optional.length === 0
              ? null
              : h(Button, { key: 'all', onClick: () => void onInstall(true), disabled: busy }, t('panel.installOptional')),
            h(Button, { key: 'ok', kind: 'primary', onClick: () => void onInstall(false), disabled: busy }, t('panel.install')),
          ],
        },
        h('div', { style: { fontSize: 12, color: T.labelSecondary } }, t('panel.pluginsBody')),
        hasGaps
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              missing.map((entry) =>
                h(
                  'div',
                  { key: entry.name, style: { display: 'flex', gap: 8, alignItems: 'center' } },
                  h(Badge, { tone: 'error' }, t('panel.required')),
                  h('span', { style: { fontFamily: T.mono, fontSize: 12 } }, entry.spec),
                ),
              ),
              optional.map((entry) =>
                h(
                  'div',
                  { key: entry.name, style: { display: 'flex', gap: 8, alignItems: 'center' } },
                  h(Badge, { tone: 'neutral' }, t('panel.optional')),
                  h('span', { style: { fontFamily: T.mono, fontSize: 12, color: T.labelSecondary } }, entry.spec),
                ),
              ),
            )
          : h('div', { style: { fontSize: 12, color: T.labelTertiary } }, t('panel.noPlugins')),
        conflictList.length === 0
          ? null
          : h(
              'div',
              { style: { marginTop: 12, borderTop: `1px solid ${T.borderL1}`, paddingTop: 10 } },
              h('div', { style: { fontSize: 12, color: T.warn, fontWeight: 600 } }, t('panel.conflict')),
              h('div', { style: { fontSize: 12, color: T.labelSecondary, marginTop: 4 } }, t('panel.conflictBody')),
              conflictList.map((item) =>
                h(
                  'div',
                  { key: item.name, style: { fontSize: 12, marginTop: 8, paddingLeft: 8, borderLeft: `2px solid ${T.warn}` } },
                  h('div', { style: { fontFamily: T.mono, color: T.labelPrimary } }, item.name),
                  (item.reasons ?? []).map((reason, i) =>
                    h('div', { key: i, style: { color: T.labelSecondary, marginTop: 2 } }, reason),
                  ),
                  typeof item.advice === 'string' && item.advice !== ''
                    ? h('div', { style: { color: T.labelPrimary, marginTop: 4 } }, `${t('panel.conflictAdvice')}：${item.advice}`)
                    : null,
                ),
              ),
            ),
      )
    }

    /** The URL of a freshly launched portable instance. */
    function LaunchedDialog({ t, workspace, url, pending, onClose, onRetry }) {
      const [copied, setCopied] = React.useState(false)
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(url)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        } catch {
          setCopied(false)
        }
      }
      return h(
        Modal,
        {
          title: `${t('panel.open')} · ${workspace.name}`,
          onClose,
          width: 460,
          footer: [
            h(Button, { key: 'close', onClick: onClose }, t('panel.dismiss')),
            url === ''
              ? h(Button, { key: 'retry', kind: 'primary', onClick: () => void onRetry() }, t('panel.retry'))
              : h(Button, { key: 'copy', onClick: () => void copy() }, copied ? t('panel.copied') : t('panel.copy')),
            url === ''
              ? null
              : h(
                  'a',
                  {
                    key: 'open',
                    href: url,
                    target: '_blank',
                    rel: 'noopener',
                    style: {
                      display: 'inline-flex',
                      alignItems: 'center',
                      height: 28,
                      padding: '0 12px',
                      borderRadius: T.radius,
                      background: T.brand,
                      color: 'var(--dsw-alias-bg-base, #fff)',
                      font: `13px/20px ${T.font}`,
                      textDecoration: 'none',
                    },
                  },
                  t('panel.openInstance'),
                ),
          ],
        },
        h('div', { style: { fontSize: 12, color: T.labelSecondary } }, t('panel.launchUrl')),
        h(
          'div',
          {
            style: {
              padding: '8px 10px',
              borderRadius: T.radius,
              background: T.bgLayer2,
              font: `12px/18px ${T.mono}`,
              wordBreak: 'break-all',
              color: T.labelPrimary,
            },
          },
          pending ? t('panel.opening') : url,
        ),
      )
    }

    /** Ask before copying this machine's DSH account onto the volume. */
    function AccountDialog({ t, volume, onClose, onSubmit }) {
      const [busy, setBusy] = React.useState(false)
      return h(
        Modal,
        {
          title: t('panel.accountImport'),
          onClose,
          width: 460,
          footer: [
            h(Button, { key: 'cancel', onClick: onClose }, t('panel.cancel')),
            h(Button, {
              key: 'ok',
              kind: 'primary',
              disabled: busy,
              onClick: async () => {
                if (busy) return
                setBusy(true)
                try {
                  await onSubmit()
                } finally {
                  setBusy(false)
                }
              },
            }, busy ? t('panel.working') : t('panel.accountImport')),
          ],
        },
        h('div', { style: { fontSize: 12, color: T.labelSecondary, lineHeight: '20px' } }, t('panel.accountBody')),
        h(
          'div',
          {
            style: {
              marginTop: 8,
              padding: '8px 10px',
              borderRadius: T.radius,
              background: T.bgLayer2,
              font: `12px/18px ${T.mono}`,
              wordBreak: 'break-all',
              color: T.labelPrimary,
            },
          },
          volume.account?.portableHome ?? volume.root,
        ),
      )
    }

    /** Yes/no confirmation. */
    function ConfirmDialog({ t, title, body, confirmLabel, danger, onClose, onConfirm }) {
      const [busy, setBusy] = React.useState(false)
      return h(
        Modal,
        {
          title,
          onClose,
          footer: [
            h(Button, { key: 'cancel', onClick: onClose }, t('panel.cancel')),
            h(Button, {
              key: 'ok',
              kind: danger ? 'danger' : 'primary',
              onClick: async () => {
                if (busy) return
                setBusy(true)
                try {
                  await onConfirm()
                } finally {
                  setBusy(false)
                }
              },
              disabled: busy,
            }, confirmLabel),
          ],
        },
        h('div', { style: { fontSize: 12, color: T.labelSecondary } }, body),
      )
    }

    /** Move a workspace to another portable root. */
    function MigrateDialog({ t, volume, workspace, volumes, onClose, onSubmit }) {
      const others = volumes.filter((entry) => entry.root.toLowerCase() !== volume.root.toLowerCase()).map((entry) => entry.root)
      const [toRoot, setToRoot] = React.useState(others[0] ?? '')
      const [move, setMove] = React.useState(false)
      const [password, setPassword] = React.useState('')
      const [submitting, setSubmitting] = React.useState(false)
      const needsPassword = workspace.passwordProtected === true
      const submit = async () => {
        if (submitting || toRoot.trim() === '') return
        if (needsPassword && password.trim() === '') return
        setSubmitting(true)
        try {
          await onSubmit(toRoot.trim(), move, password)
        } finally {
          setSubmitting(false)
        }
      }
      return h(
        Modal,
        {
          title: `${t('panel.migrate')} · ${workspace.name}`,
          onClose,
          footer: [
            h(Button, { key: 'cancel', onClick: onClose }, t('panel.cancel')),
            h(Button, {
              key: 'ok',
              kind: 'primary',
              onClick: () => void submit(),
              disabled: submitting || toRoot.trim() === '' || (needsPassword && password.trim() === ''),
            }, submitting ? t('panel.migrating') : t('panel.migrateGo')),
          ],
        },
        h(Field, { label: t('panel.moveTo') }, h(TextField, {
          value: toRoot,
          onChange: setToRoot,
          placeholder: t('panel.rootPlaceholder'),
          autoFocus: !needsPassword,
        })),
        needsPassword
          ? h(Field, { label: t('panel.migratePasswordLabel') }, h(PasswordField, {
              t,
              value: password,
              onChange: setPassword,
              placeholder: t('panel.migratePasswordPlaceholder'),
              autoFocus: true,
              onEnter: () => void submit(),
            }))
          : null,
        others.length === 0
          ? null
          : h(
              'div',
              { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              others.map((root) =>
                h(Button, { key: root, onClick: () => setToRoot(root) }, root),
              ),
            ),
        h(
          'label',
          { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: T.labelSecondary } },
          h('input', {
            type: 'checkbox',
            checked: move,
            onChange: (event) => setMove(event.target.checked),
          }),
          t('panel.migrateMove'),
        ),
      )
    }

    /**
     * Delete requires the exact acknowledgement phrase AND the workspace
     * password (empty when the workspace has none). The Host validates both
     * again, so typing the phrase is mandatory even via a raw HTTP call.
     */
    function DeleteDialog({ t, workspace, busy, onClose, onSubmit }) {
      const phrase = '我已知晓删除该工作区，无法恢复！'
      const [typed, setTyped] = React.useState('')
      const [password, setPassword] = React.useState('')
      const [submitting, setSubmitting] = React.useState(false)
      const exact = typed === phrase
      const submit = async () => {
        if (submitting || !exact) return
        setSubmitting(true)
        try {
          await onSubmit(typed, password)
        } finally {
          setSubmitting(false)
        }
      }
      return h(
        Modal,
        {
          title: `${t('panel.delete')} · ${workspace.name}`,
          onClose,
          width: 460,
          footer: [
            h(Button, { key: 'cancel', onClick: onClose }, t('panel.cancel')),
            h(Button, {
              key: 'ok',
              kind: 'danger',
              onClick: () => void submit(),
              disabled: submitting || busy === true || !exact,
            }, submitting ? t('panel.working') : t('panel.deleteNow')),
          ],
        },
        h('div', { style: { fontSize: 12, color: T.labelSecondary } }, t('panel.deletePhrase')),
        h(
          'div',
          {
            style: {
              margin: '8px 0 4px',
              padding: '8px 10px',
              borderRadius: T.radius,
              background: T.bgLayer2,
              font: `12px/18px ${T.mono}`,
              color: T.labelPrimary,
              userSelect: 'none',
            },
          },
          phrase,
        ),
        h(Field, { label: t('panel.deletePhraseLabel') }, h(TextField, {
          value: typed,
          onChange: setTyped,
          placeholder: phrase,
          autoFocus: true,
        })),
        h(Field, { label: t('panel.deletePasswordLabel') }, h(PasswordField, {
          t,
          value: password,
          onChange: setPassword,
          placeholder: t('panel.deletePasswordPlaceholder'),
          onEnter: () => void submit(),
        })),
      )
    }

    /** Change (or clear) the workspace password after verifying the old one. */
    function ChangePasswordDialog({ t, workspace, busy, onClose, onSubmit }) {
      const [oldPassword, setOldPassword] = React.useState('')
      const [newPassword, setNewPassword] = React.useState('')
      const [confirmPassword, setConfirmPassword] = React.useState('')
      const [hint, setHint] = React.useState(workspace.passwordHint ?? '')
      const [mismatch, setMismatch] = React.useState(false)
      const [submitting, setSubmitting] = React.useState(false)
      const submit = async () => {
        if (submitting) return
        if (newPassword !== confirmPassword) {
          setMismatch(true)
          return
        }
        setMismatch(false)
        setSubmitting(true)
        try {
          await onSubmit(oldPassword, newPassword, confirmPassword, hint)
        } finally {
          setSubmitting(false)
        }
      }
      return h(
        Modal,
        {
          title: `${t('panel.changePasswordTitle')} · ${workspace.name}`,
          onClose,
          footer: [
            h(Button, { key: 'cancel', onClick: onClose }, t('panel.cancel')),
            h(Button, {
              key: 'ok',
              kind: 'primary',
              onClick: () => void submit(),
              disabled: submitting || busy === true,
            }, submitting ? t('panel.working') : t('panel.changePassword')),
          ],
        },
        h(Field, { label: t('panel.oldPassword') }, h(PasswordField, {
          t,
          value: oldPassword,
          onChange: setOldPassword,
          placeholder: t('panel.oldPasswordPlaceholder'),
          autoFocus: true,
        })),
        h(Field, { label: t('panel.newPassword') }, h(PasswordField, {
          t,
          value: newPassword,
          onChange: (value) => { setNewPassword(value); setMismatch(false) },
          placeholder: t('panel.newPasswordPlaceholder'),
        })),
        h(Field, { label: t('panel.confirmNewPassword') }, h(PasswordField, {
          t,
          value: confirmPassword,
          onChange: (value) => { setConfirmPassword(value); setMismatch(false) },
          placeholder: t('panel.confirmNewPasswordPlaceholder'),
          onEnter: () => void submit(),
        })),
        h(Field, { label: t('panel.hintLabel') }, h(TextField, { value: hint, onChange: setHint, placeholder: t('panel.hintPlaceholder') })),
        mismatch
          ? h('div', { style: { color: T.error, fontSize: 12 } }, t('panel.passwordMismatch'))
          : null,
      )
    }

    /** Reset a forgotten password with the one-time recovery code (0.1.4). */
    function ForgotPasswordDialog({ t, volume, workspace, onClose, onDone }) {
      const [recoveryCode, setRecoveryCode] = React.useState('')
      const [newPassword, setNewPassword] = React.useState('')
      const [confirmPassword, setConfirmPassword] = React.useState('')
      const [hint, setHint] = React.useState('')
      const [mismatch, setMismatch] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [err, setErr] = React.useState('')
      const submit = async () => {
        if (busy) return
        if (newPassword !== confirmPassword) { setMismatch(true); return }
        setMismatch(false); setBusy(true); setErr('')
        try {
          const r = await request('/password/recover', {
            root: volume.root, id: workspace.id, recoveryCode: recoveryCode.trim(),
            newPassword, confirmPassword, hint: hint.trim(),
          })
          await onDone(r)
        } catch (e) { setErr(errorMessageOf(e, t)) }
        finally { setBusy(false) }
      }
      return h(Modal, {
        title: t('panel.recoverTitle'), onClose, width: 460,
        footer: [
          h(Button, { key: 'cancel', onClick: onClose }, t('panel.cancel')),
          h(Button, { key: 'ok', kind: 'primary', onClick: () => void submit(), disabled: busy }, busy ? t('panel.working') : t('panel.recoverGo')),
        ],
      },
        h('div', { style: { fontSize: 12, color: T.labelSecondary, lineHeight: '20px' } }, t('panel.recoverBody')),
        h(Field, { label: t('panel.recoveryCodeLabel') }, h(TextField, { value: recoveryCode, onChange: setRecoveryCode, placeholder: t('panel.recoveryCodePlaceholder'), autoFocus: true })),
        h(Field, { label: t('panel.newPassword') }, h(PasswordField, { t, value: newPassword, onChange: (v) => { setNewPassword(v); setMismatch(false) }, placeholder: t('panel.newPasswordPlaceholder') })),
        h(Field, { label: t('panel.confirmNewPassword') }, h(PasswordField, { t, value: confirmPassword, onChange: (v) => { setConfirmPassword(v); setMismatch(false) }, placeholder: t('panel.confirmNewPasswordPlaceholder'), onEnter: () => void submit() })),
        h(Field, { label: t('panel.hintLabel') }, h(TextField, { value: hint, onChange: setHint, placeholder: t('panel.hintPlaceholder') })),
        mismatch ? h('div', { style: { color: T.error, fontSize: 12 } }, t('panel.passwordMismatch')) : null,
        err ? h('div', { style: { color: T.error, fontSize: 12 } }, err) : null,
      )
    }

    /** Show a freshly minted one-time recovery code exactly once (0.1.4). */
    function RecoveryDialog({ t, code, hint, onClose }) {
      return h(Modal, {
        title: t('panel.recoveryTitle'), onClose, width: 460,
        footer: [h(Button, { key: 'ok', kind: 'primary', onClick: onClose }, t('panel.recoveryGotIt'))],
      },
        h('div', { style: { fontSize: 12, color: T.warn, lineHeight: '20px' } }, t('panel.recoveryWarn')),
        h(Field, { label: t('panel.recoveryCodeLabel') },
          h('div', { style: { padding: '8px 10px', borderRadius: T.radius, background: T.bgLayer2, font: '15px/22px ' + T.mono, letterSpacing: '1px', userSelect: 'all' } }, code)),
        hint && hint !== '' ? h('div', { style: { fontSize: 12, color: T.labelSecondary } }, t('panel.hintLabel') + '：' + hint) : null,
      )
    }

    /** Declare a plugin that should be installed on the portable profile. */
    function AddPluginDialog({ t, workspace, busy, onClose, onSubmit }) {
      const [spec, setSpec] = React.useState('')
      const [optional, setOptional] = React.useState(false)
      const [password, setPassword] = React.useState('')
      const [submitting, setSubmitting] = React.useState(false)
      const submit = async () => {
        if (submitting || spec.trim() === '') return
        setSubmitting(true)
        try {
          await onSubmit(spec.trim(), optional, password)
        } finally {
          setSubmitting(false)
        }
      }
      return h(
        Modal,
        {
          title: `${t('panel.addPluginTitle')} · ${workspace.name}`,
          onClose,
          width: 460,
          footer: [
            h(Button, { key: 'cancel', onClick: onClose }, t('panel.cancel')),
            h(Button, {
              key: 'ok',
              kind: 'primary',
              onClick: () => void submit(),
              disabled: submitting || busy === true || spec.trim() === '',
            }, submitting ? t('panel.working') : t('panel.addPlugin')),
          ],
        },
        h('div', { style: { fontSize: 12, color: T.labelSecondary, lineHeight: '20px' } }, t('panel.addPluginBody')),
        h(Field, { label: t('panel.pluginSpec') }, h(TextField, {
          value: spec,
          onChange: setSpec,
          placeholder: t('panel.pluginSpecPlaceholder'),
          autoFocus: true,
          onEnter: () => void submit(),
        })),
        h(
          'label',
          { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: T.labelSecondary } },
          h('input', {
            type: 'checkbox',
            checked: optional,
            onChange: (event) => setOptional(event.target.checked),
          }),
          t('panel.addPluginOptional'),
        ),
        workspace.passwordProtected === true
          ? h(Field, { label: t('panel.workspacePassword') }, h(PasswordField, {
              t,
              value: password,
              onChange: setPassword,
              placeholder: t('panel.workspacePasswordPlaceholder'),
            }))
          : null,
      )
    }
    // #endregion

    /**
     * The client half only needs slots and locale; every other service
     * (`sessions`, `uiWorkspace`, …) is read lazily so a missing one degrades
     * the page instead of blocking it.
     */

    /** Rename an existing workspace (0.1.3). */
    function RenameDialog({ t, volume, workspace, onClose, onDone }) {
      const [name, setName] = React.useState(workspace.name ?? '')
      const [password, setPassword] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [err, setErr] = React.useState('')
      const submit = async () => {
        if (busy || name.trim() === '') return
        setBusy(true); setErr('')
        try {
          await request('/update', { root: volume.root, id: workspace.id, name: name.trim(), password })
          await onDone(t('panel.renamed'))
        } catch (e) { setErr(errorMessageOf(e, t)) }
        finally { setBusy(false) }
      }
      return h(Modal, {
        title: t('panel.renameTitle'), onClose, width: 420,
        footer: [
          h(Button, { key: 'cancel', onClick: onClose }, t('panel.cancel')),
          h(Button, { key: 'ok', kind: 'primary', onClick: () => void submit(), disabled: busy || name.trim() === '' }, busy ? t('panel.working') : t('panel.renameGo')),
        ],
      },
        h(Field, { label: t('panel.name') }, h(TextField, { value: name, onChange: setName, autoFocus: true, onEnter: () => void submit() })),
        workspace.passwordProtected === true
          ? h(Field, { label: t('panel.workspacePassword') }, h(PasswordField, { t, value: password, onChange: setPassword, placeholder: t('panel.workspacePasswordPlaceholder'), onEnter: () => void submit() }))
          : null,
        err ? h('div', { style: { color: T.error, fontSize: 12 } }, err) : null,
      )
    }

    /** Migrate a multi-selection of sessions between containers (0.1.3). */
    function SessionMigrateDialog({ t, volume, workspace, volumes, onClose, onDone }) {
      // A locked workspace must be verified BEFORE any session title is listed.
      const needsGate = workspace.passwordProtected === true
      const [verified, setVerified] = React.useState(!needsGate)
      const [gatePassword, setGatePassword] = React.useState('')
      const [accessPassword, setAccessPassword] = React.useState('')
      const [gateErr, setGateErr] = React.useState('')
      const [gateBusy, setGateBusy] = React.useState(false)
      const [sourceKind, setSourceKind] = React.useState('workspace')
      const [sessions, setSessions] = React.useState([])
      const [selected, setSelected] = React.useState([])
      const [destKey, setDestKey] = React.useState('')
      const [move, setMove] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [err, setErr] = React.useState('')
      const sourceSpec = sourceKind === 'local'
        ? { kind: 'local' }
        : { kind: 'portable', root: volume.root, id: workspace.id }
      const destOptions = []
      for (const v of volumes || []) {
        for (const w of (v.workspaces || [])) {
          // Never offer the very workspace we are copying from as a destination.
          if (sourceKind === 'workspace' && v.root === volume.root && w.id === workspace.id) continue
          destOptions.push({ key: v.root + '::' + w.id, label: v.root + ' / ' + w.name, spec: { kind: 'portable', root: v.root, id: w.id } })
        }
      }
      if (sourceKind !== 'local') destOptions.push({ key: 'local', label: t('panel.localWorkspace'), spec: { kind: 'local' } })
      const dest = destOptions.find((o) => o.key === destKey)
      const verifyGate = async () => {
        if (gateBusy) return
        setGateBusy(true); setGateErr('')
        try {
          await request('/password/verify', { root: volume.root, id: workspace.id, password: gatePassword })
          setAccessPassword(gatePassword)
          setVerified(true)
        } catch (e) { setGateErr(errorMessageOf(e, t)) }
        finally { setGateBusy(false) }
      }
      React.useEffect(() => {
        if (!verified) return
        let alive = true
        setSessions([]); setSelected([]); setErr('')
        request('/sessions/list', { source: sourceSpec, password: accessPassword })
          .then((r) => { if (alive) setSessions(Array.isArray(r.sessions) ? r.sessions : []) })
          .catch((e) => { if (alive) setErr(errorMessageOf(e, t)) })
        return () => { alive = false }
      }, [sourceKind, verified, accessPassword])
      const toggle = (id) => setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
      const submit = async () => {
        if (busy || selected.length === 0 || dest === undefined) return
        setBusy(true); setErr('')
        try {
          const r = await request('/sessions/migrate', { source: sourceSpec, target: dest.spec, sessionIds: selected, move, password: accessPassword })
          await onDone(t('panel.sessionMigrated', { count: r.moved }).replace('{count}', String(r.moved)))
        } catch (e) { setErr(errorMessageOf(e, t)) }
        finally { setBusy(false) }
      }
      if (!verified) {
        return h(Modal, {
          title: t('panel.sessionVerifyTitle'), onClose, width: 420,
          footer: [
            h(Button, { key: 'cancel', onClick: onClose }, t('panel.cancel')),
            h(Button, { key: 'ok', kind: 'primary', onClick: () => void verifyGate(), disabled: gateBusy }, gateBusy ? t('panel.working') : t('panel.sessionVerifyGo')),
          ],
        },
          h('div', { style: { fontSize: 12, color: T.labelSecondary, lineHeight: '20px' } }, t('panel.sessionVerifyBody')),
          h(Field, { label: t('panel.workspacePassword') }, h(PasswordField, { t, value: gatePassword, onChange: setGatePassword, autoFocus: true, placeholder: t('panel.workspacePasswordPlaceholder'), onEnter: () => void verifyGate() })),
          gateErr ? h('div', { style: { color: T.error, fontSize: 12 } }, gateErr) : null,
        )
      }
      return h(Modal, {
        title: t('panel.sessionMigrateTitle'), onClose, width: 540,
        footer: [
          h(Button, { key: 'cancel', onClick: onClose }, t('panel.cancel')),
          h(Button, { key: 'ok', kind: 'primary', onClick: () => void submit(), disabled: busy || selected.length === 0 || dest === undefined }, busy ? t('panel.working') : t('panel.sessionMigrateGo')),
        ],
      },
        h('div', { style: { fontSize: 12, color: T.labelSecondary } }, t('panel.sessionMigrateBody')),
        h('div', { style: { fontSize: 12, color: T.labelSecondary } }, t('panel.sessionFrom')),
        h('div', { style: { display: 'flex', gap: 6 } },
          h(Button, { kind: sourceKind === 'workspace' ? 'primary' : 'default', onClick: () => setSourceKind('workspace') }, t('panel.thisWorkspace')),
          h(Button, { kind: sourceKind === 'local' ? 'primary' : 'default', onClick: () => setSourceKind('local') }, t('panel.localWorkspace')),
        ),
        h('div', { style: { maxHeight: 180, overflow: 'auto', border: '0.5px solid ' + T.border, borderRadius: T.radius, padding: 6 } },
          sessions.length === 0 ? h('div', { style: { fontSize: 12, color: T.labelTertiary } }, t('panel.sessionNone')) : null,
          h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 } },
            h('input', { type: 'checkbox', checked: selected.length === sessions.length && sessions.length > 0, onChange: (e) => setSelected(e.target.checked ? sessions.map((s) => s.id) : []) }),
            t('panel.sessionSelectAll'),
          ),
          sessions.map((s) => h('label', { key: s.id, style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 } },
            h('input', { type: 'checkbox', checked: selected.includes(s.id), onChange: () => toggle(s.id) }),
            h('span', null, s.title && s.title !== '' ? s.title : t('panel.sessionNoTitle')),
            h('span', { style: { color: T.labelTertiary, fontFamily: T.mono, fontSize: 11 } }, ' · ' + String(s.id).slice(0, 8)),
          )),
        ),
        h('div', { style: { fontSize: 12, color: T.labelSecondary } }, t('panel.sessionTo')),
        h('div', { style: { maxHeight: 110, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 3 } },
          destOptions.map((o) => h(Button, { key: o.key, kind: destKey === o.key ? 'primary' : 'default', onClick: () => setDestKey(o.key) }, o.label)),
        ),
        h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 } },
          h('input', { type: 'checkbox', checked: move, onChange: (e) => setMove(e.target.checked) }),
          t('panel.sessionMove'),
        ),
        err ? h('div', { style: { color: T.error, fontSize: 12 } }, err) : null,
      )
    }

    /** Backup list, retention settings, manual backup and guarded restore (0.1.3). */
    function BackupDialog({ t, volume, workspace, volumes, onClose, onDone }) {
      const RESTORE_PHRASE = '我已知晓恢复操作将覆盖原有移动工作区，请谨慎操作！'
      const [max, setMax] = React.useState('5')
      const [auto, setAuto] = React.useState(false)
      const [backups, setBackups] = React.useState([])
      const [backupDir, setBackupDir] = React.useState('')
      const [destKey, setDestKey] = React.useState(volume.root + '::' + workspace.id)
      const [typed, setTyped] = React.useState('')
      const [password, setPassword] = React.useState('')
      const [backupPassword, setBackupPassword] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [err, setErr] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const destOptions = []
      for (const v of volumes || []) {
        for (const w of (v.workspaces || [])) {
          destOptions.push({ key: v.root + '::' + w.id, label: v.root + ' / ' + w.name, root: v.root, id: w.id })
        }
      }
      const dest = destOptions.find((o) => o.key === destKey)
      const refresh = () => request('/backups', { roots: (volumes || []).map((v) => v.root) })
        .then((r) => setBackups(Array.isArray(r.backups) ? r.backups : [])).catch(() => {})
      React.useEffect(() => {
        request('/settings', {}).then((r) => { setMax(String(r.maxBackups ?? 5)); setAuto(!!r.autoBackup) }).catch(() => {})
        refresh()
      }, [])
      const saveSettings = async () => {
        if (busy) return
        setBusy(true); setErr(''); setMsg('')
        try { await request('/settings', { maxBackups: Number(max) || 5, autoBackup: auto }); setMsg(t('panel.settingsSaved')) }
        catch (e) { setErr(errorMessageOf(e, t)) } finally { setBusy(false) }
      }
      const makeBackup = async () => {
        if (busy) return
        setBusy(true); setErr(''); setMsg('')
        try { await request('/backup/create', { root: volume.root, id: workspace.id, kind: 'manual', password: backupPassword }); setMsg(t('panel.backupDone')); await refresh() }
        catch (e) { setErr(errorMessageOf(e, t)) } finally { setBusy(false) }
      }
      const kindLabel = (k) => k === 'auto' ? t('panel.backupKindAuto') : k === 'pre-restore' ? t('panel.backupKindPre') : t('panel.backupKindManual')
      const restore = async () => {
        if (busy || typed !== RESTORE_PHRASE || backupDir === '' || dest === undefined) return
        setBusy(true); setErr('')
        try {
          await request('/restore', { root: dest.root, id: dest.id, backupDir, confirmPhrase: typed, password })
          await onDone(t('panel.restoreDone'))
        } catch (e) { setErr(errorMessageOf(e, t)) } finally { setBusy(false) }
      }
      return h(Modal, {
        title: t('panel.backupTitle'), onClose, width: 560,
        footer: [
          h(Button, { key: 'cancel', onClick: onClose }, t('panel.cancel')),
          h(Button, { key: 'ok', kind: 'danger', onClick: () => void restore(), disabled: busy || typed !== RESTORE_PHRASE || backupDir === '' || dest === undefined }, busy ? t('panel.working') : t('panel.restoreNow')),
        ],
      },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' } },
          h(Field, { label: t('panel.maxBackupCount') }, h(TextField, { value: max, onChange: setMax, type: 'number' })),
          h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 } },
            h('input', { type: 'checkbox', checked: auto, onChange: (e) => setAuto(e.target.checked) }),
            t('panel.autoBackup'),
          ),
          h(Button, { onClick: () => void saveSettings(), disabled: busy }, t('panel.saveSettings')),
          h(Button, { onClick: () => void makeBackup(), disabled: busy }, t('panel.backupNow')),
        ),
        workspace.passwordProtected === true
          ? h(Field, { label: t('panel.workspacePassword') }, h(PasswordField, { t, value: backupPassword, onChange: setBackupPassword, placeholder: t('panel.workspacePasswordPlaceholder') }))
          : null,
        h('div', { style: { fontSize: 12, color: T.labelSecondary } }, t('panel.backupList')),
        h('div', { style: { maxHeight: 150, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 3 } },
          backups.length === 0 ? h('div', { style: { fontSize: 12, color: T.labelTertiary } }, t('panel.backupEmpty')) : null,
          backups.map((b) => h(Button, { key: b.dir, kind: backupDir === b.dir ? 'primary' : 'default', onClick: () => setBackupDir(b.dir) },
            (b.name || b.workspaceId) + ' · ' + kindLabel(b.kind) + ' · ' + new Date(b.createdAt).toLocaleString() + ' · ' + (b.files ?? 0) + (b.zip === true ? ' · ZIP' : ''))),
        ),
        h('div', { style: { fontSize: 12, color: T.labelSecondary } }, t('panel.restoreTo')),
        h('div', { style: { maxHeight: 90, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 3 } },
          destOptions.map((o) => h(Button, { key: o.key, kind: destKey === o.key ? 'primary' : 'default', onClick: () => setDestKey(o.key) }, o.label)),
        ),
        h('div', { style: { fontSize: 12, color: T.warn } }, t('panel.restoreWarning')),
        h('div', { style: { fontSize: 12, color: T.labelSecondary } }, t('panel.restorePhrase')),
        h('div', { style: { padding: '6px 10px', borderRadius: T.radius, background: T.bgLayer2, font: '12px/18px ' + T.mono, userSelect: 'none' } }, RESTORE_PHRASE),
        h(Field, { label: t('panel.restorePhraseLabel') }, h(TextField, { value: typed, onChange: setTyped, placeholder: RESTORE_PHRASE })),
        h(Field, { label: t('panel.restorePasswordLabel') }, h(PasswordField, { t, value: password, onChange: setPassword, placeholder: t('panel.restorePasswordPlaceholder') })),
        msg ? h('div', { style: { color: T.success, fontSize: 12 } }, msg) : null,
        err ? h('div', { style: { color: T.error, fontSize: 12 } }, err) : null,
      )
    }
    const inject = ['slots', 'locale']

    /**
     * Client plugin body: dictionaries first, then the two registrations. Each
     * registration is guarded so a Host without the slot keeps the page booting.
     * @param {object} ctx - client root context.
     */
    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'portable-workspace: dictionaries')
      } catch (error) {
        console.warn('portable-workspace: dictionary registration failed:', error)
      }

      try {
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: PANEL_ID, locale: NS },
            WorkspacePanel,
          ),
        )
      } catch (error) {
        console.warn('portable-workspace: main panel registration failed:', error)
      }

      try {
        const t = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : (key) => zh[key] ?? key
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 6,
              locale: NS,
              label: () => t('panel.title'),
            },
            ({ size }) => h(Icon, { size: size ?? 16 }),
          ),
        )
      } catch (error) {
        console.warn('portable-workspace: sidebar row registration failed:', error)
      }
    }

    return { inject, apply, name: NS }
  },
})
