"""Regression tests for validate-tokens.cjs.

The validator used to skip any line containing ``var(--`` outright, so a
hardcoded value sharing a line with a token reference (extremely common in
real CSS, and universal in minified CSS where everything is one line) went
undetected. These tests drive the CLI via ``node`` and assert it flags such
cases. They are pytest-based so the repository's existing pytest CI runs them.
"""

import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "validate-tokens.cjs"


def _run(tmp_path: Path, css: str) -> subprocess.CompletedProcess:
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    (tmp_path / "sample.css").write_text(css, encoding="utf-8")
    return subprocess.run(
        [node, str(SCRIPT), "--dir", str(tmp_path)],
        capture_output=True,
        text=True,
        # validate-tokens.cjs prints emoji; without an explicit encoding Python
        # decodes the pipe with the locale codec (cp1252 on Windows), which
        # raises in the reader thread and leaves result.stdout set to None.
        encoding="utf-8",
    )


def test_flags_hardcoded_hex_sharing_line_with_token(tmp_path):
    """A hardcoded hex on the same line as a var() token is still a violation."""
    result = _run(
        tmp_path,
        ".btn { background: #FF6B6B; color: var(--color-primary); }\n",
    )
    assert "#FF6B6B" in result.stdout, result.stdout
    assert result.returncode == 1


def test_token_only_line_reports_no_violation(tmp_path):
    """A line that references only tokens produces no false positives."""
    result = _run(
        tmp_path,
        ".btn { background: var(--color-bg); color: var(--color-primary); }\n",
    )
    assert "No token violations" in result.stdout, result.stdout
    assert result.returncode == 0


def _run_file(tmp_path: Path, name: str, text: str) -> subprocess.CompletedProcess:
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    (tmp_path / name).write_text(text, encoding="utf-8")
    return subprocess.run(
        [node, str(SCRIPT), "--dir", str(tmp_path)],
        capture_output=True, text=True, encoding="utf-8",
    )


def test_custom_property_definitions_are_not_violations(tmp_path):
    """Defining a token (`--grass: #c8902f`) is the token itself, not a misuse."""
    result = _run(tmp_path, ":root { --grass: #c8902f; --gap: 24px; --step-1: 1.25rem; }\n")
    assert "No token violations" in result.stdout, result.stdout
    assert result.returncode == 0


def test_media_query_breakpoints_are_not_violations(tmp_path):
    """var() is not allowed in @media conditions, so literal breakpoints are fine."""
    result = _run(tmp_path, "@media (max-width: 760px) { .steps { grid-template-columns: 1fr; } }\n")
    assert "No token violations" in result.stdout, result.stdout


def test_media_query_body_is_still_checked(tmp_path):
    """Only the condition is exempt; declarations inside the block are still scanned."""
    result = _run(tmp_path, "@media (max-width: 760px) { .card { padding: 24px; } }\n")
    assert "24px" in result.stdout, result.stdout
    assert result.returncode == 1


def test_astro_component_styles_are_scanned(tmp_path):
    """Astro components keep scoped styles in .astro files; those must be checked."""
    result = _run_file(tmp_path, "Card.astro", "<style>\n.card { color: #a33; }\n</style>\n")
    assert "#a33" in result.stdout, result.stdout
    assert result.returncode == 1


def test_img_sizes_breakpoints_and_doc_comments_are_not_violations(tmp_path):
    """Breakpoints in `sizes` and lines inside a /** ... */ comment are not styling."""
    result = _run_file(
        tmp_path, "images.ts",
        "/**\n * e.g. '(max-width: 760px) 100vw, 33vw'\n */\n"
        "const sizes = '(max-width: 760px) 100vw, 33vw';\n",
    )
    assert "No token violations" in result.stdout, result.stdout
