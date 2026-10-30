"""Small Claude Messages API client (no SDK): streaming for chat, one-shot for plans and transcripts.

Docs: https://platform.claude.com/docs/en/api/messages
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

API_VERSION = "2023-06-01"


class ClaudeError(Exception):
    """An error with a message that is safe to show the student."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def friendly_error(status: int, body: Any) -> str:
    detail = ""
    if isinstance(body, dict) and isinstance(body.get("error"), dict) and body["error"].get("message"):
        detail = f" ({body['error']['message']})"
    if status == 401:
        return "The Claude API key was rejected. Check ANTHROPIC_API_KEY in .env."
    if status == 403:
        return f"The Claude API key does not have access to this model or feature{detail}."
    if status == 404:
        return f"The model was not found. Check ANTHROPIC_MODEL in .env{detail}."
    if status == 429:
        return "The Claude API rate limit was hit. Wait a moment and try again."
    if status in (503, 529):
        return "Claude is busy right now. Try again in a minute."
    if status == 400:
        return f"The request to Claude was invalid{detail}."
    return f"The Claude API returned an error ({status}){detail}."


def _headers(api_key: str) -> dict[str, str]:
    return {"x-api-key": api_key, "anthropic-version": API_VERSION, "content-type": "application/json"}


async def stream_claude(
    *, api_key: str, base_url: str, model: str, max_tokens: int,
    system: list[dict], messages: list[dict], timeout: float = 120.0,
) -> AsyncIterator[dict[str, Any]]:
    """Yield {"text": "..."} pieces, then {"stop_reason": ...}. Raises ClaudeError."""
    url = f"{base_url.rstrip('/')}/v1/messages"
    body = {"model": model, "max_tokens": max_tokens, "system": system, "messages": messages, "stream": True}
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=15.0)) as client:
        async with client.stream("POST", url, headers=_headers(api_key), json=body) as res:
            if res.status_code != 200:
                raw = await res.aread()
                try:
                    detail = json.loads(raw)
                except ValueError:
                    detail = None
                raise ClaudeError(friendly_error(res.status_code, detail))
            stop_reason = None
            buffer = ""
            async for chunk in res.aiter_text():
                buffer += chunk
                while True:
                    cut = _event_end(buffer)
                    if cut is None:
                        break
                    raw_event, buffer = buffer[: cut[0]], buffer[cut[1]:]
                    for item in _handle_event(raw_event):
                        if "stop_reason" in item:
                            stop_reason = item["stop_reason"]
                        else:
                            yield item
            if buffer.strip():
                for item in _handle_event(buffer):
                    if "stop_reason" in item:
                        stop_reason = item["stop_reason"]
                    else:
                        yield item
            yield {"stop_reason": stop_reason}


def _event_end(buffer: str) -> tuple[int, int] | None:
    """Where the first server-sent event ends: (end of event, start of the next)."""
    best = None
    for sep in ("\r\n\r\n", "\n\n"):
        i = buffer.find(sep)
        if i != -1 and (best is None or i < best[0]):
            best = (i, i + len(sep))
    return best


def _handle_event(raw: str) -> list[dict[str, Any]]:
    data = [line[5:].lstrip() for line in raw.splitlines() if line.startswith("data:")]
    if not data:
        return []
    try:
        evt = json.loads("\n".join(data))
    except ValueError:
        return []
    kind = evt.get("type")
    if kind == "content_block_delta":
        delta = evt.get("delta") or {}
        if delta.get("type") == "text_delta" and delta.get("text"):
            return [{"text": delta["text"]}]
    elif kind == "message_delta":
        reason = (evt.get("delta") or {}).get("stop_reason")
        if reason:
            return [{"stop_reason": reason}]
    elif kind == "error":
        err = evt.get("error") or {}
        if err.get("type") == "overloaded_error":
            raise ClaudeError("Claude is busy right now. Try again in a minute.")
        raise ClaudeError(f"Claude stopped with an error{': ' + err['message'] if err.get('message') else '.'}")
    return []


_NO_TEMPERATURE: set[str] = set()  # models that reject the temperature setting


async def call_claude(
    *, api_key: str, base_url: str, model: str, max_tokens: int,
    system: list[dict] | str, messages: list[dict], timeout: float = 120.0, temperature: float | None = None,
) -> tuple[str, str | None]:
    """One request, not streamed. Returns (text, stop_reason). Raises ClaudeError."""
    url = f"{base_url.rstrip('/')}/v1/messages"
    body = {"model": model, "max_tokens": max_tokens, "system": system, "messages": messages}
    # some models do not take `temperature`; then the request is sent without it (and remembered)
    if temperature is not None and model not in _NO_TEMPERATURE:
        body["temperature"] = temperature
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=15.0)) as client:
        res = await client.post(url, headers=_headers(api_key), json=body)
        if res.status_code == 400 and "temperature" in body and "temperature" in res.text:
            _NO_TEMPERATURE.add(model)
            body.pop("temperature")
            res = await client.post(url, headers=_headers(api_key), json=body)
    if res.status_code != 200:
        try:
            detail = res.json()
        except ValueError:
            detail = None
        raise ClaudeError(friendly_error(res.status_code, detail), status=res.status_code)
    data = res.json()
    text = "".join(b.get("text", "") for b in data.get("content") or [] if b.get("type") == "text")
    return text, data.get("stop_reason")
