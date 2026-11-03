//! Own the pending result, not a second copy of its path. Workers only own
//! inputs/results; publication and opening order are serialized by Viewer's mutex.
use crate::document::{self, Document, ImageStore, LoadedDocument};
use std::{path::PathBuf, time::Instant};

pub struct Opening {
    pub path: PathBuf,
    pub origin: Instant,
    pub source: &'static str,
}

impl Opening {
    pub fn new(path: PathBuf, source: &'static str) -> Self {
        Self {
            path,
            origin: Instant::now(),
            source,
        }
    }
}

pub struct Preparation {
    id: String,
    origin: Instant,
    worker: tauri::async_runtime::JoinHandle<Result<LoadedDocument, String>>,
}

impl Preparation {
    pub async fn finish(self) -> (String, Instant, Result<LoadedDocument, String>) {
        let loaded = self
            .worker
            .await
            .unwrap_or_else(|_| Err("No se pudo procesar el documento.".to_owned()));
        (self.id, self.origin, loaded)
    }
}

#[derive(Default)]
pub struct Openings {
    pub pending: Option<Preparation>,
    pub images: ImageStore,
    current: Option<String>,
}

impl Openings {
    pub fn is_empty(&self) -> bool {
        self.current.is_none()
    }

    pub fn prepare(&mut self, opening: Opening, started: Instant, detailed: bool) -> Preparation {
        self.prepare_using(opening, started, detailed, document::load)
    }

    fn prepare_using(
        &mut self,
        opening: Opening,
        started: Instant,
        detailed: bool,
        load: impl FnOnce(
                &std::path::Path,
                String,
                Option<serde_json::Value>,
            ) -> Result<LoadedDocument, String>
            + Send
            + 'static,
    ) -> Preparation {
        let id = self.images.begin();
        self.current = Some(id.clone());
        let timing = detailed.then(|| {
            serde_json::json!({
                "version": 1, "opening_id": id, "source": opening.source,
                "main_to_load_dispatch_ms": started.elapsed().as_secs_f64() * 1000.0,
                "origin_to_dispatch_ms": opening.origin.elapsed().as_secs_f64() * 1000.0,
            })
        });
        let worker_id = id.clone();
        let worker = tauri::async_runtime::spawn_blocking(move || {
            let mut timing = timing;
            if let Some(timing) = timing.as_mut() {
                timing["origin_to_worker_ms"] =
                    (opening.origin.elapsed().as_secs_f64() * 1000.0).into();
            }
            let mut loaded = load(&opening.path, worker_id, timing)?;
            if let Some(json) = loaded.document.opening_metrics.as_mut() {
                let mut timing: serde_json::Value = serde_json::from_str(json).unwrap();
                timing["origin_to_prepared_ms"] =
                    (opening.origin.elapsed().as_secs_f64() * 1000.0).into();
                *json = timing.to_string();
            }
            Ok(loaded)
        });
        Preparation {
            id,
            origin: opening.origin,
            worker,
        }
    }

    pub fn publish(
        &mut self,
        id: &str,
        loaded: Result<LoadedDocument, String>,
    ) -> Result<Option<Document>, String> {
        if self.current.as_deref() != Some(id) {
            return Ok(None);
        }
        loaded.map(|loaded| Some(self.images.publish(loaded)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::mpsc, time::Duration};
    use tempfile::tempdir;

    fn finish(state: &mut Openings, preparation: Preparation) -> Result<Option<Document>, String> {
        let (id, _, loaded) = tauri::async_runtime::block_on(preparation.finish());
        state.publish(&id, loaded)
    }

    #[test]
    fn startup_prepares_before_consumption_and_delivers_once_with_images_and_origin() {
        let mut state = Openings::default();
        assert!(state.is_empty());
        assert!(state.pending.take().is_none());
        let dir = tempdir().unwrap();
        let path = dir.path().join("initial.md");
        fs::write(
            &path,
            "# Ready\n\n![image](later.png)\n<script>bad()</script>",
        )
        .unwrap();
        let origin = Instant::now();
        let (done_tx, done_rx) = mpsc::channel();
        state.pending = Some(state.prepare_using(
            Opening {
                path: path.clone(),
                origin,
                source: "initial",
            },
            origin,
            true,
            move |path, id, timing| {
                let result = document::load(path, id, timing);
                done_tx.send(()).unwrap();
                result
            },
        ));
        // No frontend request yet; conversion has already read the original file.
        done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        fs::write(path, "changed after preparation").unwrap();
        let preparation = state.pending.take().unwrap();
        let (id, returned_origin, loaded) = tauri::async_runtime::block_on(preparation.finish());
        assert_eq!(returned_origin, origin);
        let doc = state.publish(&id, loaded).unwrap().unwrap();
        assert!(doc.html.contains("<h1>Ready</h1>"));
        assert!(!doc.html.contains("<script>"));
        assert!(state.pending.take().is_none());
        let metrics: serde_json::Value =
            serde_json::from_str(&doc.opening_metrics.unwrap()).unwrap();
        assert_eq!(metrics["source"], "initial");
        assert_eq!(metrics["opening_id"], id);
        assert!(
            metrics["origin_to_prepared_ms"].as_f64().unwrap()
                >= metrics["origin_to_worker_ms"].as_f64().unwrap()
        );
        fs::write(dir.path().join("later.png"), b"image").unwrap();
        state.images.activate(&id).unwrap();
        assert!(state
            .images
            .get(&id)
            .unwrap()
            .resolve(0)
            .unwrap()
            .starts_with("data:image/png"));
    }

    #[test]
    fn latest_os_opening_wins_without_waiting_for_slow_initial_success_or_failure() {
        for fail in [false, true] {
            let dir = tempdir().unwrap();
            let path = dir.path().join("reading.md");
            fs::write(&path, "# Latest").unwrap();
            let mut state = Openings::default();
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let initial = state.prepare_using(
                Opening::new(path.clone(), "initial"),
                Instant::now(),
                false,
                move |path, id, timing| {
                    entered_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                    if fail {
                        Err("obsolete error".into())
                    } else {
                        document::load(path, id, timing)
                    }
                },
            );
            entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let second = state.prepare(Opening::new(path.clone(), "os"), Instant::now(), false);
            state.pending = Some(second);
            // Multiple OS events before frontend readiness retain only the latest.
            let latest = state.prepare(Opening::new(path, "os"), Instant::now(), false);
            state.pending = Some(latest);
            let pending = state.pending.take().unwrap();
            let doc = finish(&mut state, pending).unwrap().unwrap();
            assert!(doc.html.contains("<h1>Latest</h1>"));
            assert!(doc.opening_metrics.is_none());
            state.images.activate(&doc.id).unwrap();
            release_tx.send(()).unwrap();
            assert!(finish(&mut state, initial).unwrap().is_none());
            assert!(state.images.get(&doc.id).is_ok());
        }
    }

    #[test]
    fn explicit_open_replaces_unconsumed_initial_result_and_repeated_path_has_new_identity() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("same.md");
        fs::write(&path, "# Same path").unwrap();
        let mut state = Openings::default();
        let missing = state.prepare(
            Opening::new(dir.path().join("missing.md"), "initial"),
            Instant::now(),
            false,
        );
        assert!(finish(&mut state, missing).is_err());
        state.pending =
            Some(state.prepare(Opening::new(path.clone(), "initial"), Instant::now(), false));
        let obsolete = state.pending.take().unwrap();
        let old_id = obsolete.id.clone();
        for source in ["drop", "picker"] {
            let replacement =
                state.prepare(Opening::new(path.clone(), source), Instant::now(), false);
            let doc = finish(&mut state, replacement).unwrap().unwrap();
            assert_ne!(doc.id, old_id);
            state.images.activate(&doc.id).unwrap();
        }
        assert!(finish(&mut state, obsolete).unwrap().is_none());
        assert!(state.images.activate(&old_id).is_err());
    }

    #[test]
    fn current_errors_are_delivered_but_cannot_revoke_visible_images() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("reading.md");
        fs::write(&path, "# Visible").unwrap();
        let mut state = Openings::default();
        let visible = state.prepare(Opening::new(path, "initial"), Instant::now(), false);
        let doc = finish(&mut state, visible).unwrap().unwrap();
        state.images.activate(&doc.id).unwrap();
        for source in ["drop", "picker", "os"] {
            let failed = state.prepare(
                Opening::new(dir.path().join("missing.md"), source),
                Instant::now(),
                false,
            );
            assert!(finish(&mut state, failed).is_err());
            assert!(state.images.get(&doc.id).is_ok());
        }
    }
}
