import { invoke } from "@tauri-apps/api/core";
import {
  AppConfig,
  ChatMessage,
  DeviceItem,
  MemoryItem,
  ProjectItem,
  ReminderItem,
  SystemMetrics,
  TransferItem,
} from "../types";

export const api = {
  // Config & Auth
  getAppConfig: async (): Promise<AppConfig> => {
    return await invoke("get_app_config");
  },

  saveAppConfig: async (cfg: AppConfig): Promise<void> => {
    return await invoke("save_app_config", { cfg });
  },

  testServerConnection: async (serverUrl: string): Promise<any> => {
    return await invoke("test_server_connection", { serverUrl });
  },

  registerDeviceApi: async (
    serverUrl: string,
    adminToken: string,
    deviceId: string,
    deviceName: string
  ): Promise<any> => {
    return await invoke("register_device_api", {
      serverUrl,
      adminToken,
      deviceId,
      deviceName,
    });
  },

  listDevicesApi: async (serverUrl: string, adminToken: string): Promise<DeviceItem[]> => {
    return await invoke("list_devices_api", { serverUrl, adminToken });
  },

  revokeDeviceApi: async (
    serverUrl: string,
    adminToken: string,
    targetDeviceId: string
  ): Promise<any> => {
    return await invoke("revoke_device_api", {
      serverUrl,
      adminToken,
      targetDeviceId,
    });
  },

  // Delta Sync
  triggerDeltaSync: async (): Promise<any> => {
    return await invoke("trigger_delta_sync");
  },

  // Memories
  getMemories: async (includeDeleted = false): Promise<MemoryItem[]> => {
    return await invoke("get_memories", { includeDeleted });
  },

  saveMemory: async (mem: Partial<MemoryItem>): Promise<void> => {
    return await invoke("save_memory", { mem });
  },

  deleteMemory: async (id: string): Promise<void> => {
    return await invoke("delete_memory", { id });
  },

  // Reminders
  getReminders: async (includeDeleted = false): Promise<ReminderItem[]> => {
    return await invoke("get_reminders", { includeDeleted });
  },

  saveReminder: async (rem: Partial<ReminderItem>): Promise<void> => {
    return await invoke("save_reminder", { rem });
  },

  completeReminder: async (id: string): Promise<void> => {
    return await invoke("complete_reminder", { id });
  },

  snoozeReminder: async (id: string): Promise<void> => {
    return await invoke("snooze_reminder", { id });
  },

  deleteReminder: async (id: string): Promise<void> => {
    return await invoke("delete_reminder", { id });
  },

  // Projects
  getProjects: async (includeDeleted = false): Promise<ProjectItem[]> => {
    return await invoke("get_projects", { includeDeleted });
  },

  saveProject: async (prj: Partial<ProjectItem>): Promise<void> => {
    return await invoke("save_project", { prj });
  },

  deleteProject: async (id: string): Promise<void> => {
    return await invoke("delete_project", { id });
  },

  // File Transfer
  startFileSend: async (peerIp: string, peerPort: number, filePath: string): Promise<any> => {
    return await invoke("start_file_send", {
      peerIp,
      peerPort,
      filePath,
    });
  },

  cancelFileTransfer: async (): Promise<void> => {
    return await invoke("cancel_file_transfer");
  },

  getTransferHistory: async (): Promise<TransferItem[]> => {
    return await invoke("get_transfer_history");
  },

  pickFileDialog: async (): Promise<string | null> => {
    return await invoke("pick_file_dialog");
  },

  pickFolderDialog: async (): Promise<string | null> => {
    return await invoke("pick_folder_dialog");
  },

  // Clipboard
  sendClipboardToPeer: async (peerIp: string, peerPort: number, text: string): Promise<void> => {
    return await invoke("send_clipboard_to_peer_cmd", {
      peerIp,
      peerPort,
      text,
    });
  },

  setLastClipboardHash: async (hash: string): Promise<void> => {
    return await invoke("set_last_clipboard_hash", { hash });
  },

  // System Monitor
  getSystemMetrics: async (): Promise<SystemMetrics> => {
    return await invoke("get_system_metrics");
  },

  // AI & Chat History
  getChatSessions: async (): Promise<string[]> => {
    return await invoke("get_chat_sessions");
  },

  getChatHistory: async (sessionId: string): Promise<ChatMessage[]> => {
    return await invoke("get_chat_history", { sessionId });
  },

  saveChatMessage: async (msg: Partial<ChatMessage>): Promise<void> => {
    return await invoke("save_chat_message", { msg });
  },

  deleteChatSession: async (sessionId: string): Promise<void> => {
    return await invoke("delete_chat_session", { sessionId });
  },
};
