# ==M-Stream Bridge==
# @name        M-Stream Bridge
# @version     __VERSION__
# @author      Zielzy
# @description Local bridge for non-DRM browser streams and Migaku Player.
# @homepage    https://github.com/Zielzy/M-Stream-Bridge
# ==/M-Stream Bridge==
"""
Cloudflare Bypass & Turnstile Solver (FlareSolverr Emulation Component).

This module serves as the embedded FlareSolverr component for M-Stream Bridge.
It uses `undetected_chromedriver` to automatically solve Cloudflare Turnstile
challenges, extract bypass cookies (`cf_clearance`) and User-Agent strings,
and cache them in-memory with a 1.5-hour TTL to bypass Cloudflare protection
on subtitle providers (e.g., Jimaku) without requiring an external FlareSolverr Docker container.
"""

from __future__ import annotations

import threading
import time
from typing import Any
import urllib.parse

_CF_LOCK: threading.Lock = threading.Lock()
_CF_COOKIES: dict[str, dict[str, Any]] = {}  # netloc -> {'cookie': str, 'user_agent': str, 'expires_at': float}


# =============================================================================
# Chrome Version & Registry Helpers
# =============================================================================

def _get_chrome_version_main() -> int | None:
    """
    Retrieve the major version of Google Chrome installed on Windows via winreg.

    Essential so `undetected_chromedriver` matches the user's actual Chrome binary version.
    """
    try:
        import winreg
    except ImportError:
        return None

    paths = [
        (winreg.HKEY_CURRENT_USER, r"Software\Google\Chrome\BLBeacon"),
        (winreg.HKEY_LOCAL_MACHINE, r"Software\Google\Chrome\BLBeacon"),
    ]
    for hkey, subkey in paths:
        try:
            key = winreg.OpenKey(hkey, subkey)
            version, _ = winreg.QueryValueEx(key, "version")
            winreg.CloseKey(key)
            return int(version.split(".")[0])
        except Exception:
            pass
    return None


# =============================================================================
# Turnstile Solver Execution
# =============================================================================

def _solve_cloudflare_turnstile(url: str) -> dict[str, Any] | None:
    """
    Launch a headless Chrome browser to automatically solve Cloudflare Turnstile challenges.

    Workflow:
    1. Opens target URL using `undetected_chromedriver`.
    2. Periodically scans for Turnstile iframes on the web page.
    3. Simulates click on Turnstile checkbox if found.
    4. Extracts session cookies (`cf_clearance`, etc.) and User-Agent string after successful bypass.
    5. Saves cookies to local memory cache (`_CF_COOKIES`) with a 1.5-hour TTL.
    """
    domain = urllib.parse.urlparse(url).netloc
    with _CF_LOCK:
        existing = _CF_COOKIES.get(domain)
        if existing and time.time() < existing.get("expires_at", 0.0):
            return existing

        print(f"[BRIDGE] Launching headless Chrome to solve Cloudflare Turnstile for {domain}...")
        driver = None
        try:
            import undetected_chromedriver as uc

            options = uc.ChromeOptions()
            options.add_argument("--headless=new")
            options.add_argument("--no-sandbox")
            options.add_argument("--disable-dev-shm-usage")

            target_ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
            options.add_argument(f"--user-agent={target_ua}")

            version_main = _get_chrome_version_main()
            if version_main:
                driver = uc.Chrome(options=options, version_main=version_main)
            else:
                driver = uc.Chrome(options=options)

            driver.get(url)
            solved = False
            for _sec in range(1, 20):
                time.sleep(1)
                title = driver.title.lower()
                source = driver.page_source.lower()

                # FlareSolverr emulation: search for and click Turnstile checkbox inside iframe
                try:
                    from selenium.webdriver.common.by import By

                    iframes = driver.find_elements(By.TAG_NAME, "iframe")
                    for iframe in iframes:
                        src = iframe.get_attribute("src")
                        if src and ("turnstile" in src.lower() or "challenges" in src.lower()):
                            driver.switch_to.frame(iframe)
                            try:
                                # Look for Turnstile checkbox elements
                                checkboxes = driver.find_elements(
                                    By.XPATH,
                                    "//input[@type='checkbox' or @type='button'] | //*[@id='challenge-stage'] | //div[contains(@class, 'checkbox')]",
                                )
                                for cb in checkboxes:
                                    try:
                                        cb.click()
                                        print("[BRIDGE] Turnstile clicked inside iframe.")
                                        time.sleep(1)
                                    except Exception:
                                        pass
                            except Exception:
                                pass
                            driver.switch_to.default_content()
                except Exception:
                    pass

                title = driver.title.lower()
                source = driver.page_source.lower()

                if "just a moment" in title or "cloudflare" in title or "turnstile" in source:
                    continue
                if len(driver.page_source) > 100:
                    solved = True
                    break

            if not solved:
                print(f"[BRIDGE] Cloudflare Turnstile solver timed out for {domain}")
                return None

            user_agent = driver.execute_script("return navigator.userAgent")
            cookies = driver.get_cookies()

            cookie_parts = []
            for c in cookies:
                cookie_parts.append(f"{c['name']}={c['value']}")
            cookie_str = "; ".join(cookie_parts)

            solution = {
                "cookie": cookie_str,
                "user_agent": user_agent,
                "expires_at": time.time() + 1.5 * 3600,
            }
            _CF_COOKIES[domain] = solution
            print(f"[BRIDGE] Cloudflare Turnstile solved for {domain}. Cookie saved.")
            return solution

        except Exception as e:
            print(f"[BRIDGE] Cloudflare Turnstile bypass failed for {domain}: {e}")
            return None
        finally:
            try:
                if driver:
                    driver.quit()
            except Exception:
                pass


# =============================================================================
# Request Header Manipulators
# =============================================================================

def _set_cookie_header(headers: dict[str, Any], cookie_val: str) -> None:
    """Insert or append a cookie value into a request header dictionary case-insensitively."""
    found_key = None
    for k in list(headers.keys()):
        if k.lower() == "cookie":
            found_key = k
            break
    if found_key:
        existing = headers[found_key]
        if existing and cookie_val:
            headers[found_key] = f"{existing}; {cookie_val}"
        elif cookie_val:
            headers[found_key] = cookie_val
    else:
        headers["Cookie"] = cookie_val


def _set_ua_header(headers: dict[str, Any], ua_val: str) -> None:
    """Set the User-Agent in a request header dictionary case-insensitively."""
    found_key = None
    for k in list(headers.keys()):
        if k.lower() == "user-agent":
            found_key = k
            break
    if found_key:
        headers[found_key] = ua_val
    else:
        headers["User-Agent"] = ua_val


