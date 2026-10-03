use std::{fs::File, io::Read, path::Path};

use base64::{engine::general_purpose::STANDARD, Engine};
use pulldown_cmark::{html, CowStr, Event, Options, Parser, Tag};
use serde::Serialize;
use url::Url;

const MAX_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Serialize)]
pub struct Document {
    pub path: String,
    pub name: String,
    pub html: String,
    pub bytes: usize,
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
    let directory = directory.canonicalize().ok()?;
    // URL joining decodes spaces and UTF-8 in Markdown image paths. Canonicalization
    // also prevents symlinks and ../ from escaping the document's directory.
    let base = Url::from_directory_path(&directory).ok()?;
    let path = base.join(source).ok()?.to_file_path().ok()?;
    let path = path.canonicalize().ok()?;
    if !path.starts_with(&directory) {
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

pub fn render(markdown: &str, directory: &Path) -> String {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES;
    let mut remaining = MAX_TOTAL_IMAGE_BYTES;
    let parser = Parser::new_ext(markdown, options).map(|event| match event {
        Event::Start(Tag::Image {
            link_type,
            dest_url,
            title,
            id,
        }) => {
            let source = image_source(&dest_url, directory, &mut remaining).unwrap_or_default();
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
    ammonia::Builder::default()
        .add_tags(&["input"])
        .add_tag_attributes("input", &["type", "checked", "disabled"])
        .add_tag_attributes("th", &["align"])
        .add_tag_attributes("td", &["align"])
        .add_allowed_classes("code", &["language-mermaid"])
        .add_generic_attributes(&["id"])
        .url_schemes(["https", "http", "mailto", "data"].into_iter().collect())
        .url_relative(ammonia::UrlRelative::Custom(Box::new(relative_url)))
        .clean(&output)
        .to_string()
}

pub fn load(path: &Path) -> Result<Document, String> {
    if !is_markdown(path) {
        return Err("Selecciona un archivo .md, .markdown, .mdown o .mkd.".to_owned());
    }
    let path = path
        .canonicalize()
        .map_err(|_| "No se encontró el archivo.".to_owned())?;
    let bytes = read_limited(&path, MAX_DOCUMENT_BYTES)?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| "El archivo debe estar guardado con codificación UTF-8.".to_owned())?;
    let html = render(
        text.trim_start_matches('\u{feff}'),
        path.parent().unwrap_or(Path::new(".")),
    );
    Ok(Document {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: path.to_string_lossy().into_owned(),
        html,
        bytes: bytes.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

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
    fn preserves_mermaid_language_and_escaped_source() {
        let html = render(
            "```mermaid\nflowchart LR\n  A[\"Café < & >\"] --> B\n```\n\n```rust\nlet n = 1;\n```\n\n```mermaid extra\nsequenceDiagram\n  A->>B: Hola\n```",
            Path::new("/"),
        );
        assert_eq!(html.matches("class=\"language-mermaid\"").count(), 2);
        assert!(html.contains("Café &lt; &amp; &gt;"));
        assert!(html.contains("let n = 1;"));
        assert!(!html.contains("language-rust"));
        assert!(!html.contains("<svg"));
    }

    #[test]
    fn allows_only_the_mermaid_class_on_code() {
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
        assert!(html.contains("data:image/png;base64,"));
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
    }
}
