use serde::{Deserialize, Serialize};
use std::time::Instant;
use sysinfo::{Disks, Networks, System};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemMetrics {
    pub cpu_percent: f32,
    pub ram_used_mb: u64,
    pub ram_total_mb: u64,
    pub ram_percent: f32,
    pub disk_total_gb: u64,
    pub disk_free_gb: u64,
    pub disk_used_gb: u64,
    pub app_ram_mb: f64,
    pub tailscale_ip: Option<String>,
    pub is_tailscale_connected: bool,
    pub backend_online: bool,
    pub backend_latency_ms: u64,
    pub backend_details: Option<serde_json::Value>,
}

pub struct SysMonitor {
    sys: System,
    disks: Disks,
    networks: Networks,
}

impl SysMonitor {
    pub fn new() -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();
        let disks = Disks::new_with_refreshed_list();
        let networks = Networks::new_with_refreshed_list();

        Self {
            sys,
            disks,
            networks,
        }
    }

    pub async fn collect_metrics(&mut self, backend_url: &str) -> SystemMetrics {
        self.sys.refresh_cpu_all();
        self.sys.refresh_memory();
        self.disks.refresh(true);
        self.networks.refresh(true);

        let cpu_percent = self.sys.global_cpu_usage();

        let ram_used = self.sys.used_memory() / (1024 * 1024);
        let ram_total = self.sys.total_memory() / (1024 * 1024);
        let ram_percent = if ram_total > 0 {
            (ram_used as f32 / ram_total as f32) * 100.0
        } else {
            0.0
        };

        // Disks
        let mut disk_total: u64 = 0;
        let mut disk_free: u64 = 0;
        for disk in &self.disks {
            disk_total += disk.total_space();
            disk_free += disk.available_space();
        }
        let disk_total_gb = disk_total / (1024 * 1024 * 1024);
        let disk_free_gb = disk_free / (1024 * 1024 * 1024);
        let disk_used_gb = disk_total_gb.saturating_sub(disk_free_gb);

        // App Process RAM
        let pid = sysinfo::get_current_pid().ok();
        let mut app_ram_mb = 0.0;
        if let Some(p) = pid {
            if let Some(proc) = self.sys.process(p) {
                app_ram_mb = (proc.memory() as f64) / (1024.0 * 1024.0);
            }
        }

        // Tailscale IP detection
        let mut tailscale_ip: Option<String> = None;
        let mut is_tailscale_connected = false;

        // Check local adapters or execute `tailscale ip -4` if available, or scan network IP
        for (name, data) in &self.networks {
            let n = name.to_lowercase();
            if n.contains("tailscale") {
                is_tailscale_connected = true;
            }
            for ip in data.ip_networks() {
                let ip_str = ip.addr.to_string();
                if ip_str.starts_with("100.") {
                    tailscale_ip = Some(ip_str);
                    is_tailscale_connected = true;
                    break;
                }
            }
        }

        // Check backend ping and details
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(2500))
            .build()
            .unwrap_or_default();

        let health_url = format!("{}/api/health", backend_url.trim_end_matches('/'));
        let start = Instant::now();
        let mut backend_online = false;
        let mut backend_latency_ms: u64 = 0;
        let mut backend_details: Option<serde_json::Value> = None;

        if let Ok(resp) = client.get(&health_url).send().await {
            backend_latency_ms = start.elapsed().as_millis() as u64;
            if resp.status().is_success() {
                backend_online = true;
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    backend_details = Some(json);
                }
            }
        }

        SystemMetrics {
            cpu_percent,
            ram_used_mb: ram_used,
            ram_total_mb: ram_total,
            ram_percent,
            disk_total_gb,
            disk_free_gb,
            disk_used_gb,
            app_ram_mb,
            tailscale_ip,
            is_tailscale_connected,
            backend_online,
            backend_latency_ms,
            backend_details,
        }
    }
}
