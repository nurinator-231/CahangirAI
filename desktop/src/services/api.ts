import { invoke } from "@tauri-apps/api/core";
import {
  AppConfig,
  ChatMessage,
  ClipboardItem,
  DeviceItem,
  EventItem,
  MemoryItem,
  PlanBlock,
  ProjectItem,
  ReminderItem,
  SyncStatus,
  SystemMetrics,
  TaskItem,
  TransferItem,
} from "../types";

export type EntityName = "reminders" | "memories" | "projects" | "tasks" | "events" | "plan_blocks" | "clipboard_items";

/** Error text from a rejected Tauri command. */
export const errText = (e: any): string => (typeof e === "string" ? e : e?.message || JSON.stringify(e));

export const api = {
  // Config & pairing
  getAppConfig: (): Promise<AppConfig> => invoke("get_app_config"),
  saveAppConfig: (cfg: AppConfig): Promise<AppConfig> => invoke("save_app_config", { cfg }),
  getAutostartEnabled: (): Promise<boolean> => invoke("get_autostart_enabled"),
  testServerConnection: (serverUrl: string): Promise<any> => invoke("test_server_connection", { serverUrl }),
  registerDeviceApi: (serverUrl: string, adminToken: string, deviceName: string): Promise<any> =>
    invoke("register_device_api", { serverUrl, adminToken, deviceName }),
  unpairDevice: (): Promise<void> => invoke("unpair_device"),
  listPairedDevices: (): Promise<DeviceItem[]> => invoke("list_paired_devices"),
  listDevicesApi: (serverUrl: string, adminToken: string): Promise<DeviceItem[]> => invoke("list_devices_api", { serverUrl, adminToken }),
  revokeDeviceApi: (adminToken: string, targetDeviceId: string): Promise<any> => invoke("revoke_device_api", { adminToken, targetDeviceId }),

  // Sync
  triggerDeltaSync: (): Promise<any> => invoke("trigger_delta_sync"),
  getSyncStatus: (): Promise<SyncStatus> => invoke("get_sync_status"),
  listConflicts: (): Promise<any[]> => invoke("list_conflicts"),

  // Generic entities
  list: <T = any>(entity: EntityName, includeDeleted = false): Promise<T[]> => invoke("entity_list", { entity, includeDeleted }),
  save: <T = any>(entity: EntityName, item: Partial<T> & Record<string, any>): Promise<T> => invoke("entity_save", { entity, item }),
  saveMany: <T = any>(entity: EntityName, items: Record<string, any>[]): Promise<T[]> => invoke("entity_save_many", { entity, items }),
  remove: (entity: EntityName, id: string): Promise<boolean> => invoke("entity_delete", { entity, id }),
  getTasks: () => api.list<TaskItem>("tasks"),
  getEvents: () => api.list<EventItem>("events"),
  getBlocks: () => api.list<PlanBlock>("plan_blocks"),
  getClipboardItems: () => api.list<ClipboardItem>("clipboard_items"),

  // Memories / reminders / projects (typed helpers)
  getMemories: (includeDeleted = false): Promise<MemoryItem[]> => invoke("get_memories", { includeDeleted }),
  saveMemory: (mem: Partial<MemoryItem>): Promise<MemoryItem> => invoke("save_memory", { mem }),
  deleteMemory: (id: string): Promise<boolean> => invoke("delete_memory", { id }),
  getReminders: (includeDeleted = false): Promise<ReminderItem[]> => invoke("get_reminders", { includeDeleted }),
  saveReminder: (rem: Partial<ReminderItem>): Promise<ReminderItem> => invoke("save_reminder", { rem }),
  completeReminder: (id: string): Promise<void> => invoke("complete_reminder", { id }),
  snoozeReminder: (id: string, minutes = 10): Promise<number> => invoke("snooze_reminder", { id, minutes }),
  deleteReminder: (id: string): Promise<boolean> => invoke("delete_reminder", { id }),
  getProjects: (includeDeleted = false): Promise<ProjectItem[]> => invoke("get_projects", { includeDeleted }),
  saveProject: (prj: Partial<ProjectItem>): Promise<ProjectItem> => invoke("save_project", { prj }),
  deleteProject: (id: string): Promise<boolean> => invoke("delete_project", { id }),
  getNotificationPermission: (): Promise<string> => invoke("get_notification_permission"),
  testNotification: (): Promise<void> => invoke("test_notification"),

  // AI (Debian AI router)
  aiProviders: (): Promise<any> => invoke("ai_providers"),
  aiChat: (messages: { role: string; content: string }[], context?: string): Promise<{ status: number; body: any }> =>
    invoke("ai_chat", { messages, context }),
  aiParse: (text: string, nowLocal: string, tzOffsetMinutes: number, weekday: string): Promise<{ status: number; body: any }> =>
    invoke("ai_parse", { text, nowLocal, tzOffsetMinutes, weekday }),

  // File transfer
  pingPeer: (peerIp: string, peerPort: number): Promise<any> => invoke("ping_peer", { peerIp, peerPort }),
  startFileSend: (peerIp: string, peerPort: number, filePath: string, peerName?: string): Promise<any> =>
    invoke("start_file_send", { peerIp, peerPort, filePath, peerName }),
  cancelFileTransfer: (): Promise<void> => invoke("cancel_file_transfer"),
  getTransferHistory: (): Promise<TransferItem[]> => invoke("get_transfer_history"),
  clearTransferHistory: (): Promise<void> => invoke("clear_transfer_history"),
  pickFileDialog: (): Promise<string | null> => invoke("pick_file_dialog"),
  pickFolderDialog: (): Promise<string | null> => invoke("pick_folder_dialog"),

  // Clipboard
  shareClipboard: (text?: string): Promise<any> => invoke("share_clipboard", { text }),
  sendClipboardToPeer: (peerIp: string, peerPort: number, text: string): Promise<any> => invoke("send_clipboard_to_peer_cmd", { peerIp, peerPort, text }),
  copyToClipboard: (text: string): Promise<void> => invoke("copy_to_clipboard", { text }),
  setLastClipboardHash: (hash: string): Promise<void> => invoke("set_last_clipboard_hash", { hash }),

  // System / chat / app
  getSystemMetrics: (): Promise<SystemMetrics> => invoke("get_system_metrics"),
  getChatSessions: (): Promise<string[]> => invoke("get_chat_sessions"),
  getChatHistory: (sessionId: string): Promise<ChatMessage[]> => invoke("get_chat_history", { sessionId }),
  saveChatMessage: (msg: Partial<ChatMessage>): Promise<void> => invoke("save_chat_message", { msg }),
  deleteChatSession: (sessionId: string): Promise<void> => invoke("delete_chat_session", { sessionId }),
  restartApp: (): Promise<void> => invoke("restart_app"),
  appVersion: (): Promise<string> => invoke("app_version"),
};
