/**
 * Shared constants of the portable-workspace bundle.
 *
 * @module dsh-portable-workspace/lib/constants
 */

/** Namespace/id of this bundle everywhere the Loader, slots and locale need it. */
export const NS = 'portable-workspace'
/** Browser route prefix served by the Host half. */
export const ROUTE_PREFIX = '/portable-workspace'
/** Slot id of the sidebar entry and the `main` panel it opens. */
export const PANEL_ID = 'portable-workspace'
/** Profile name the portable instance boots. */
export const PROFILE_NAME = 'portable'
/** How many bytes of a request body the Host half accepts. */
export const MAX_BODY_BYTES = 64 * 1024
/** Agent tool name. */
export const TOOL_NAME = 'portable_workspace'
/** Directory under `<root>/support` that receives the vendored plugin package. */
export const VENDORED_PLUGIN_DIR = 'plugins'
/** Bundles a portable profile starts from. */
export const PORTABLE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/**
 * Exact phrase the user must type before a workspace can be deleted.
 *
 * Kept on the Host so a crafted request cannot bypass the confirmation by
 * calling the route directly. The client shows the same literal string.
 */
export const DELETE_CONFIRM_PHRASE = '我已知晓删除该工作区，无法恢复！'
export const RESTORE_CONFIRM_PHRASE = '我已知晓恢复操作将覆盖原有移动工作区，请谨慎操作！'
