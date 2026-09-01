"""Staging and artifact build pipeline for M-Stream Bridge."""

from __future__ import annotations

import ast
import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT_DIR, "src")
DIST_DIR = os.path.join(ROOT_DIR, "dist")


def _read_dotenv_value(content: str, key: str) -> str:
    """Extract a key-value entry from raw text without persisting secrets to disk."""
    for line in content.splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            name, value = line.split("=", 1)
            if name.strip() == key:
                return value.strip().strip("'\"")
    return ""


def _get_tmdb_api_key() -> str:
    """Resolve TMDB API credentials from CI environment or local .env configuration."""
    direct_key = os.environ.get("TMDB_API_KEY", "").strip()
    if direct_key:
        return direct_key

    secret_env_file = os.environ.get("ENV_FILE_SECRET", "")
    secret_key = _read_dotenv_value(secret_env_file, "TMDB_API_KEY")
    if secret_key:
        return secret_key

    root_env = os.path.join(ROOT_DIR, ".env")
    if os.path.exists(root_env):
        with open(root_env, "r", encoding="utf-8") as env_file:
            return _read_dotenv_value(env_file.read(), "TMDB_API_KEY")
    return ""


def obfuscate_tmdb_api_key(filepath: str) -> None:
    """Transform TMDB API loader into an in-memory XOR decoder in release staging."""
    api_key = _get_tmdb_api_key()
    if not api_key:
        return

    with open(filepath, "r", encoding="utf-8") as config_file:
        source = config_file.read()
    tree = ast.parse(source)
    loader = next(
        node for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == "load_tmdb_api_key"
    )

    xor_key = secrets.randbelow(255) + 1
    encrypted = [byte ^ xor_key for byte in api_key.encode("utf-8")]
    replacement = (
        "def load_tmdb_api_key() -> str:\n"
        f"    encrypted = {encrypted!r}\n"
        f"    xor_key = {xor_key}\n"
        "    return bytes(value ^ xor_key for value in encrypted).decode(\"utf-8\")\n"
    )
    lines = source.splitlines(keepends=True)
    lines[loader.lineno - 1:loader.end_lineno] = [replacement]
    with open(filepath, "w", encoding="utf-8", newline="\n") as config_file:
        config_file.write("".join(lines))
    print(f"[build] Obfuscated TMDB key in {os.path.relpath(filepath, ROOT_DIR)}")


def remove_dotenv_files(directory: str) -> None:
    """Purge environment secret files from staging directory."""
    for root, _, files in os.walk(directory):
        for filename in files:
            if filename == ".env":
                target = os.path.join(root, filename)
                os.remove(target)
                print(f"[build] Removed dotenv file: {os.path.relpath(target, ROOT_DIR)}")


class RemoveDocstrings(ast.NodeTransformer):
    """AST transformer to strip module, class, and function docstrings."""

    def _strip(self, node):
        self.generic_visit(node)
        if (
            node.body
            and isinstance(node.body[0], ast.Expr)
            and isinstance(node.body[0].value, ast.Constant)
            and isinstance(node.body[0].value.value, str)
        ):
            node.body.pop(0)
        return node

    visit_Module = visit_ClassDef = visit_FunctionDef = visit_AsyncFunctionDef = _strip


def strip_python_comments(filepath: str) -> None:
    """Remove docstrings and comments from Python source while preserving the file header."""
    with open(filepath, "r", encoding="utf-8") as f:
        source = f.read()

    header = ""
    header_match = re.match(
        r"^(# ==M-Stream Bridge==\r?\n(?:#[^\r\n]*\r?\n)*# ==/M-Stream Bridge==\r?\n)",
        source,
    )
    if header_match:
        header = header_match.group(1)
        source = source[header_match.end():]

    try:
        parsed = ast.parse(source)
        parsed = RemoveDocstrings().visit(parsed)
        clean_code = ast.unparse(parsed)
        with open(filepath, "w", encoding="utf-8", newline="\n") as f:
            f.write(header + clean_code)
        print(f"[build] Stripped comments from {os.path.relpath(filepath, ROOT_DIR)}")
    except Exception as e:
        print(f"[build] Warning: Could not strip comments from {filepath}: {e}")


def strip_js_comments(js_code: str) -> str:
    """Strip JavaScript comments while preserving string and regex literals."""
    pattern = (
        r'("(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|`(?:\\.|[^`\\])*`|'
        r'/(?:\\.|[^/\n\\])+/[a-zA-Z]*|^[ \t]*//.*(?:\n|$)|'
        r'^[ \t]*/\*[\s\S]*?\*/[ \t]*(?:\n|$)|/\*[\s\S]*?\*/|//.*)'
    )

    def replacer(match):
        s = match.group(0)
        if s.lstrip().startswith("/"):
            if s.startswith("/*") or s.startswith("//"):
                return ""
            return s
        return s

    return re.sub(pattern, replacer, js_code, flags=re.MULTILINE)


def minify_js(filepath: str) -> None:
    """Minify browser extension scripts and DevTools snippet using Terser."""
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    header = ""
    header_match = re.match(
        r"^\s*(// ==M-Stream Bridge==[\s\S]*?// ==/M-Stream Bridge==)", content
    )
    if header_match:
        header = header_match.group(1).strip() + "\n\n"
        content_to_process = content[header_match.end():].strip()
    else:
        content_to_process = content

    is_snippet = os.path.basename(filepath) == "migaku-player-snippet.js"
    temp_dir = tempfile.gettempdir()
    temp_in = os.path.join(temp_dir, f"terser_in_{os.path.basename(filepath)}")
    temp_out = os.path.join(temp_dir, f"terser_out_{os.path.basename(filepath)}")

    try:
        with open(temp_in, "w", encoding="utf-8", newline="\n") as f:
            f.write(content_to_process)

        if is_snippet:
            cmd = ["cmd", "/c", "npx", "terser", temp_in, "--compress", "--mangle", "-o", temp_out]
        else:
            cmd = [
                "cmd", "/c", "npx", "terser", temp_in,
                "--compress", "drop_console=true",
                "--format", "beautify=true",
                "-o", temp_out,
            ]

        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode == 0:
            with open(temp_out, "r", encoding="utf-8") as f:
                processed_code = f.read()

            with open(filepath, "w", encoding="utf-8", newline="\n") as f:
                if header:
                    f.write(header + (processed_code.strip() if is_snippet else "\n" + processed_code.strip()) + "\n")
                else:
                    f.write(processed_code.strip() + "\n")

            label = "Minified" if is_snippet else "Optimized"
            print(f"[build] {label} {os.path.relpath(filepath, ROOT_DIR)}")
            return
    except Exception as e:
        print(f"[build] Terser unavailable for {filepath}: {e}")
    finally:
        if os.path.exists(temp_in):
            os.remove(temp_in)
        if os.path.exists(temp_out):
            os.remove(temp_out)

    cleaned_js = strip_js_comments(content_to_process)
    cleaned_js = re.sub(r"\n[ \t]*\n", "\n", cleaned_js)
    cleaned_js = re.sub(r"\n[ \t]*\n", "\n", cleaned_js)
    cleaned_js = re.sub(
        r'const LOG_LEVEL\s*=\s*["\'](debug|info)["\']\s*;',
        'const LOG_LEVEL = "silent";',
        cleaned_js,
    )

    with open(filepath, "w", encoding="utf-8", newline="\n") as f:
        if header:
            f.write(header + "\n" + cleaned_js.strip() + "\n")
        else:
            f.write(cleaned_js.strip() + "\n")
    print(f"[build] Cleaned comments from {os.path.relpath(filepath, ROOT_DIR)}")


def clean_html(filepath: str) -> None:
    """Clean comments from HTML templates while preserving header metadata and DOCTYPE."""
    with open(filepath, "r", encoding="utf-8") as f:
        html = f.read()

    header = ""
    header_match = re.search(
        r"(<!--\s*==M-Stream Bridge==.*?==/M-Stream Bridge==\s*-->)",
        html,
        re.DOTALL,
    )
    if header_match:
        header = header_match.group(1).strip() + "\n"
        html = html[:header_match.start()] + html[header_match.end():]

    def clean_script_blocks(match):
        attrs = match.group(1) or ""
        content = match.group(2)
        if not content.strip():
            return match.group(0)
        cleaned = strip_js_comments(content)
        cleaned = re.sub(r"^\s*console\.\w+\([^)]*\);\s*$", "", cleaned, flags=re.MULTILINE)
        cleaned = re.sub(r"\n[ \t]*\n", "\n", cleaned)
        return f"<script{attrs}>\n{cleaned.strip()}\n</script>"

    html = re.sub(r"<script([^>]*)>([\s\S]*?)</script>", clean_script_blocks, html)

    def clean_style_blocks(match):
        attrs = match.group(1) or ""
        content = match.group(2)
        cleaned = re.sub(r"/\*[\s\S]*?\*/", "", content)
        return f"<style{attrs}>{cleaned}</style>"

    html = re.sub(r"<style([^>]*)>([\s\S]*?)</style>", clean_style_blocks, html)
    html = re.sub(r"<!--[\s\S]*?-->", "", html)

    with open(filepath, "w", encoding="utf-8", newline="\n") as f:
        if header:
            doctype_match = re.match(r"(<!\s*DOCTYPE[^>]*>)\s*", html, re.IGNORECASE)
            if doctype_match:
                f.write(doctype_match.group(1) + "\n" + header + html[doctype_match.end():])
            else:
                f.write(header + html)
        else:
            f.write(html)
    print(f"[build] Cleaned HTML {os.path.relpath(filepath, ROOT_DIR)}")


def clean_css(filepath: str) -> None:
    """Remove comment blocks and redundant whitespace from CSS stylesheets."""
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    cleaned_css = re.sub(r"/\*[\s\S]*?\*/", "", content)
    cleaned_css = re.sub(r"\n\s*\n", "\n\n", cleaned_css)

    with open(filepath, "w", encoding="utf-8", newline="\n") as f:
        f.write(cleaned_css)
    print(f"[build] Cleaned CSS {os.path.relpath(filepath, ROOT_DIR)}")


def inject_version(dist_dir: str, root_dir: str) -> None:
    """Inject semantic version from index.min.json into all distribution tokens."""
    index_path = os.path.join(root_dir, "index.min.json")
    with open(index_path, "r", encoding="utf-8") as f:
        version = json.load(f)["version"]

    target_extensions = {".js", ".html", ".json", ".py"}
    injected_count = 0

    for root, _, files in os.walk(dist_dir):
        for fname in files:
            if os.path.splitext(fname)[1] in target_extensions:
                fpath = os.path.join(root, fname)
                with open(fpath, "r", encoding="utf-8") as f:
                    text = f.read()
                if "__VERSION__" in text:
                    with open(fpath, "w", encoding="utf-8", newline="\n") as f:
                        f.write(text.replace("__VERSION__", version))
                    injected_count += 1

    print(f"[build] Injected version {version} into {injected_count} distribution file(s)")


def sync_build() -> None:
    """Execute the full distribution staging, minification, and cleaning pipeline."""
    print(f"[build] Initializing staging: {os.path.relpath(SRC_DIR, ROOT_DIR)} -> {os.path.relpath(DIST_DIR, ROOT_DIR)}")

    if not os.path.exists(SRC_DIR):
        print(f"[build] Error: Source directory '{SRC_DIR}' not found.")
        return

    if os.path.exists(DIST_DIR):
        src_items = set(os.listdir(SRC_DIR))
        for item in os.listdir(DIST_DIR):
            if item not in src_items and item != ".git":
                target = os.path.join(DIST_DIR, item)
                if os.path.isdir(target):
                    shutil.rmtree(target)
                else:
                    os.remove(target)
                print(f"[build] Purged stale artifact: {item}")
    else:
        os.makedirs(DIST_DIR)

    for item in os.listdir(SRC_DIR):
        if item in {"__pycache__", ".env"}:
            continue

        s = os.path.join(SRC_DIR, item)
        d = os.path.join(DIST_DIR, item)
        if os.path.isdir(s):
            shutil.copytree(s, d, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".env"))
        else:
            shutil.copy2(s, d)

    print("[build] Source tree copied to staging.")

    inject_version(DIST_DIR, ROOT_DIR)
    remove_dotenv_files(DIST_DIR)

    config_path = os.path.join(DIST_DIR, "core", "config.py")
    if os.path.exists(config_path):
        obfuscate_tmdb_api_key(config_path)

    for root, dirs, files in os.walk(DIST_DIR):
        if ".git" in dirs:
            dirs.remove(".git")

        for file in files:
            filepath = os.path.join(root, file)
            if file.endswith(".py"):
                strip_python_comments(filepath)
            elif file.endswith(".js"):
                minify_js(filepath)
            elif file.endswith(".html"):
                clean_html(filepath)
            elif file.endswith(".css"):
                clean_css(filepath)

    print("[build] Pipeline completed successfully.")


if __name__ == "__main__":
    sync_build()
