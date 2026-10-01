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

        def open_path(path):
            execute_async("""
                const done = arguments[arguments.length - 1];
                openDocument(() => window.__TAURI__.core.invoke('open_document', {path: arguments[0]}))
                    .then(() => done(true), error => done(String(error)));
            """, [str(path)])

        def rendered_diagrams(count):
            return execute("""
                const images = [...document.querySelectorAll('#document .mermaid-diagram img')];
                return images.length === arguments[0] && images.every(image => image.complete && image.naturalWidth > 0);
            """, [count])

        wait_for(lambda: execute("return document.querySelector('#document').dataset.readyMs"))
        assert execute("return !performance.getEntriesByType('resource').some(entry => entry.name.includes('/vendor/'))")
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

        execute_async("""
            const done = arguments[arguments.length - 1];
            const path = arguments[0];
            openDocument(() => window.__TAURI__.core.invoke('open_document', {path})).then(() => done(true), e => done(String(e)));
        """, [str(ROOT / "examples/bienvenido.md")])
        wait_for(lambda: execute("return document.querySelector('#filename').textContent === 'bienvenido.md'"))
        print("PASS: opening a path through the reader loads the document")

        execute_async("""
            const done = arguments[arguments.length - 1];
            const path = arguments[0];
            openDocument(() => window.__TAURI__.core.invoke('open_document', {path})).then(() => done(true), e => done(String(e)));
        """, [str(Path(temporary) / "missing.md")])
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

        open_path(ROOT / "examples/diagramas.md")
        wait_for(lambda: rendered_diagrams(3), timeout=30)
        assert execute("return document.querySelectorAll('#document pre[hidden] > code.language-mermaid').length") == 3
        assert execute("return document.querySelector('.mermaid-workspace') === null")
        assert execute("return document.querySelector('.mermaid-frame').getAttribute('sandbox') === 'allow-scripts'")
        assert execute("return document.querySelector('.mermaid-frame').contentDocument === null")
        execute("document.querySelector('#reader').scrollTop = 0")
        screenshot("mermaid.png")
        print("PASS: local Mermaid renderer draws flowchart, sequence and state as SVG images")

        light_images = execute("return [...document.querySelectorAll('.mermaid-diagram img')].map(image => image.src)")
        execute_async("""
            const done = arguments[arguments.length - 1];
            mermaidModule.then(module => module.renderDiagrams(
                document.querySelector('#document'), () => true, true
            )).then(() => done(true), error => done(String(error)));
        """)
        assert rendered_diagrams(3)
        dark_images = execute("return [...document.querySelectorAll('.mermaid-diagram img')].map(image => image.src)")
        assert dark_images != light_images
        print("PASS: diagrams can render again with the dark theme without duplicates")

        mermaid_fixture = Path(temporary) / "mermaid-errors.md"
        mermaid_fixture.write_text(
            '# Diagramas con errores\n\n'
            '```mermaid\nthis is not a diagram\n```\n\n'
            '```mermaid\n' + ('x' * 50_001) + '\n```\n\n'
            '```mermaid\n%%{init: {"securityLevel": "loose", "htmlLabels": true, "flowchart": {"htmlLabels": true}}}%%\n'
            'flowchart LR\nA["<img src=x onerror=window.injected=true>"] --> B["Seguro"]\n'
            'click A "javascript:window.injected=true"\n```\n\n'
            '```mermaid\nflowchart LR\nA --> B\n```\n\n'
            '```js\nconst ordinaryCode = true;\n```', encoding="utf-8")
        open_path(mermaid_fixture)
        wait_for(lambda: rendered_diagrams(2), timeout=30)
        assert execute("return document.querySelectorAll('#document .mermaid-error').length") == 2
        assert execute("return document.querySelectorAll('#document pre:not([hidden]) > code.language-mermaid').length") == 2
        assert execute("return document.querySelector('#document pre:last-child').textContent.includes('ordinaryCode')")
        assert execute("return window.injected === undefined")
        assert execute("return document.querySelector('#document svg, #document iframe, #document script') === null")
        assert execute("return document.querySelector('.mermaid-workspace') === null")
        print("PASS: bad and oversized diagrams keep source; later diagrams and ordinary code survive; unsafe directives cannot execute")

        execute("const probe = document.createElement('script'); probe.textContent = 'window.cspInjected = true'; document.body.append(probe); probe.remove()")
        assert execute("return window.cspInjected === undefined")
        print("PASS: production CSP blocks inline scripts; renderer has an opaque sandbox origin")

        # Start rendering and immediately replace the document. Await both jobs so
        # a late diagram would be observable rather than hidden by an early check.
        execute_async("""
            const done = arguments[arguments.length - 1];
            const path = arguments[0];
            const rendering = renderMermaid(requestId);
            openDocument(() => window.__TAURI__.core.invoke('open_document', {path}))
                .then(() => rendering).then(() => done(true), error => done(String(error)));
        """, [str(fixture)])
        assert execute("return document.querySelector('#document h1').textContent") == "Otro documento"
        assert execute("return document.querySelector('#document .mermaid-diagram') === null")
        print("PASS: late diagram results cannot alter a newer document")

        for name, count in [("arquitectura.md", 3), ("interfaz.md", 2), ("coordinacion-rust.md", 2),
                            ("procesamiento-documento.md", 3), ("mermaid.md", 1)]:
            open_path(ROOT / "docs" / name)
            wait_for(lambda: rendered_diagrams(count), timeout=30)
            assert execute("return document.querySelector('#document .mermaid-error') === null")
        print("PASS: all diagrams in the architecture documentation render")

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
        if session:
            call("DELETE", f"/session/{session}")
        driver.terminate()
        driver.wait(timeout=10)
        log.close()
