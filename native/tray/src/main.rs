#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(not(target_os = "windows"))]
compile_error!("The Rust tray is Windows-only; macOS uses native/macos/TeamDevSpaceUI.swift");

use serde::Deserialize;
use std::io::{self, BufRead, Write};
use std::thread;
use tray_icon::{
    menu::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem, Submenu},
    Icon, TrayIcon, TrayIconBuilder,
};
use winit::{
    application::ApplicationHandler,
    event_loop::{ActiveEventLoop, EventLoop},
};

const ICON_SIZE: usize = 32;
const BASE_ICON: &[u8; ICON_SIZE * ICON_SIZE * 4] = include_bytes!("../assets/team-devspace-32.rgba");

#[cfg(target_os = "windows")]
struct InstanceGuard {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(target_os = "windows")]
impl InstanceGuard {
    fn acquire(instance_id: &str) -> io::Result<Option<Self>> {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError},
            System::Threading::CreateMutexW,
        };

        let name = format!("Local\\TeamDevSpace.Tray.{instance_id}\0").encode_utf16().collect::<Vec<_>>();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe { CloseHandle(handle) };
            return Ok(None);
        }
        Ok(Some(Self { handle }))
    }
}

#[cfg(target_os = "windows")]
impl Drop for InstanceGuard {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayState {
    status: String,
    summary: String,
    remote_text: String,
    remote_action: String,
    remote_enabled: bool,
    check_enabled: bool,
    switch_key_text: String,
    switch_key_enabled: bool,
    restart_enabled: bool,
    repair_enabled: bool,
    logs_enabled: bool,
    diagnostics_enabled: bool,
    diagnostics_text: String,
    exit_enabled: bool,
    #[serde(default)]
    activity: Option<String>,
    #[serde(default)]
    alert: Option<String>,
}

impl Default for TrayState {
    fn default() -> Self {
        Self {
            status: "stopped".into(),
            summary: "正在检查 Team DevSpace…".into(),
            remote_text: "暂停远程访问".into(),
            remote_action: "suspend".into(),
            remote_enabled: false,
            check_enabled: true,
            switch_key_text: "完成设置…".into(),
            switch_key_enabled: false,
            restart_enabled: false,
            repair_enabled: false,
            logs_enabled: true,
            diagnostics_enabled: true,
            diagnostics_text: "复制诊断信息".into(),
            exit_enabled: true,
            activity: None,
            alert: None,
        }
    }
}

#[derive(Debug)]
enum UserEvent {
    State(TrayState),
    Menu(MenuId),
    InputClosed,
}

struct Application {
    tray: Option<TrayIcon>,
    status: MenuItem,
    remote: MenuItem,
    check: MenuItem,
    switch_key: MenuItem,
    troubleshooting: Submenu,
    restart: MenuItem,
    repair: MenuItem,
    logs: MenuItem,
    diagnostics: MenuItem,
    exit: MenuItem,
    state: TrayState,
}

fn emit(event: &str, action: Option<&str>) {
    let value = match action {
        Some(action) => serde_json::json!({ "event": event, "action": action }),
        None => serde_json::json!({ "event": event }),
    };
    let mut stdout = io::stdout().lock();
    let _ = writeln!(stdout, "{value}");
    let _ = stdout.flush();
}

fn bounded_text(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_owned();
    }
    let mut text = value.chars().take(max_chars.saturating_sub(1)).collect::<String>();
    text.push('…');
    text
}

fn menu_status_text(state: &TrayState) -> String {
    bounded_text(state.activity.as_deref().unwrap_or(&state.summary), 36)
}

fn set_pixel(rgba: &mut [u8], x: i32, y: i32, rgb: [u8; 3]) {
    if x < 0 || y < 0 || x >= ICON_SIZE as i32 || y >= ICON_SIZE as i32 {
        return;
    }
    let offset = ((y as usize * ICON_SIZE) + x as usize) * 4;
    rgba[offset..offset + 3].copy_from_slice(&rgb);
    rgba[offset + 3] = 255;
}

fn draw_rect(rgba: &mut [u8], left: i32, top: i32, right: i32, bottom: i32, rgb: [u8; 3]) {
    for y in top..=bottom {
        for x in left..=right {
            set_pixel(rgba, x, y, rgb);
        }
    }
}

fn draw_line(rgba: &mut [u8], mut x0: i32, mut y0: i32, x1: i32, y1: i32, rgb: [u8; 3]) {
    let dx = (x1 - x0).abs();
    let sx = if x0 < x1 { 1 } else { -1 };
    let dy = -(y1 - y0).abs();
    let sy = if y0 < y1 { 1 } else { -1 };
    let mut err = dx + dy;
    loop {
        for oy in -1..=0 {
            for ox in -1..=0 {
                set_pixel(rgba, x0 + ox, y0 + oy, rgb);
            }
        }
        if x0 == x1 && y0 == y1 {
            break;
        }
        let e2 = 2 * err;
        if e2 >= dy { err += dy; x0 += sx; }
        if e2 <= dx { err += dx; y0 += sy; }
    }
}

fn draw_badge(rgba: &mut [u8], status: &str) {
    let fill = match status {
        "ready" => [41, 163, 92],
        "partial" => [230, 166, 35],
        "suspended" => [211, 64, 83],
        "busy" => [55, 125, 220],
        _ => [123, 132, 145],
    };
    let center = (25.0f32, 25.0f32);
    for y in 17..=31 {
        for x in 17..=31 {
            let dx = x as f32 - center.0;
            let dy = y as f32 - center.1;
            let distance = dx * dx + dy * dy;
            if distance <= 56.25 {
                set_pixel(rgba, x, y, [255, 255, 255]);
            }
            if distance <= 42.25 {
                set_pixel(rgba, x, y, fill);
            }
        }
    }
    let white = [255, 255, 255];
    match status {
        "ready" => {
            draw_line(rgba, 21, 25, 24, 28, white);
            draw_line(rgba, 24, 28, 29, 21, white);
        }
        "partial" => {
            draw_rect(rgba, 24, 20, 25, 25, white);
            draw_rect(rgba, 24, 28, 25, 29, white);
        }
        "suspended" => {
            draw_rect(rgba, 22, 21, 23, 28, white);
            draw_rect(rgba, 27, 21, 28, 28, white);
        }
        "busy" => {
            draw_rect(rgba, 21, 24, 22, 25, white);
            draw_rect(rgba, 24, 24, 25, 25, white);
            draw_rect(rgba, 27, 24, 28, 25, white);
        }
        _ => draw_rect(rgba, 21, 24, 29, 25, white),
    }
}

fn icon(status: &str) -> Icon {
    let mut rgba = BASE_ICON.to_vec();
    draw_badge(&mut rgba, status);
    Icon::from_rgba(rgba, ICON_SIZE as u32, ICON_SIZE as u32).expect("valid tray icon")
}

#[cfg(target_os = "windows")]
fn show_error_alert(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND};
    let title = "Team DevSpace\0".encode_utf16().collect::<Vec<_>>();
    let text = format!("{message}\0").encode_utf16().collect::<Vec<_>>();
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
    }
}

impl Application {
    fn new() -> Self {
        Self {
            tray: None,
            status: MenuItem::new("正在检查 Team DevSpace…", false, None),
            remote: MenuItem::new("暂停远程访问", false, None),
            check: MenuItem::new("检查连接", true, None),
            switch_key: MenuItem::new("更换 Access Key…", false, None),
            troubleshooting: Submenu::new("故障排查", true),
            restart: MenuItem::new("重启连接服务", false, None),
            repair: MenuItem::new("修复连接", false, None),
            logs: MenuItem::new("打开日志", true, None),
            diagnostics: MenuItem::new("复制诊断信息", true, None),
            exit: MenuItem::new("关闭并退出 Team DevSpace", true, None),
            state: TrayState::default(),
        }
    }

    fn build_tray(&self) -> TrayIcon {
        let troubleshooting_separator = PredefinedMenuItem::separator();
        self.troubleshooting.append_items(&[
            &self.restart,
            &self.repair,
            &troubleshooting_separator,
            &self.logs,
            &self.diagnostics,
        ]).expect("create troubleshooting submenu");

        let menu = Menu::new();
        let first_separator = PredefinedMenuItem::separator();
        let second_separator = PredefinedMenuItem::separator();
        let third_separator = PredefinedMenuItem::separator();
        menu.append_items(&[
            &self.status,
            &first_separator,
            &self.remote,
            &self.check,
            &self.switch_key,
            &second_separator,
            &self.troubleshooting,
            &third_separator,
            &self.exit,
        ]).expect("create tray menu");
        TrayIconBuilder::new()
            .with_menu(Box::new(menu))
            .with_tooltip("Team DevSpace")
            .with_icon(icon("stopped"))
            .build()
            .expect("create tray icon")
    }

    fn update(&mut self, mut state: TrayState) {
        let status_text = menu_status_text(&state);
        self.status.set_text(status_text.clone());
        self.remote.set_text(&state.remote_text);
        self.remote.set_enabled(state.remote_enabled);
        self.check.set_enabled(state.check_enabled);
        self.switch_key.set_text(&state.switch_key_text);
        self.switch_key.set_enabled(state.switch_key_enabled);
        self.restart.set_enabled(state.restart_enabled);
        self.repair.set_enabled(state.repair_enabled);
        self.logs.set_enabled(state.logs_enabled);
        self.diagnostics.set_enabled(state.diagnostics_enabled);
        self.diagnostics.set_text(&state.diagnostics_text);
        self.exit.set_enabled(state.exit_enabled);
        if let Some(tray) = &self.tray {
            let _ = tray.set_tooltip(Some(&status_text));
            let icon_state = if state.activity.is_some() { "busy" } else { &state.status };
            let _ = tray.set_icon(Some(icon(icon_state)));
        }
        let alert = state.alert.take();
        self.state = state;
        if let Some(message) = alert {
            show_error_alert(&bounded_text(&message, 220));
        }
    }

    fn action(&self, id: &MenuId) -> Option<String> {
        if id == self.remote.id() { Some(self.state.remote_action.clone())
        } else if id == self.check.id() { Some("check".into())
        } else if id == self.switch_key.id() { Some("switch-key".into())
        } else if id == self.restart.id() { Some("restart".into())
        } else if id == self.repair.id() { Some("repair".into())
        } else if id == self.logs.id() { Some("logs".into())
        } else if id == self.diagnostics.id() { Some("diagnostics".into())
        } else if id == self.exit.id() { Some("exit".into())
        } else { None }
    }
}

impl ApplicationHandler<UserEvent> for Application {
    fn resumed(&mut self, _event_loop: &ActiveEventLoop) {}

    fn window_event(&mut self, _event_loop: &ActiveEventLoop, _window_id: winit::window::WindowId,
                    _event: winit::event::WindowEvent) {}

    fn new_events(&mut self, _event_loop: &ActiveEventLoop, cause: winit::event::StartCause) {
        if cause == winit::event::StartCause::Init {
            self.tray = Some(self.build_tray());
            self.update(self.state.clone());
            emit("ready", None);
        }
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: UserEvent) {
        match event {
            UserEvent::State(state) => self.update(state),
            UserEvent::InputClosed => event_loop.exit(),
            UserEvent::Menu(id) => {
                if let Some(action) = self.action(&id) {
                    // A user gesture starts the desktop action in our Node controller.
                    // Delegate foreground permission before its short-lived helper opens UI.
                    #[cfg(target_os = "windows")]
                    if action == "switch-key" || action == "logs" {
                        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(u32::MAX) };
                    }
                    emit("menu", Some(&action));
                }
            }
        }
    }
}

fn valid_instance_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn main() {
    // The controller hashes the canonical private state directory. Key changes
    // and upgrades keep one owner; isolated acceptance cannot seize its lock.
    let instance_id = match std::env::var("TEAM_DEVSPACE_TRAY_INSTANCE_ID") {
        Ok(value) if valid_instance_id(&value) => value,
        _ => {
            eprintln!("Start the native tray through the Team DevSpace controller; its local instance identity is missing or invalid");
            std::process::exit(1);
        }
    };
    let _instance = match InstanceGuard::acquire(&instance_id) {
        Ok(Some(instance)) => instance,
        Ok(None) => {
            emit("duplicate", None);
            return;
        }
        Err(error) => {
            eprintln!("Team DevSpace tray single-instance guard failed: {error}");
            std::process::exit(1);
        }
    };
    let event_loop = EventLoop::<UserEvent>::with_user_event().build().expect("create event loop");
    let proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let _ = proxy.send_event(UserEvent::Menu(event.id));
    }));
    let proxy = event_loop.create_proxy();
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            match line.ok().and_then(|line| serde_json::from_str::<TrayState>(&line).ok()) {
                Some(state) => { let _ = proxy.send_event(UserEvent::State(state)); }
                None => emit("protocol-error", None),
            }
        }
        let _ = proxy.send_event(UserEvent::InputClosed);
    });
    let mut application = Application::new();
    if event_loop.run_app(&mut application).is_err() { std::process::exit(1); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_ids_are_fixed_hashes_not_arbitrary_lock_paths() {
        assert!(valid_instance_id(&"a0".repeat(32)));
        for invalid in ["", "../another.lock", "Local\\Other", &"g".repeat(64), &"a".repeat(63)] {
            assert!(!valid_instance_id(invalid));
        }
    }

    #[test]
    fn operation_activity_is_bounded_without_replacing_persistent_summary() {
        let state = TrayState {
            summary: "Team DevSpace 正常".into(),
            activity: Some("正在执行一个非常非常非常非常非常非常非常非常非常长的操作…".into()),
            ..TrayState::default()
        };
        let text = menu_status_text(&state);
        assert!(text.chars().count() <= 36);
        assert!(text.ends_with('…'));
        assert_eq!(state.summary, "Team DevSpace 正常");
    }

    #[test]
    fn branded_status_icon_keeps_valid_rgba_dimensions() {
        for status in ["ready", "partial", "suspended", "busy", "stopped"] {
            let _ = icon(status);
        }
    }
}
