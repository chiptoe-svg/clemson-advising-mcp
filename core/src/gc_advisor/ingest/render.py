from playwright.sync_api import sync_playwright

CONTENT_SELECTOR = ".block_content_outer"


def render_html(url: str, selector: str = CONTENT_SELECTOR, timeout_ms: int = 30000) -> str:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page()
            page.goto(url, wait_until="networkidle", timeout=timeout_ms)
            el = page.query_selector(selector) or page.query_selector("body")
            html = (el.inner_html() if el else "") or ""
        finally:
            browser.close()
    return html


def render_text(url: str, selector: str = CONTENT_SELECTOR, timeout_ms: int = 30000) -> str:
    """Render a JS page and return cleaned innerText of the main content block.

    Raises RuntimeError if the content block is empty (the JS-render-failure
    signature) so ingest never silently stores a blank program.
    """
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page()
            page.goto(url, wait_until="networkidle", timeout=timeout_ms)
            el = page.query_selector(selector) or page.query_selector("body")
            text = (el.inner_text() if el else "") or ""
        finally:
            browser.close()
    import re
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if len(text) < 200:
        raise RuntimeError(f"Rendered content too short ({len(text)} chars) for {url}")
    return text


def render_both(url: str, selector: str = CONTENT_SELECTOR, timeout_ms: int = 30000) -> tuple[str, str]:
    """(html, text) of the content block from ONE page load, so the HTML and
    text readers always see the same version of a page. The text is cleaned
    exactly as render_text cleans it, with the same too-short check."""
    import re
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page()
            page.goto(url, wait_until="networkidle", timeout=timeout_ms)
            el = page.query_selector(selector) or page.query_selector("body")
            html = (el.inner_html() if el else "") or ""
            text = (el.inner_text() if el else "") or ""
        finally:
            browser.close()
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if len(text) < 200:
        raise RuntimeError(f"Rendered content too short ({len(text)} chars) for {url}")
    return html, text
