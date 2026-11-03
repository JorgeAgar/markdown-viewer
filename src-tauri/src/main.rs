#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod document;
mod opening;

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::Instant,
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

struct Viewer {
    openings: Mutex<opening::Openings>,
    metrics: Mutex<Option<(String, Instant)>>,
    detailed: bool,
    frontend_ready_ms: OnceLock<f64>,
    started: Instant,
    measured: AtomicBool,
}

use opening::Opening;

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
    let opening = Opening::new(path, "os");
    let state = app.state::<Viewer>();
    let mut openings = state.openings.lock().unwrap();
    *state.metrics.lock().unwrap() = None;
    let prepared = openings.prepare(opening, state.started, state.detailed);
    openings.pending = Some(prepared);
    drop(openings);
    let _ = app.emit("file-pending", ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

async fn deliver_document(
    app: tauri::AppHandle,
    prepared: opening::Preparation,
) -> Result<Option<document::Document>, String> {
    let state = app.state::<Viewer>();
    let (id, origin, loaded) = prepared.finish().await;
    let mut openings = state.openings.lock().unwrap();
    // Check before propagating errors too: an obsolete failure is not a UI error.
    let Some(mut document) = openings.publish(&id, loaded)? else {
        return Ok(None);
    };
    if state.detailed {
        *state.metrics.lock().unwrap() = Some((id, origin));
    }
    if let Some(json) = document.opening_metrics.as_mut() {
        let mut timing: serde_json::Value = serde_json::from_str(json).unwrap();
        timing["main_to_frontend_ready_ms"] = serde_json::json!(state.frontend_ready_ms.get());
        timing["origin_to_response_ms"] = (origin.elapsed().as_secs_f64() * 1000.0).into();
        *json = timing.to_string();
    }
    Ok(Some(document))
}

async fn load_document(
    app: tauri::AppHandle,
    opening: Opening,
) -> Result<document::Document, String> {
    let prepared = {
        let state = app.state::<Viewer>();
        let mut openings = state.openings.lock().unwrap();
        // An explicit opening supersedes an unconsumed startup/OS result.
        openings.pending = None;
        *state.metrics.lock().unwrap() = None;
        openings.prepare(opening, state.started, state.detailed)
    };
    deliver_document(app, prepared)
        .await?
        .ok_or_else(|| "La apertura ya no está vigente.".to_owned())
}

// A single slot bounds memory and rejects late/duplicate acknowledgements.
fn finish_opening(slot: &mut Option<(String, Instant)>, id: &str) -> Option<Instant> {
    if slot.as_ref().is_some_and(|(current, _)| current == id) {
        slot.take().map(|(_, origin)| origin)
    } else {
        None
    }
}

#[tauri::command]
fn opening_painted(
    app: tauri::AppHandle,
    state: State<'_, Viewer>,
    document_id: String,
    frontend_metrics: String,
) {
    if !state.detailed {
        return;
    }
    if let Some(origin) = finish_opening(&mut state.metrics.lock().unwrap(), &document_id) {
        if let Ok(frontend) = serde_json::from_str::<serde_json::Value>(&frontend_metrics) {
            let ack_ms = origin.elapsed().as_secs_f64() * 1000.0;
            let overhead = frontend["backend"]["origin_to_response_ms"]
                .as_f64()
                .zip(frontend["receive_to_opportunity_ms"].as_f64())
                .map(|(response, frontend)| ack_ms - response - frontend);
            eprintln!(
                "MD_VIEWER_OPENING={}",
                serde_json::json!({
                    "opening_id": document_id,
                    "origin_to_ack_ms": ack_ms,
                    "response_and_ack_overhead_ms": overhead,
                    "frontend": frontend,
                })
            );
            if state.measured.load(Ordering::Relaxed)
                && std::env::var_os("MD_VIEWER_BENCHMARK_EXIT").is_some()
            {
                app.exit(0);
            }
        }
    }
}

#[tauri::command]
fn activate_document_images(state: State<'_, Viewer>, document_id: String) -> Result<(), String> {
    state.openings.lock().unwrap().images.activate(&document_id)
}

#[tauri::command]
fn close_document(state: State<'_, Viewer>, document_id: String) {
    state.openings.lock().unwrap().images.close(&document_id);
}

#[tauri::command]
fn set_document_title(app: tauri::AppHandle, name: Option<String>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let title = name.map_or_else(
            || "Markdown Viewer".to_owned(),
            |name| format!("{name} · Markdown Viewer"),
        );
        window
            .set_title(&title)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn resolve_document_image(
    app: tauri::AppHandle,
    document_id: String,
    image_id: usize,
) -> Result<String, String> {
    let images = app
        .state::<Viewer>()
        .openings
        .lock()
        .unwrap()
        .images
        .get(&document_id)?;
    tauri::async_runtime::spawn_blocking(move || images.resolve(image_id))
        .await
        .map_err(|_| "No se pudo procesar la imagen.".to_owned())?
}

#[tauri::command]
async fn take_pending_document(
    app: tauri::AppHandle,
) -> Result<Option<document::Document>, String> {
    let state = app.state::<Viewer>();
    state
        .frontend_ready_ms
        .get_or_init(|| state.started.elapsed().as_secs_f64() * 1000.0);
    let prepared = state.openings.lock().unwrap().pending.take();
    match prepared {
        Some(prepared) => deliver_document(app, prepared).await,
        None => Ok(None),
    }
}

#[tauri::command]
async fn open_document(app: tauri::AppHandle, path: String) -> Result<document::Document, String> {
    load_document(app, Opening::new(PathBuf::from(path), "drop")).await
}

#[tauri::command]
async fn choose_document(app: tauri::AppHandle) -> Result<Option<document::Document>, String> {
    let picker = app.clone();
    let selection = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = picker
            .dialog()
            .file()
            .set_title("Abrir Markdown")
            .add_filter("Markdown", &["md", "markdown", "mdown", "mkd"]);
        if let Some(window) = picker.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        dialog.blocking_pick_file()
    })
    .await
    .map_err(|_| "No se pudo abrir el selector de archivos.".to_owned())?;
    match selection {
        Some(path) => load_document(
            app,
            Opening::new(
                path.into_path()
                    .map_err(|_| "Ruta de archivo inválida.".to_owned())?,
                "picker",
            ),
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
        if std::env::var_os("MD_VIEWER_BENCHMARK_EXIT").is_some()
            && (!state.detailed || state.metrics.lock().unwrap().is_none())
        {
            app.exit(0);
        }
    }
    elapsed
}

fn main() {
    let started = Instant::now();
    let pending = path_from_args(std::env::args(), None).map(|path| Opening {
        path,
        origin: started,
        source: "initial",
    });
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(path) = path_from_args(args, Some(&cwd)) {
                queue_file(app, path);
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        // Plugin setup runs before configured windows are built. Single-instance
        // must stay first: secondary processes exit before any expensive work.
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("initial-document")
                .setup(move |app, _| {
                    if let Some(opening) = pending {
                        let state = app.state::<Viewer>();
                        let mut openings = state.openings.lock().unwrap();
                        // A single-instance callback may already have queued a newer path.
                        if openings.is_empty() {
                            let prepared = openings.prepare(opening, state.started, state.detailed);
                            openings.pending = Some(prepared);
                        }
                    }
                    Ok(())
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Viewer {
            openings: Mutex::new(opening::Openings::default()),
            metrics: Mutex::new(None),
            frontend_ready_ms: OnceLock::new(),
            detailed: std::env::var_os("MD_VIEWER_METRICS").is_some()
                || std::env::var_os("MD_VIEWER_BENCHMARK").is_some(),
            started,
            measured: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            take_pending_document,
            open_document,
            choose_document,
            activate_document_images,
            close_document,
            set_document_title,
            resolve_document_image,
            open_link,
            content_painted,
            opening_painted
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
    fn opening_acknowledgements_are_correlated_and_single_use() {
        let origin = Instant::now();
        let mut slot = Some(("second".to_owned(), origin));
        assert!(finish_opening(&mut slot, "first").is_none());
        assert_eq!(finish_opening(&mut slot, "second"), Some(origin));
        assert!(finish_opening(&mut slot, "second").is_none());
        assert!(slot.is_none());
    }

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
