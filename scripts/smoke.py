"""Exercise the actual Linux WebView through tauri-driver, using stdlib only.

Prerequisites: cargo install tauri-driver --locked; WebKitWebDriver; Xvfb.
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

        call("DELETE", f"/session/{session}")
        session = None
        session = call("POST", "/session", {"capabilities": {"alwaysMatch": {
            "browserName": "wry", "tauri:options": {"application": str(BINARY)}
        }}})["sessionId"]
        wait_for(lambda: execute("return document.querySelector('#status').textContent === 'Listo para leer'"))
        assert execute("return document.querySelector('#document').hidden")
        screenshot("empty.png")
        print("PASS: opening without a file shows the minimal file picker")
    finally:
        if session:
            call("DELETE", f"/session/{session}")
        driver.terminate()
        driver.wait(timeout=10)
        log.close()
