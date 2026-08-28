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
