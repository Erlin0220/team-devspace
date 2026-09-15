#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(not(target_os = "windows"))]
compile_error!("The Rust tray is Windows-only; macOS uses native/macos/TeamDevSpaceUI.swift");

use serde::Deserialize;
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::thread;
use tray_icon::{menu::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem, Submenu}, Icon, TrayIcon, TrayIconBuilder};
use winit::{application::ApplicationHandler, event_loop::{ActiveEventLoop, EventLoop}};

const ICON_SIZE: usize = 32;
const BASE_ICON: &[u8; ICON_SIZE * ICON_SIZE * 4] = include_bytes!("../assets/team-devspace-32.rgba");

struct InstanceGuard { handle: windows_sys::Win32::Foundation::HANDLE }
impl InstanceGuard {
    fn acquire(instance_id: &str) -> io::Result<Option<Self>> {
        use windows_sys::Win32::{Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError}, System::Threading::CreateMutexW};
        let name = format!("Local\\TeamDevSpace.Tray.{instance_id}\0").encode_utf16().collect::<Vec<_>>();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() { return Err(io::Error::last_os_error()); }
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe { CloseHandle(handle) }; return Ok(None);
        }
        Ok(Some(Self { handle }))
    }
}
impl Drop for InstanceGuard {
    fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) }; }
}

#[derive(Clone, Debug, Deserialize)]
struct MenuEntry {
    id: String, text: String, enabled: bool,
    #[serde(default)] action: String,
    #[serde(default)] separator: bool,
    #[serde(default)] children: Vec<MenuEntry>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayState {
    status: String, icon_status: String, tooltip: String, menu: Vec<MenuEntry>,
}
impl TrayState {
    fn entries(&self) -> impl Iterator<Item = &MenuEntry> {
        self.menu.iter().flat_map(|item| std::iter::once(item).chain(item.children.iter()))
    }
    fn valid(&self) -> bool {
        let mut ids = std::collections::HashSet::new();
        ["ready", "partial", "suspended", "busy", "stopped"].contains(&self.status.as_str())
            && ["ready", "partial", "suspended", "busy", "stopped"].contains(&self.icon_status.as_str())
            && !self.menu.is_empty() && self.menu.len() <= 20
            && self.entries().count() <= 32
            && self.menu.iter().all(|item| item.children.is_empty() || (!item.separator && item.action.is_empty()
                && item.children.iter().all(|child| child.children.is_empty())))
            && self.entries().all(|item| !item.id.is_empty() && item.id.len() <= 64 && ids.insert(&item.id))
    }
}
#[derive(Debug)]
enum UserEvent { State(TrayState), Menu(MenuId), Exercise(String), InputClosed }
struct Application {
    tray: Option<TrayIcon>, items: HashMap<String, MenuItem>, submenus: HashMap<String, Submenu>, layout: Vec<String>,
    state: Option<TrayState>, last_icon: String, smoke: bool,
}
fn emit(event: &str, fields: serde_json::Value) {
    let mut value = fields;
    value["event"] = event.into();
    let mut stdout = io::stdout().lock();
    let _ = writeln!(stdout, "{value}"); let _ = stdout.flush();
}
fn bounded_text(value: &str, max: usize) -> String {
    if value.chars().count() <= max { return value.to_owned(); }
    format!("{}…", value.chars().take(max.saturating_sub(1)).collect::<String>())
}
fn set_pixel(rgba: &mut [u8], x: i32, y: i32, rgb: [u8; 3]) {
    if x < 0 || y < 0 || x >= ICON_SIZE as i32 || y >= ICON_SIZE as i32 { return; }
    let offset = ((y as usize * ICON_SIZE) + x as usize) * 4;
    rgba[offset..offset + 3].copy_from_slice(&rgb); rgba[offset + 3] = 255;
}
fn draw_rect(rgba: &mut [u8], left: i32, top: i32, right: i32, bottom: i32, rgb: [u8; 3]) {
    for y in top..=bottom { for x in left..=right { set_pixel(rgba, x, y, rgb); } }
}
fn draw_line(rgba: &mut [u8], mut x0: i32, mut y0: i32, x1: i32, y1: i32, rgb: [u8; 3]) {
    let dx = (x1 - x0).abs(); let sx = if x0 < x1 { 1 } else { -1 };
    let dy = -(y1 - y0).abs(); let sy = if y0 < y1 { 1 } else { -1 }; let mut err = dx + dy;
    loop {
        for oy in -1..=0 { for ox in -1..=0 { set_pixel(rgba, x0 + ox, y0 + oy, rgb); } }
        if x0 == x1 && y0 == y1 { break; }
        let e2 = 2 * err;
        if e2 >= dy { err += dy; x0 += sx; }
        if e2 <= dx { err += dx; y0 += sy; }
    }
}
fn draw_badge(rgba: &mut [u8], status: &str) {
    let fill = match status {
        "ready" => [41, 163, 92], "partial" => [230, 166, 35], "suspended" => [211, 64, 83],
        "busy" => [55, 125, 220], _ => [123, 132, 145],
    };
    for y in 17..=31 { for x in 17..=31 {
        let dx = x as f32 - 25.0; let dy = y as f32 - 25.0; let distance = dx * dx + dy * dy;
        if distance <= 56.25 { set_pixel(rgba, x, y, [255, 255, 255]); }
        if distance <= 42.25 { set_pixel(rgba, x, y, fill); }
    } }
    let white = [255, 255, 255];
    match status {
        "ready" => { draw_line(rgba, 21, 25, 24, 28, white); draw_line(rgba, 24, 28, 29, 21, white); }
        "partial" => { draw_rect(rgba, 24, 20, 25, 25, white); draw_rect(rgba, 24, 28, 25, 29, white); }
        "suspended" => { draw_rect(rgba, 22, 21, 23, 28, white); draw_rect(rgba, 27, 21, 28, 28, white); }
        "busy" => { draw_rect(rgba, 21, 24, 22, 25, white); draw_rect(rgba, 24, 24, 25, 25, white); draw_rect(rgba, 27, 24, 28, 25, white); }
        _ => draw_rect(rgba, 21, 24, 29, 25, white),
    }
}
fn icon(status: &str) -> Icon {
    let mut rgba = BASE_ICON.to_vec(); draw_badge(&mut rgba, status);
    Icon::from_rgba(rgba, ICON_SIZE as u32, ICON_SIZE as u32).expect("valid tray icon")
}
impl Application {
    fn update(&mut self, state: TrayState) {
        let layout = state.entries().map(|item| format!("{}:{}:{}", item.id, item.separator, item.children.len())).collect::<Vec<_>>();
        if layout != self.layout {
            let menu = Menu::new();
            let mut items = HashMap::new();
            let mut submenus = HashMap::new();
            let mut failed = false;
            for entry in &state.menu {
                if entry.separator {
                    failed |= menu.append(&PredefinedMenuItem::separator()).is_err();
                } else if !entry.children.is_empty() {
                    let submenu = Submenu::new(bounded_text(&entry.text, 64), entry.enabled);
                    for child in &entry.children {
                        if child.separator { failed |= submenu.append(&PredefinedMenuItem::separator()).is_err(); }
                        else {
                            let item = MenuItem::new(bounded_text(&child.text, 64), child.enabled, None);
                            if submenu.append(&item).is_err() { failed = true; }
                            else { items.insert(child.id.clone(), item); }
                        }
                    }
                    if menu.append(&submenu).is_err() { failed = true; }
                    else { submenus.insert(entry.id.clone(), submenu); }
                } else {
                    let item = MenuItem::new(bounded_text(&entry.text, 64), entry.enabled, None);
                    if menu.append(&item).is_err() { failed = true; }
                    else { items.insert(entry.id.clone(), item); }
                }
            }
            if failed {
                eprintln!("Team DevSpace tray menu update failed; retaining the previous menu");
            } else if let Some(tray) = &self.tray {
                tray.set_menu(Some(Box::new(menu)));
                self.items = items; self.submenus = submenus; self.layout = layout;
            } else {
                eprintln!("Team DevSpace tray menu is not ready; retaining the previous menu");
            }
        }
        for entry in state.entries() {
            if let Some(item) = self.items.get(&entry.id) { item.set_text(bounded_text(&entry.text, 64)); item.set_enabled(entry.enabled); }
            if let Some(item) = self.submenus.get(&entry.id) { item.set_text(bounded_text(&entry.text, 64)); item.set_enabled(entry.enabled); }
        }
        if let Some(tray) = &self.tray {
            let _ = tray.set_tooltip(Some(bounded_text(&state.tooltip, 110)));
            if self.last_icon != state.icon_status {
                let _ = tray.set_icon(Some(icon(&state.icon_status))); self.last_icon = state.icon_status.clone();
            }
        }
        if self.smoke { emit("state-applied", serde_json::json!({"status": state.status})); }
        self.state = Some(state);
    }
    fn activate(&self, id: &MenuId) {
        if let Some(state) = &self.state {
            if let Some(entry) = state.menu.iter().filter(|entry| entry.enabled)
                .flat_map(|entry| std::iter::once(entry).chain(entry.children.iter()))
                .find(|entry| entry.enabled && !entry.action.is_empty()
                && self.items.get(&entry.id).is_some_and(|item| item.id() == id)) {
                if ["settings", "troubleshoot", "about", "updates", "logs"].contains(&entry.action.as_str()) {
                    unsafe { windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(u32::MAX) };
                }
                emit("menu", serde_json::json!({"action": entry.action}));
            }
        }
    }
}
impl ApplicationHandler<UserEvent> for Application {
    fn resumed(&mut self, _event_loop: &ActiveEventLoop) {}
    fn window_event(&mut self, _event_loop: &ActiveEventLoop, _window_id: winit::window::WindowId, _event: winit::event::WindowEvent) {}
    fn new_events(&mut self, _event_loop: &ActiveEventLoop, cause: winit::event::StartCause) {
        if cause == winit::event::StartCause::Init {
            self.tray = Some(TrayIconBuilder::new().with_tooltip("Team DevSpace · 正在启动…")
                .with_icon(icon("stopped")).build().expect("create tray icon"));
            emit("ready", serde_json::json!({})); emit("tray-visible", serde_json::json!({}));
        }
    }
    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: UserEvent) {
        match event {
            UserEvent::State(state) => self.update(state),
            UserEvent::InputClosed => event_loop.exit(),
            UserEvent::Menu(id) => self.activate(&id),
            UserEvent::Exercise(key) => { if let Some(item) = self.items.get(&key) { self.activate(item.id()); } }
        }
    }
}
fn valid_instance_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn main() {
    let identity = match std::env::var("TEAM_DEVSPACE_TRAY_INSTANCE_ID") {
        Ok(value) if valid_instance_id(&value) => value,
        _ => { eprintln!("Start the native tray through the Team DevSpace controller; its local instance identity is missing or invalid"); std::process::exit(1); }
    };
    let _instance = match InstanceGuard::acquire(&identity) {
        Ok(Some(instance)) => instance,
        Ok(None) => { emit("duplicate", serde_json::json!({})); return; }
        Err(error) => { eprintln!("Team DevSpace tray single-instance guard failed: {error}"); std::process::exit(1); }
    };
    let smoke = std::env::args().any(|arg| arg == "--smoke");
    let event_loop = EventLoop::<UserEvent>::with_user_event().build().expect("create event loop");
    let proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| { let _ = proxy.send_event(UserEvent::Menu(event.id)); }));
    let proxy = event_loop.create_proxy();
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let event = line.ok().filter(|line| line.len() <= 65536)
                .and_then(|line| serde_json::from_str::<serde_json::Value>(&line).ok())
                .and_then(|value| {
                    if smoke { if let Some(key) = value.get("exerciseMenu").and_then(|value| value.as_str()) { return Some(UserEvent::Exercise(key.to_owned())); } }
                    serde_json::from_value::<TrayState>(value).ok().filter(TrayState::valid).map(UserEvent::State)
                });
            match event { Some(event) => { let _ = proxy.send_event(event); }, None => emit("protocol-error", serde_json::json!({})) }
        }
        let _ = proxy.send_event(UserEvent::InputClosed);
    });
    let mut application = Application { tray: None, items: HashMap::new(), submenus: HashMap::new(), layout: vec![], state: None, last_icon: String::new(), smoke };
    if event_loop.run_app(&mut application).is_err() { std::process::exit(1); }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn instance_ids_are_fixed_hashes() {
        assert!(valid_instance_id(&"a0".repeat(32)));
        for invalid in ["", "../another.lock", &"g".repeat(64), &"a".repeat(63)] { assert!(!valid_instance_id(invalid)); }
    }
    #[test] fn native_text_and_icons_are_bounded() {
        assert!(bounded_text(&"长".repeat(200), 64).chars().count() <= 64);
        for state in ["ready", "partial", "suspended", "busy", "stopped"] { let _ = icon(state); }
    }
}
