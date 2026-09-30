#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod document;

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Instant,
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

struct Viewer {
    pending: Mutex<Option<PathBuf>>,
    started: Instant,
    measured: AtomicBool,
}

fn path_from_args(args: impl IntoIterator<Item = String>, cwd: Option<&str>) -> Option<PathBuf> {
    args.into_iter()
        .skip(1)
        .find(|arg| !arg.starts_with('-'))
        .map(|arg| {
            if let Ok(url) = url::Url::parse(&arg) {
                if let Ok(path) = url.to_file_path() {
                    return path;
                }
            }
            let path = PathBuf::from(arg);
            if path.is_relative() {
                cwd.map_or_else(|| path.clone(), |cwd| PathBuf::from(cwd).join(&path))
            } else {
                path
            }
        })
}

fn queue_file(app: &tauri::AppHandle, path: PathBuf) {
    let state = app.state::<Viewer>();
    *state.pending.lock().unwrap() = Some(path);
    let _ = app.emit("file-pending", ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

async fn load_document(app: tauri::AppHandle, path: PathBuf) -> Result<document::Document, String> {
    let document = tauri::async_runtime::spawn_blocking(move || document::load(&path))
        .await
        .map_err(|_| "No se pudo procesar el documento.".to_owned())??;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("{} · Markdown Viewer", document.name));
    }
    Ok(document)
}

#[tauri::command]
async fn take_pending_document(
    app: tauri::AppHandle,
) -> Result<Option<document::Document>, String> {
    let path = app.state::<Viewer>().pending.lock().unwrap().take();
    match path {
        Some(path) => load_document(app, path).await.map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
async fn open_document(app: tauri::AppHandle, path: String) -> Result<document::Document, String> {
    load_document(app, PathBuf::from(path)).await
}

#[tauri::command]
async fn choose_document(app: tauri::AppHandle) -> Result<Option<document::Document>, String> {
    let picker = app.clone();
    let selection = tauri::async_runtime::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .add_filter("Markdown", &["md", "markdown", "mdown", "mkd"])
            .blocking_pick_file()
    })
    .await
    .map_err(|_| "No se pudo abrir el selector de archivos.".to_owned())?;
    match selection {
        Some(path) => load_document(
            app,
            path.into_path()
                .map_err(|_| "Ruta de archivo inválida.".to_owned())?,
        )
        .await
        .map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
fn open_link(app: tauri::AppHandle, href: String) -> Result<(), String> {
    let url = url::Url::parse(&href).map_err(|_| "El enlace no es válido.".to_owned())?;
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        return Err("Solo se pueden abrir enlaces web o de correo.".to_owned());
    }
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|_| "No se pudo abrir el enlace.".to_owned())
}

#[tauri::command]
fn content_painted(app: tauri::AppHandle, state: State<'_, Viewer>, has_document: bool) -> f64 {
    let elapsed = state.started.elapsed().as_secs_f64() * 1000.0;
    if has_document && !state.measured.swap(true, Ordering::Relaxed) {
        if std::env::var_os("MD_VIEWER_BENCHMARK").is_some() {
            eprintln!("MD_VIEWER_PAINT_MS={elapsed:.2}");
        }
        if std::env::var_os("MD_VIEWER_BENCHMARK_EXIT").is_some() {
            app.exit(0);
        }
    }
    elapsed
}

fn main() {
    let started = Instant::now();
    let pending = path_from_args(std::env::args(), None);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(path) = path_from_args(args, Some(&cwd)) {
                queue_file(app, path);
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Viewer {
            pending: Mutex::new(pending),
            started,
            measured: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            take_pending_document,
            open_document,
            choose_document,
            open_link,
            content_painted
        ])
        .build(tauri::generate_context!())
        .expect("No se pudo iniciar Markdown Viewer")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        queue_file(_app, path);
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_open_events_relative_to_the_launching_directory() {
        let directory = std::env::current_dir().unwrap();
        let args = vec!["markdown-viewer".to_owned(), "lectura con ñ.md".to_owned()];
        assert_eq!(
            path_from_args(args, directory.to_str()),
            Some(directory.join("lectura con ñ.md"))
        );
        assert!(path_from_args(vec!["markdown-viewer".to_owned()], None).is_none());
    }

    #[test]
    fn accepts_file_urls_from_desktop_file_associations() {
        let path = std::env::current_dir().unwrap().join("lectura con ñ.md");
        let url = url::Url::from_file_path(&path).unwrap().to_string();
        assert_eq!(
            path_from_args(vec!["markdown-viewer".to_owned(), url], None),
            Some(path)
        );
    }
}
