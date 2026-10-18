use std::{
    collections::HashSet,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use base64::{engine::general_purpose::STANDARD, Engine};
use pulldown_cmark::{html, CowStr, Event, Options, Parser, Tag};
use serde::Serialize;
use url::Url;

const MAX_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Serialize)]
pub struct Document {
    pub id: String,
    pub path: String,
    pub name: String,
    pub html: String,
    pub bytes: usize,
}

pub struct LoadedDocument {
    pub document: Document,
    pub images: LocalImages,
}

pub struct LocalImages {
    id: String,
    directory: PathBuf,
    sources: Vec<String>,
    active: AtomicBool,
    // Serializing reads keeps the budget exact, including concurrent requests.
    budget: Mutex<(usize, HashSet<usize>)>,
}

impl LocalImages {
    pub fn resolve(&self, image_id: usize) -> Result<String, String> {
        let mut budget = self.budget.lock().unwrap();
        if !self.active.load(Ordering::Relaxed) {
            return Err("La apertura ya no está activa.".to_owned());
        }
        let source = self
            .sources
            .get(image_id)
            .ok_or("La imagen no pertenece al documento.")?;
        if !budget.1.insert(image_id) {
            return Err("La imagen ya se solicitó.".to_owned());
        }
        image_source(source, &self.directory, &mut budget.0)
            .ok_or("No se pudo cargar la imagen.".to_owned())
    }
}

#[derive(Default)]
pub struct ImageStore {
    latest: u64,
    current: Option<Arc<LocalImages>>,
    pending: Option<LocalImages>,
}

impl ImageStore {
    pub fn begin(&mut self) -> String {
        self.latest += 1;
        self.latest.to_string()
    }

    pub fn publish(&mut self, loaded: LoadedDocument) -> Document {
        if loaded.document.id == self.latest.to_string() {
            self.pending = Some(loaded.images);
        }
        loaded.document
    }

    pub fn activate(&mut self, document_id: &str) -> Result<(), String> {
        if self
            .current
            .as_ref()
            .is_some_and(|images| images.id == document_id)
        {
            return Ok(());
        }
        if !self
            .pending
            .as_ref()
            .is_some_and(|images| images.id == document_id)
        {
            return Err("La apertura ya no está disponible.".to_owned());
        }
        if let Some(previous) = self.current.take() {
            previous.active.store(false, Ordering::Relaxed);
        }
        self.current = self.pending.take().map(Arc::new);
        Ok(())
    }

    pub fn get(&self, document_id: &str) -> Result<Arc<LocalImages>, String> {
        self.current
            .as_ref()
            .filter(|images| images.id == document_id)
            .cloned()
            .ok_or("La apertura ya no está activa.".to_owned())
    }
}

pub fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "md" | "markdown" | "mdown" | "mkd"
            )
        })
}

fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|_| {
        "No se pudo abrir el archivo. Comprueba que exista y tengas permiso para leerlo.".to_owned()
    })?;
    let metadata = file
        .metadata()
        .map_err(|_| "No se pudo leer el archivo.".to_owned())?;
    if !metadata.is_file() {
        return Err("Selecciona un archivo, no una carpeta.".to_owned());
    }
    if metadata.len() > limit {
        return Err("El archivo supera el tamaño admitido por este prototipo.".to_owned());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "No se pudo leer el archivo.".to_owned())?;
    if bytes.len() as u64 > limit {
        return Err("El archivo supera el tamaño admitido por este prototipo.".to_owned());
    }
    Ok(bytes)
}

fn image_source(source: &str, directory: &Path, remaining: &mut usize) -> Option<String> {
    if let Ok(url) = Url::parse(source) {
        return (url.scheme() == "https").then(|| url.to_string());
    }
    if source.starts_with(['/', '\\']) {
        return None;
    }
    // The directory was canonicalized when the Markdown was opened. Keep that
    // boundary even if a directory is later replaced by a symlink.
    // URL joining decodes spaces and UTF-8 in Markdown image paths. Canonicalization
    // also prevents symlinks and ../ from escaping the document's directory.
    let base = Url::from_directory_path(directory).ok()?;
    let path = base.join(source).ok()?.to_file_path().ok()?;
    let path = path.canonicalize().ok()?;
    if !path.starts_with(directory) {
        return None;
    }
    let mime = match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        _ => return None,
    };
    let bytes = read_limited(&path, MAX_IMAGE_BYTES.min(*remaining as u64)).ok()?;
    *remaining -= bytes.len();
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

fn relative_url(url: &str) -> Option<std::borrow::Cow<'_, str>> {
    url.starts_with('#')
        .then_some(std::borrow::Cow::Borrowed(url))
}

fn render(markdown: &str, document_id: &str) -> (String, Vec<String>) {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_MATH;
    let mut sources = Vec::new();
    let parser = Parser::new_ext(markdown, options).map(|event| match event {
        Event::Start(Tag::Image {
            link_type,
            dest_url,
            title,
            id,
        }) => {
            // This phase never touches image files, including their metadata.
            let source = if let Ok(url) = Url::parse(&dest_url) {
                if url.scheme() == "https" {
                    url.to_string()
                } else {
                    String::new()
                }
            } else if dest_url.starts_with(['/', '\\']) {
                String::new()
            } else {
                let marker = format!("#local-image-{document_id}-{}", sources.len());
                sources.push(dest_url.into_string());
                marker
            };
            Event::Start(Tag::Image {
                link_type,
                dest_url: CowStr::from(source),
                title,
                id,
            })
        }
        event => event,
    });
    let mut output = String::with_capacity(markdown.len());
    html::push_html(&mut output, parser);
    let html = ammonia::Builder::default()
        .add_tags(&["input"])
        .add_tag_attributes("input", &["type", "checked", "disabled"])
        .add_tag_attributes("th", &["align"])
        .add_tag_attributes("td", &["align"])
        // Keep these names/aliases in sync with src/syntax-languages.ts.
        .add_allowed_classes(
            "code",
            &[
                "language-mermaid",
                "language-javascript",
                "language-js",
                "language-jsx",
                "language-typescript",
                "language-ts",
                "language-tsx",
                "language-python",
                "language-py",
                "language-rust",
                "language-rs",
                "language-bash",
                "language-sh",
                "language-shell",
                "language-json",
                "language-yaml",
                "language-yml",
                "language-toml",
                "language-ini",
                "language-css",
                "language-html",
                "language-xml",
                "language-svg",
                "language-sql",
                "language-c",
                "language-cpp",
                "language-c++",
                "language-go",
                "language-java",
                "language-csharp",
                "language-cs",
                "language-diff",
                "language-markdown",
                "language-md",
                "language-dockerfile",
            ],
        )
        .add_allowed_classes("span", &["math", "math-inline", "math-display"])
        .add_generic_attributes(&["id"])
        .url_schemes(["https", "http", "mailto", "data"].into_iter().collect())
        .url_relative(ammonia::UrlRelative::Custom(Box::new(relative_url)))
        .clean(&output)
        .to_string();
    (html, sources)
}

pub fn load(path: &Path, id: String) -> Result<LoadedDocument, String> {
    if !is_markdown(path) {
        return Err("Selecciona un archivo .md, .markdown, .mdown o .mkd.".to_owned());
    }
    let path = path
        .canonicalize()
        .map_err(|_| "No se encontró el archivo.".to_owned())?;
    let bytes = read_limited(&path, MAX_DOCUMENT_BYTES)?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| "El archivo debe estar guardado con codificación UTF-8.".to_owned())?;
    let (html, sources) = render(text.trim_start_matches('\u{feff}'), &id);
    let images = LocalImages {
        id: id.clone(),
        directory: path.parent().unwrap_or(Path::new(".")).to_owned(),
        sources,
        active: AtomicBool::new(true),
        budget: Mutex::new((MAX_TOTAL_IMAGE_BYTES, HashSet::new())),
    };
    Ok(LoadedDocument {
        document: Document {
            id,
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            path: path.to_string_lossy().into_owned(),
            html,
            bytes: bytes.len(),
        },
        images,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn render(markdown: &str, _directory: &Path) -> String {
        super::render(markdown, "1").0
    }

    fn load(path: &Path) -> Result<Document, String> {
        super::load(path, "1".to_owned()).map(|loaded| loaded.document)
    }

    fn image_source(source: &str, directory: &Path, remaining: &mut usize) -> Option<String> {
        super::image_source(source, &directory.canonicalize().ok()?, remaining)
    }

    #[test]
    fn renders_github_markdown_and_removes_active_html() {
        let html = render("# Hola\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] Listo\n\n~~antes~~\n\n<script>alert(1)</script>\n\n<img src='https://example.com/a.png' onerror='alert(1)'>\n\n[mal](javascript:alert%281%29)", Path::new("/"));
        assert!(html.contains("<h1>Hola</h1>"));
        assert!(html.contains("<table>"));
        assert!(html.contains("checked"));
        assert!(html.contains("disabled"));
        assert!(html.contains("<del>antes</del>"));
        assert!(!html.contains("<script"));
        assert!(!html.contains("onerror"));
        assert!(!html.contains("javascript:"));
    }

    #[test]
    fn preserves_math_markers_and_escapes_formula_source() {
        let html = render(
            "En línea $a < b \\land c > d$ y $\\frac{1}{2}$.\n\n$$\n\\begin{pmatrix}1 & 2 \\\\ 3 & 4\\end{pmatrix}\n$$",
            Path::new("/"),
        );
        assert_eq!(html.matches("math-inline").count(), 2);
        assert_eq!(html.matches("math-display").count(), 1);
        assert!(html.contains("a &lt; b \\land c &gt; d"));
        assert!(html.contains("1 &amp; 2"));
        assert!(!html.contains("katex"));
    }

    #[test]
    fn math_respects_code_escaped_dollars_and_prices() {
        let html = render(
            "`$x$`\n\n```latex\n$$y$$\n```\n\n```mermaid\nflowchart LR\nA[\"$z$\"]-->B\n```\n\nCuesta \\$5 y \\$10.\n\nPrecio $5.00 y total $10.00.\n\nDólar sin pareja: $20.",
            Path::new("/"),
        );
        assert!(!html.contains("math-inline"));
        assert!(!html.contains("math-display"));
        assert!(html.contains("<code>$x$</code>"));
        assert!(html.contains("$$y$$"));
        assert!(html.contains("$z$"));
        assert!(html.contains("Cuesta $5 y $10."));
    }

    #[test]
    fn only_math_marker_classes_survive_on_spans() {
        let html = render(
            "<span class=\"math math-inline katex arbitrary\" style=\"color:red\" onclick=\"alert(1)\">&lt;script&gt;</span>",
            Path::new("/"),
        );
        assert!(html.contains("class=\"math math-inline\""));
        assert!(html.contains("&lt;script&gt;"));
        assert!(!html.contains("katex"));
        assert!(!html.contains("arbitrary"));
        assert!(!html.contains("style="));
        assert!(!html.contains("onclick="));
    }

    #[test]
    fn preserves_mermaid_language_and_escaped_source() {
        let html = render(
            "```mermaid\nflowchart LR\n  A[\"Café < & >\"] --> B\n```\n\n```rust\nlet n = 1;\n```\n\n```mermaid extra\nsequenceDiagram\n  A->>B: Hola\n```",
            Path::new("/"),
        );
        assert_eq!(html.matches("class=\"language-mermaid\"").count(), 2);
        assert!(html.contains("Café &lt; &amp; &gt;"));
        assert!(html.contains("let n = 1;"));
        assert!(html.contains("language-rust"));
        assert!(!html.contains("<svg"));
    }

    #[test]
    fn allows_only_supported_language_classes_on_code() {
        let html = render(
            "<div class=\"language-mermaid\">Texto</div>\n\n<pre><code class=\"language-mermaid toolbar mermaid-svg\" style=\"color:red\" onclick=\"alert(1)\">flowchart LR\nA--&gt;B</code></pre>",
            Path::new("/"),
        );
        assert_eq!(html.matches("class=\"language-mermaid\"").count(), 1);
        assert!(!html.contains("toolbar"));
        assert!(!html.contains("mermaid-svg"));
        assert!(!html.contains("style="));
        assert!(!html.contains("onclick="));
    }

    #[test]
    fn preserves_code_languages_aliases_and_literal_source() {
        let html = render(
            "```ts extra\nconst x = '<script>alert(1)</script>';\n```\n\n```sh\necho hello\n```\n\n```unknown\nplain\n```\n\n<code class=\"language-python toolbar\" onclick=\"alert(1)\">print(1)</code>\n\n<div class=\"language-js\">plain</div>",
            Path::new("/"),
        );
        assert!(html.contains("class=\"language-ts\""));
        assert!(html.contains("class=\"language-sh\""));
        assert!(html.contains("class=\"language-python\""));
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        for forbidden in [
            "language-unknown",
            "language-js",
            "toolbar",
            "onclick=",
            "<script>",
        ] {
            assert!(!html.contains(forbidden), "{forbidden}");
        }
    }

    #[test]
    fn preserves_document_anchors_but_strips_relative_file_links() {
        let html = render("[arriba](#hola) [archivo](./otro.md)", Path::new("/"));
        assert!(html.contains("href=\"#hola\""));
        assert!(!html.contains("href=\"./otro.md\""));
    }

    #[test]
    fn reads_unicode_paths_bom_and_uppercase_extensions() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("una lectura ñ.MD");
        fs::write(&path, "\u{feff}# Café").unwrap();
        let doc = load(&path).unwrap();
        assert_eq!(doc.name, "una lectura ñ.MD");
        assert!(doc.html.contains("<h1>Café</h1>"));
    }

    #[test]
    fn rejects_invalid_missing_binary_and_oversized_documents() {
        let dir = tempdir().unwrap();
        assert!(load(&dir.path().join("no.txt")).is_err());
        assert!(load(&dir.path().join("missing.md")).is_err());
        let path = dir.path().join("invalid.md");
        fs::write(&path, [0xff, 0xfe]).unwrap();
        assert!(load(&path).is_err());
        let file = File::create(&path).unwrap();
        file.set_len(MAX_DOCUMENT_BYTES + 1).unwrap();
        assert!(load(&path).is_err());
        let folder = dir.path().join("folder.md");
        fs::create_dir(folder.clone()).unwrap();
        assert!(load(&folder).is_err());
    }

    #[test]
    fn embeds_images_but_blocks_files_outside_the_document_directory() {
        let dir = tempdir().unwrap();
        let docs = dir.path().join("docs");
        fs::create_dir(&docs).unwrap();
        fs::write(docs.join("una imagen.png"), b"example").unwrap();
        fs::write(dir.path().join("outside.png"), b"private").unwrap();
        let mut budget = MAX_TOTAL_IMAGE_BYTES;
        assert!(image_source("una%20imagen.png", &docs, &mut budget)
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert!(image_source("../outside.png", &docs, &mut budget).is_none());
        assert!(image_source("file:///etc/passwd", &docs, &mut budget).is_none());
        assert!(image_source("http://example.com/a.png", &docs, &mut budget).is_none());
        assert!(image_source("https://example.com/a.png", &docs, &mut budget).is_some());
        fs::write(docs.join("secret.txt"), b"secret").unwrap();
        assert!(image_source("secret.txt", &docs, &mut budget).is_none());
        let html = render("![imagen](una%20imagen.png)", &docs);
        assert!(html.contains("#local-image-1-0"));
        assert!(!html.contains("data:image/"));
    }

    #[cfg(unix)]
    #[test]
    fn blocks_symlink_image_escape() {
        let dir = tempdir().unwrap();
        let docs = dir.path().join("docs");
        fs::create_dir(&docs).unwrap();
        fs::write(dir.path().join("private.png"), b"private").unwrap();
        std::os::unix::fs::symlink(dir.path().join("private.png"), docs.join("linked.png"))
            .unwrap();
        let mut budget = MAX_TOTAL_IMAGE_BYTES;
        assert!(image_source("linked.png", &docs, &mut budget).is_none());
        let path = docs.join("reading.md");
        fs::write(&path, "![link](linked.png)").unwrap();
        let loaded = super::load(&path, "1".into()).unwrap();
        assert!(loaded.images.resolve(0).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_directory_replaced_by_a_symlink_after_opening() {
        let dir = tempdir().unwrap();
        let docs = dir.path().join("docs");
        let outside = dir.path().join("outside");
        fs::create_dir(&docs).unwrap();
        fs::create_dir(&outside).unwrap();
        let path = docs.join("reading.md");
        fs::write(&path, "![image](private.png)").unwrap();
        fs::write(outside.join("private.png"), b"private").unwrap();
        let loaded = super::load(&path, "1".into()).unwrap();
        fs::rename(&docs, dir.path().join("original")).unwrap();
        std::os::unix::fs::symlink(&outside, &docs).unwrap();
        assert!(loaded.images.resolve(0).is_err());
    }

    #[test]
    fn text_loading_does_not_read_or_stat_local_images() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("reading.md");
        fs::write(&path, "# Texto primero\n\n![Café](imagen%20%C3%B1.png)").unwrap();
        // Create the image only after load returns. Its bytes cannot have been
        // read or its absence rejected while preparing the initial HTML.
        let loaded = super::load(&path, "42".into()).unwrap();
        assert!(loaded.document.html.contains("<h1>Texto primero</h1>"));
        assert!(loaded.document.html.contains("#local-image-42-0"));
        assert!(loaded.document.html.contains("alt=\"Café\""));
        assert!(!loaded.document.html.contains("data:image/"));
        fs::write(dir.path().join("imagen ñ.png"), b"deferred").unwrap();
        assert_eq!(
            loaded.images.resolve(0).unwrap(),
            format!("data:image/png;base64,{}", STANDARD.encode(b"deferred"))
        );
        assert!(loaded.images.resolve(0).is_err());
        assert!(loaded.images.resolve(1).is_err());
    }

    #[test]
    fn deferred_images_enforce_paths_formats_and_isolated_failures() {
        let dir = tempdir().unwrap();
        let docs = dir.path().join("docs");
        fs::create_dir(&docs).unwrap();
        fs::write(dir.path().join("outside.png"), b"private").unwrap();
        fs::write(docs.join("secret.txt"), b"private").unwrap();
        fs::write(docs.join("valid.png"), b"image").unwrap();
        let path = docs.join("reading.md");
        fs::write(&path, "![escape](../outside.png)\n![missing](missing.png)\n![type](secret.txt)\n![valid](valid.png)\n![absolute](/outside.png)\n![file](file:///etc/passwd)\n![windows](C:/outside.png)\n![http](http://example.com/a.png)\n![https](https://example.com/a.png)").unwrap();
        let loaded = super::load(&path, "1".into()).unwrap();
        assert_eq!(loaded.images.sources.len(), 4);
        for index in 0..3 {
            assert!(loaded.images.resolve(index).is_err());
        }
        assert!(loaded.images.resolve(3).is_ok());
        assert!(loaded.document.html.contains("https://example.com/a.png"));
        assert!(!loaded.document.html.contains("file:"));
        assert!(!loaded.document.html.contains("C:/"));
        assert!(!loaded.document.html.contains("http://example.com"));
        let mut remaining = MAX_TOTAL_IMAGE_BYTES;
        for source in [
            "/outside.png",
            "\\outside.png",
            "C:/outside.png",
            "file:///etc/passwd",
        ] {
            assert!(image_source(source, &docs, &mut remaining).is_none());
        }
    }

    #[test]
    fn concurrent_images_share_the_budget_and_oversized_images_do_not_consume_it() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("reading.md");
        File::create(dir.path().join("large.png"))
            .unwrap()
            .set_len(MAX_IMAGE_BYTES + 1)
            .unwrap();
        for index in 0..5 {
            File::create(dir.path().join(format!("{index}.png")))
                .unwrap()
                .set_len(MAX_IMAGE_BYTES)
                .unwrap();
        }
        fs::write(dir.path().join("empty.png"), b"").unwrap();
        fs::write(&path, "![large](large.png)\n![0](0.png)\n![1](1.png)\n![2](2.png)\n![3](3.png)\n![4](4.png)\n![empty](empty.png)").unwrap();
        let images = Arc::new(super::load(&path, "1".into()).unwrap().images);
        assert!(images.resolve(0).is_err());
        assert_eq!(images.budget.lock().unwrap().0, MAX_TOTAL_IMAGE_BYTES);
        let threads: Vec<_> = (1..=5)
            .map(|index| {
                let images = images.clone();
                std::thread::spawn(move || images.resolve(index).is_ok())
            })
            .collect();
        let successes = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .filter(|success| *success)
            .count();
        assert_eq!(successes, 4);
        assert_eq!(images.budget.lock().unwrap().0, 0);
        assert!(images.resolve(6).is_ok());
    }

    #[test]
    fn obsolete_loads_and_image_references_cannot_replace_the_current_opening() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("reading.md");
        fs::write(&path, "![image](image.png)").unwrap();
        fs::write(dir.path().join("image.png"), b"image").unwrap();
        let mut store = ImageStore::default();
        let first = store.begin();
        store.publish(super::load(&path, first.clone()).unwrap());
        store.activate(&first).unwrap();
        let old = store.get(&first).unwrap();
        let second = store.begin();
        let second_load = super::load(&path, second.clone()).unwrap();
        let third = store.begin();
        store.publish(super::load(&path, third.clone()).unwrap());
        store.publish(second_load);
        // Publishing a response is not evidence the UI accepted it.
        assert!(store.get(&first).is_ok());
        assert!(store.get(&third).is_err());
        assert!(store.activate(&second).is_err());
        store.activate(&third).unwrap();
        assert!(store.get(&second).is_err());
        assert!(store.get(&first).is_err());
        assert!(store.get("arbitrary/path.png").is_err());
        assert!(old.resolve(0).is_err());
        assert!(store.get(&third).unwrap().resolve(0).is_ok());
        // A failed opening leaves the visible document's remaining images valid.
        store.begin();
        assert!(store.get(&third).is_ok());
    }

    #[test]
    fn a_discarded_response_keeps_the_visible_documents_images_active() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("reading.md");
        fs::write(&path, "![image](image.png)").unwrap();
        fs::write(dir.path().join("image.png"), b"image").unwrap();
        let mut store = ImageStore::default();
        let visible = store.begin();
        store.publish(super::load(&path, visible.clone()).unwrap());
        store.activate(&visible).unwrap();
        let discarded = store.begin();
        store.publish(super::load(&path, discarded.clone()).unwrap());
        assert!(store.get(&discarded).is_err());
        assert!(store.get(&visible).unwrap().resolve(0).is_ok());
    }
}
