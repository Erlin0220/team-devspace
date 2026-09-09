#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
compile_error!("Team DevSpace tray is intentionally built only for Windows and macOS");

use serde::Deserialize;
use std::io::{self, BufRead, Write};
use std::thread;
use tray_icon::{
    menu::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem},
    Icon, TrayIcon, TrayIconBuilder, TrayIconEvent,
};
use winit::{
    application::ApplicationHandler,
    event_loop::{ActiveEventLoop, EventLoop},
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayState {
    status: String,
    summary: String,
    remote_access: String,
    busy: bool,
    #[serde(default)]
    notice: Option<String>,
}

impl Default for TrayState {
    fn default() -> Self {
        Self {
            status: "stopped".into(),
            summary: "正在检查 Team DevSpace…".into(),
            remote_access: "unknown".into(),
            busy: false,
            notice: None,
        }
    }
}

#[derive(Debug)]
enum UserEvent {
    State(TrayState),
    Menu(MenuId),
    Inspect,
    InputClosed,
}

struct Application {
    tray: Option<TrayIcon>,
    status: MenuItem,
    remote: MenuItem,
    check: MenuItem,
    restart: MenuItem,
    logs: MenuItem,
    diagnostics: MenuItem,
    quit: MenuItem,
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

fn icon(status: &str) -> Icon {
    let rgb = match status {
        "ready" => [41, 163, 92],
        "partial" => [230, 166, 35],
        "suspended" => [211, 64, 83],
        _ => [123, 132, 145],
    };
    let size = 32usize;
    let mut rgba = vec![0u8; size * size * 4];
    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 - 15.5;
            let dy = y as f32 - 15.5;
            if dx * dx + dy * dy <= 12.5 * 12.5 {
                let offset = (y * size + x) * 4;
                rgba[offset..offset + 3].copy_from_slice(&rgb);
                rgba[offset + 3] = 255;
            }
        }
    }
    Icon::from_rgba(rgba, size as u32, size as u32).expect("valid tray icon")
}

impl Application {
    fn new() -> Self {
        Self {
            tray: None,
            status: MenuItem::new("正在检查 Team DevSpace…", false, None),
            remote: MenuItem::new("暂停远程访问", false, None),
            check: MenuItem::new("检查连接", true, None),
            restart: MenuItem::new("重启 Team DevSpace", true, None),
            logs: MenuItem::new("打开日志", true, None),
            diagnostics: MenuItem::new("复制诊断信息", true, None),
            quit: MenuItem::new("退出托盘", true, None),
            state: TrayState::default(),
        }
    }

    fn build_tray(&self) -> TrayIcon {
        let menu = Menu::new();
        menu.append_items(&[
            &self.status,
            &PredefinedMenuItem::separator(),
            &self.remote,
            &PredefinedMenuItem::separator(),
            &self.check,
            &self.restart,
            &PredefinedMenuItem::separator(),
            &self.logs,
            &self.diagnostics,
            &PredefinedMenuItem::separator(),
            &self.quit,
        ]).expect("create tray menu");
        TrayIconBuilder::new()
            .with_menu(Box::new(menu))
            .with_tooltip("Team DevSpace")
            .with_icon(icon("stopped"))
            .build()
            .expect("create tray icon")
    }

    fn update(&mut self, state: TrayState) {
        self.status.set_text(&state.summary);
        let suspended = state.remote_access == "suspended";
        self.remote.set_text(if suspended { "恢复远程访问" } else { "暂停远程访问" });
        self.remote.set_enabled(!state.busy && state.remote_access != "not-enrolled");
        self.check.set_enabled(!state.busy);
        self.restart.set_enabled(!state.busy && state.remote_access != "not-enrolled");
        if let Some(tray) = &self.tray {
            let tooltip = state.notice.as_deref().unwrap_or(&state.summary);
            let _ = tray.set_tooltip(Some(tooltip));
            let _ = tray.set_icon(Some(icon(&state.status)));
        }
        self.state = state;
    }

    fn action(&self, id: &MenuId) -> Option<&'static str> {
        if id == self.remote.id() {
            Some(if self.state.remote_access == "suspended" { "resume" } else { "suspend" })
        } else if id == self.check.id() { Some("check")
        } else if id == self.restart.id() { Some("restart")
        } else if id == self.logs.id() { Some("logs")
        } else if id == self.diagnostics.id() { Some("diagnostics")
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
            UserEvent::Inspect => emit("menu", Some("check")),
            UserEvent::InputClosed => event_loop.exit(),
            UserEvent::Menu(id) if id == *self.quit.id() => event_loop.exit(),
            UserEvent::Menu(id) => {
                if let Some(action) = self.action(&id) { emit("menu", Some(action)); }
            }
        }
    }
}

fn main() {
    let event_loop = EventLoop::<UserEvent>::with_user_event().build().expect("create event loop");
    let proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let _ = proxy.send_event(UserEvent::Menu(event.id));
    }));
    let proxy = event_loop.create_proxy();
    TrayIconEvent::set_event_handler(Some(move |_: TrayIconEvent| {
        let _ = proxy.send_event(UserEvent::Inspect);
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
