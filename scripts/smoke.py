"""Exercise the actual Linux WebView through tauri-driver, using stdlib only.

Prerequisites: cargo install tauri-driver --locked; WebKitWebDriver; Xvfb; xdotool.
Run: xvfb-run -a dbus-run-session -- python3 scripts/smoke.py
"""

import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
BINARY = Path(os.environ.get("MD_VIEWER_BINARY", ROOT / "src-tauri/target/release/markdown-viewer"))
ARTIFACTS = ROOT / "artifacts"
BASE = "http://127.0.0.1:4844"


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            value = json.load(response).get("value")
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error
    if isinstance(value, dict) and "error" in value:
        raise RuntimeError(value)
    return value


def wait_for(predicate, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.1)
    raise AssertionError("Timeout waiting for the WebView")


ARTIFACTS.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix="markdown-viewer-smoke-") as temporary:
    fixture = Path(temporary) / "lectura con ñ.MD"
    fixture.write_text("# Otro documento\n\n- [x] Solo lectura\n\n<script>window.injected = true</script>\n\n<img src='x' onerror='window.injected = true'>", encoding="utf-8")
    log = (ARTIFACTS / "webdriver.log").open("w")
    driver = subprocess.Popen([os.environ.get("TAURI_DRIVER_BINARY", "tauri-driver"), "--port", "4844", "--native-port", "4845"], stdout=log, stderr=log)
    session = None
    try:
        def driver_ready():
            try:
                return call("GET", "/status")
            except (OSError, RuntimeError):
                return None

        wait_for(driver_ready)
        session = call("POST", "/session", {"capabilities": {"alwaysMatch": {
            "browserName": "wry", "tauri:options": {
                "application": str(BINARY), "args": [str(ROOT / "examples/bienvenido.md")]
            }
        }}})["sessionId"]

        def execute(script, args=None):
            return call("POST", f"/session/{session}/execute/sync", {"script": script, "args": args or []})

        def execute_async(script, args=None):
            return call("POST", f"/session/{session}/execute/async", {"script": script, "args": args or []})

        def screenshot(name):
            image = call("GET", f"/session/{session}/screenshot")
            (ARTIFACTS / name).write_bytes(base64.b64decode(image))

        wait_for(lambda: execute("return document.querySelector('#document').dataset.readyMs"))
        assert execute("return document.querySelector('#document h1').textContent") == "Leer, y ya."
        assert execute("return document.querySelectorAll('#document table tbody tr').length") == 3
        assert execute("return document.querySelector('#document a[href=\"#leer-y-ya\"]') !== null")
        assert execute("return [...document.querySelectorAll('#document input')].every(el => el.disabled)")
        execute("document.querySelector('#document img').scrollIntoView()")
        wait_for(lambda: execute("return document.querySelector('#document img').naturalWidth === 640"))
        execute("document.querySelector('#reader').scrollTop = 0")
        screenshot("viewer.png")
        print("PASS: CLI startup, Markdown, table, anchors, disabled tasks, local image")

        before = fixture.read_bytes()
        subprocess.run([str(BINARY), str(fixture)], check=True, timeout=10)
        wait_for(lambda: execute("return document.querySelector('#filename').textContent === arguments[0]", [fixture.name]))
        assert execute("return document.querySelector('#document h1').textContent") == "Otro documento"
        assert execute("return window.injected === undefined")
        assert execute("return document.querySelector('#document script') === null")
        assert fixture.read_bytes() == before
        print("PASS: second launch reuses window, Unicode filename, active HTML removed, file unchanged")

        subprocess.run([str(BINARY), str(ROOT / "examples/bienvenido.md")], check=True, timeout=10)
        wait_for(lambda: execute("return document.querySelector('#filename').textContent === 'bienvenido.md'"))
        print("PASS: opening a path through the system event loads the document")

        subprocess.run([str(BINARY), str(Path(temporary) / "missing.md")], check=True, timeout=10)
        wait_for(lambda: execute("return !document.querySelector('#error').hidden"))
        assert execute("return document.querySelector('#document h1').textContent") == "Leer, y ya."
        execute("document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))")
        assert execute("return document.querySelector('#error').hidden")
        print("PASS: failed file open preserves previous document, Escape dismisses error")

        assert execute_async("""
            const done = arguments[arguments.length - 1];
            window.__TAURI__.core.invoke('open_link', {href: 'file:///etc/passwd'}).then(() => done(false), () => done(true));
        """)
        print("PASS: OS opener refuses local file URLs")

        deferred = Path(temporary) / "imágenes diferidas.md"
        deferred.write_text("# Texto primero\n\nLectura disponible.\n\n![Café](imagen%20%C3%B1.svg)\n\n![Ausente](missing.png)\n\n![Grande](large.png)", encoding="utf-8")
        with (Path(temporary) / "large.png").open("wb") as image:
            image.truncate(8 * 1024 * 1024 + 1)
        execute("""
            const originalCore = window.__TAURI__.core;
            window.pendingImageReads = [];
            // Tauri freezes the core module, but the containing namespace can
            // replace it with a controlled copy for this test.
            window.__TAURI__.core = { ...originalCore, invoke: (command, args) => {
                if (command !== 'resolve_document_image') return originalCore.invoke(command, args);
                return new Promise((resolve, reject) => window.pendingImageReads.push(() =>
                    originalCore.invoke(command, args).then(resolve, reject)));
            }};
            window.releaseImageReads = () => {
                window.__TAURI__.core = originalCore;
                window.pendingImageReads.splice(0).forEach(read => read());
            };
        """)
        subprocess.run([str(BINARY), str(deferred)], check=True, timeout=10)
        wait_for(lambda: execute("return document.querySelector('#filename').textContent === 'imágenes diferidas.md' && window.pendingImageReads.length === 2"))
        wait_for(lambda: execute("return document.querySelector('#document').dataset.readyMs"))
        assert execute("return document.querySelector('#document h1').textContent") == "Texto primero"
        assert execute("return document.querySelector('#document').dataset.imagesResolvedMs === undefined")
        assert execute("return document.querySelectorAll('.local-image-placeholder').length") == 3
        assert execute("return document.querySelector('#document').textContent.includes('Café')")
        # The file does not even exist until the text has painted. Rust must
        # validate and read it at resolution time, rather than during load().
        (Path(temporary) / "imagen ñ.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="green"/></svg>', encoding="utf-8")
        execute("""
            window.releaseImageReads();
            delete window.releaseImageReads;
        """)
        wait_for(lambda: execute("return document.querySelector('#document').dataset.imagesResolvedMs"))
        wait_for(lambda: execute("return document.querySelector('#document img')?.naturalWidth === 32"))
        assert execute("return [...document.querySelectorAll('.local-image-placeholder')].map(el => el.textContent)") == ["Ausente", "Grande"]
        assert execute("return document.querySelector('#error').hidden")
        print("PASS: text paints before controlled local reads; later Unicode image loads; missing and oversized images keep alt text")

        execute("""
            window.mermaidCspViolations = [];
            document.addEventListener('securitypolicyviolation', event => {
                window.mermaidCspViolations.push({directive: event.violatedDirective, blocked: event.blockedURI});
            });
        """)
        subprocess.run([str(BINARY), str(ROOT / "examples/mermaid.md")], check=True, timeout=10)
        wait_for(lambda: execute("return document.querySelector('#filename').textContent === 'mermaid.md'"))
        wait_for(lambda: execute("return document.querySelector('#document').dataset.diagramsReadyMs"), timeout=30)
        states = execute("return [...document.querySelectorAll('.mermaid-diagram')].map(el => ({state: el.dataset.state, message: el.querySelector('.mermaid-message').textContent}))")
        print("Mermaid results:", states)
        assert [state["state"] for state in states] == ["ready"] * 5 + ["error", "error"]
        assert execute("return document.querySelectorAll('.mermaid-svg svg').length") == 5
        assert execute("return document.querySelector('.mermaid-render-host') === null")
        assert execute("return document.querySelector('.mermaid-svg foreignObject, .mermaid-svg script, .mermaid-svg image, .mermaid-svg [style]') === null")
        assert execute("return [...document.querySelectorAll('.mermaid-svg svg')].every(svg => svg.getBoundingClientRect().width > 0 && svg.querySelector('title'))")
        assert execute("return [...document.querySelectorAll('.mermaid-svg style')].every(style => style.nonce === document.querySelector('#mermaid-style-nonce').nonce && style.sheet !== null)")
        violations = execute("return window.mermaidCspViolations")
        print("Mermaid CSP violations:", violations)
        assert violations == []
        execute("document.querySelector('.mermaid-diagram').scrollIntoView()")
        screenshot("mermaid.png")
        print("PASS: real SVG for five diagram types, isolated errors, source disclosure, trusted stylesheet nonce")

        for name in ["arquitectura.md", "interfaz.md", "coordinacion-rust.md", "procesamiento-documento.md", "mermaid.md"]:
            subprocess.run([str(BINARY), str(ROOT / "docs" / name)], check=True, timeout=10)
            wait_for(lambda: execute("return document.querySelector('#filename').textContent === arguments[0]", [name]))
            wait_for(lambda: execute("return document.querySelector('#document').dataset.diagramsReadyMs"), timeout=30)
            assert execute("return [...document.querySelectorAll('.mermaid-diagram')].every(el => el.dataset.state === 'ready')"), name
        print("PASS: all diagrams in project documentation render in the WebView")

        call("DELETE", f"/session/{session}")
        session = None
        session = call("POST", "/session", {"capabilities": {"alwaysMatch": {
            "browserName": "wry", "tauri:options": {"application": str(BINARY)}
        }}})["sessionId"]
        wait_for(lambda: execute("return document.querySelector('#status').textContent === 'Listo para leer'"))
        assert execute("return document.querySelector('#document').hidden")
        print("PASS: opening without a file shows the minimal file picker")

        execute("document.querySelector('#empty-open').click()")
        def picker_window():
            result = subprocess.run(["xdotool", "search", "--onlyvisible", "--name", "^Abrir Markdown$"], capture_output=True, text=True)
            return result.stdout.strip().split()[-1] if result.returncode == 0 else None

        window = wait_for(picker_window)
        subprocess.run(["xdotool", "windowfocus", "--sync", window], check=True)
        subprocess.run(["xdotool", "key", "ctrl+l"], check=True)
        time.sleep(0.2)
        subprocess.run(["xdotool", "type", "--clearmodifiers", str(ROOT / "examples/bienvenido.md")], check=True)
        time.sleep(0.2)
        subprocess.run(["xdotool", "key", "Return"], check=True)
        time.sleep(0.3)
        subprocess.run(["xdotool", "key", "Return"], check=True)
        wait_for(lambda: execute("return document.querySelector('#filename').textContent === 'bienvenido.md'"))
        assert execute("return !document.querySelector('#open').disabled")
        print("PASS: selecting a file through the native picker loads the document")
    finally:
        try:
            if session:
                try:
                    call("DELETE", f"/session/{session}")
                except (OSError, RuntimeError):
                    pass  # A crashed WebView must not leave its driver running.
        finally:
            driver.terminate()
            driver.wait(timeout=10)
            log.close()
