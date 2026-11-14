export type ActiveView =
  | "dashboard"
  | "planner"
  | "ai"
  | "connect"
  | "file-transfer"
  | "clipboard"
  | "devices"
  | "memories"
  | "projects"
  | "reminders"
  | "system-monitor"
  | "settings";

export interface AppConfig {
  server_url: string;
  admin_token: string;
  device_token: string;
  device_id: string;
  device_name: string;
  p2p_port: number;
  download_dir: string;
  clipboard_sync_enabled: boolean;
  auto_start: boolean;
  minimize_to_tray: boolean;
  theme: "dark" | "light";
  language: "az" | "en";
  last_sync_time: number;
  last_server_rev: number;
  auto_sync_minutes: number;
  clipboard_auto_share: boolean;
  last_sync_status: string;
  last_sync_error: string;
  mesh_key: string;
  mesh_key_id: number;
  planner_day_start: string;
  planner_day_end: string;
}

export interface MemoryItem {
  id: string;
  user_id: string;
  category: string;
  fact_text: string;
  confidence: number;
  source: string;
  created_at: number;
  updated_at: number;
  deleted: number;
  sync_status: number; // 0=synced, 1=pending
}

export interface ReminderItem {
  id: string;
  user_id: string;
  text: string;
  due: number | null;
  snooze: number | null;
  done: number;
  timer: number;
  repeat: string | null;
  task_id?: string | null;
  event_id?: string | null;
  kind?: string;
  fired_at?: number | null;
  created_at: number;
  updated_at: number;
  deleted: number;
  sync_status: number;
}

export interface ProjectItem {
  id: string;
  user_id: string;
  title: string;
  status: string; // active, completed, on_hold
  notes: string;
  created_at: number;
  updated_at: number;
  deleted: number;
  sync_status: number;
}

export interface TransferItem {
  id: string;
  filename: string;
  file_size: number;
  direction: "send" | "receive";
  peer_device: string;
  status: "completed" | "failed" | "in_progress" | "canceled";
  speed_mbps: number;
  sha256: string;
  timestamp: number;
}

export interface DeviceItem {
  device_id: string;
  device_name: string;
  created_at: number;
  last_seen_at: number;
  is_revoked: number;
  platform?: string;
  app_version?: string;
  p2p_hosts?: string[];
  p2p_port?: number;
  last_sync_at?: number;
}

export type Priority = "low" | "medium" | "high" | "urgent";

interface Synced {
  id: string;
  created_at: number;
  updated_at: number;
  deleted: number;
  sync_status: number;
  server_rev?: number;
}

export interface TaskItem extends Synced {
  title: string;
  description: string;
  category: string;
  priority: Priority;
  deadline: number | null;
  estimated_minutes: number | null;
  status: "todo" | "in_progress" | "done" | "cancelled";
  project_id: string | null;
  completed_at: number | null;
  source: string;
}

export interface EventItem extends Synced {
  title: string;
  start_at: number;
  end_at: number | null;
  all_day: number;
  location: string;
  recurrence: string | null;
  notes: string;
  source: string;
  confirmed: number;
}

export interface PlanBlock extends Synced {
  task_id: string;
  start_at: number;
  end_at: number;
  status: "proposed" | "confirmed" | "done" | "skipped";
  locked: number;
  reason: string;
}

export interface ClipboardItem extends Synced {
  text: string;
  hash: string;
  origin_name: string;
  origin_device?: string;
}

export interface SyncStatus {
  configured: boolean;
  server_url: string;
  status: string;
  error: string;
  last_sync_time: number;
  pending: number;
  auto_sync_minutes: number;
  p2p_ready: boolean;
  device_id: string;
}

export interface SystemMetrics {
  cpu_percent: number;
  ram_used_mb: number;
  ram_total_mb: number;
  ram_percent: number;
  disk_total_gb: number;
  disk_free_gb: number;
  disk_used_gb: number;
  app_ram_mb: number;
  tailscale_ip: string | null;
  is_tailscale_connected: boolean;
  backend_online: boolean;
  backend_latency_ms: number;
  backend_details?: {
    status?: string;
    uptime_seconds?: number;
    cpu_percent?: number;
    ram_used_mb?: number;
    ram_total_mb?: number;
    db_size_bytes?: number;
    registered_devices?: number;
    total_memories?: number;
    active_reminders?: number;
  };
}

export interface ChatMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

export interface ToastMessage {
  id: string;
  type: "info" | "success" | "warning" | "error";
  text: string;
}
