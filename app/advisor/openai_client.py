"""Small OpenAI Chat Completions client (no SDK): streaming for chat, one-shot for plans and transcripts.

Same yield and return shape as claude.py. System blocks are flattened into one system message.
Docs: https://platform.openai.com/docs/api-reference/chat
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx


class OpenAIError(Exception):
    """An error with a message that is safe to show the student."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def friendly_error(status: int, body: Any) -> str:
    detail = ""
    if isinstance(body, dict) and isinstance(body.get("error"), dict) and body["error"].get("message"):
        detail = f" ({body['error']['message']})"
    if status == 401:
        return "The OpenAI API key was rejected. Check OPENAI_API_KEY in .env."
    if status == 403:
        return f"The OpenAI API key does not have access to this model or feature{detail}."
    if status == 404:
        return f"The model was not found. Check OPENAI_MODEL in .env{detail}."
    if status == 429:
        return "The OpenAI API rate limit was hit. Wait a moment and try again."
    if status in (500, 502, 503):
        return "OpenAI is busy right now. Try again in a minute."
    if status == 400:
        return f"The request to OpenAI was invalid{detail}."
    return f"The OpenAI API returned an error ({status}){detail}."


def _headers(api_key: str) -> dict[str, str]:
    return {"authorization": f"Bearer {api_key}", "content-type": "application/json"}


def _system_text(system: list[dict] | str) -> str:
    if isinstance(system, str):
        return system
    return "\n\n".join(block.get("text", "") for block in system if isinstance(block, dict) and block.get("text"))


def _content(content: Any) -> str | list[dict[str, Any]]:
    """String messages stay strings. Claude content blocks become Chat Completions parts."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[dict[str, Any]] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind == "text" and block.get("text"):
            parts.append({"type": "text", "text": block["text"]})
        elif kind == "image":
            source = block.get("source") or {}
            media = source.get("media_type") or "image/png"
            data = source.get("data") or ""
            if data:
                parts.append({"type": "image_url", "image_url": {"url": f"data:{media};base64,{data}"}})
        elif kind == "document":
            source = block.get("source") or {}
            media = source.get("media_type") or "application/pdf"
            data = source.get("data") or ""
            if data:
                name = "transcript.pdf" if media == "application/pdf" else "transcript"
                parts.append({"type": "file", "file": {"filename": name, "file_data": f"data:{media};base64,{data}"}})
    return parts


def _chat_messages(system: list[dict] | str, messages: list[dict]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = [{"role": "system", "content": _system_text(system)}]
    for message in messages:
        role = message.get("role", "user")
        if role == "tool" or message.get("tool_calls"):
            item: dict[str, Any] = {"role": role, "content": message.get("content") or None}
            if role == "tool":
                item["content"] = message.get("content") or ""
                item["tool_call_id"] = message.get("tool_call_id") or ""
            if message.get("tool_calls"):
                item["tool_calls"] = message["tool_calls"]
            out.append(item)
            continue
        out.append({"role": role, "content": _content(message.get("content"))})
    return out


def _stop_reason(finish: str | None) -> str | None:
    if finish == "length":
        return "max_tokens"
    if finish == "stop":
        return "end_turn"
    return finish


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
    payload = "\n".join(data).strip()
    if not payload or payload == "[DONE]":
        return []
    try:
        evt = json.loads(payload)
    except ValueError:
        return []
    if isinstance(evt.get("error"), dict):
        err = evt["error"]
        if err.get("code") == "rate_limit_exceeded":
            raise OpenAIError("The OpenAI API rate limit was hit. Wait a moment and try again.")
        raise OpenAIError(f"OpenAI stopped with an error{': ' + err['message'] if err.get('message') else '.'}")
    out: list[dict[str, Any]] = []
    for choice in evt.get("choices") or []:
        delta = choice.get("delta") or {}
        text = delta.get("content")
        if isinstance(text, str) and text:
            out.append({"text": text})
        for call in delta.get("tool_calls") or []:
            if isinstance(call, dict):
                out.append({"tool_call": call})
        reason = choice.get("finish_reason")
        if reason:
            out.append({"stop_reason": _stop_reason(reason)})
    return out


_NO_TEMPERATURE: set[str] = set()  # models that reject the temperature setting


def _body(
    *, model: str, max_tokens: int, system: list[dict] | str, messages: list[dict],
    temperature: float | None, stream: bool, tools: list[dict] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": model,
        "max_completion_tokens": max_tokens,
        "messages": _chat_messages(system, messages),
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    if stream:
        body["stream"] = True
    if temperature is not None and model not in _NO_TEMPERATURE:
        body["temperature"] = temperature
    return body


async def _raise_for_status(res: httpx.Response) -> None:
    if res.status_code == 200:
        return
    try:
        detail = res.json()
    except ValueError:
        detail = None
    raise OpenAIError(friendly_error(res.status_code, detail), status=res.status_code)


async def stream_openai(
    *, api_key: str, base_url: str, model: str, max_tokens: int,
    system: list[dict] | str, messages: list[dict], timeout: float = 120.0,
    tools: list[dict] | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Yield {"text": "..."} pieces and {"tool_call": ...} fragments, then {"stop_reason": ...}."""
    url = f"{base_url.rstrip('/')}/chat/completions"
    body = _body(model=model, max_tokens=max_tokens, system=system, messages=messages, temperature=None, stream=True, tools=tools)
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=15.0)) as client:
        async with client.stream("POST", url, headers=_headers(api_key), json=body) as res:
            if res.status_code != 200:
                raw = await res.aread()
                try:
                    detail = json.loads(raw)
                except ValueError:
                    detail = None
                raise OpenAIError(friendly_error(res.status_code, detail))
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


async def call_openai(
    *, api_key: str, base_url: str, model: str, max_tokens: int,
    system: list[dict] | str, messages: list[dict], timeout: float = 120.0, temperature: float | None = None,
) -> tuple[str, str | None]:
    """One request, not streamed. Returns (text, stop_reason). Raises OpenAIError."""
    url = f"{base_url.rstrip('/')}/chat/completions"
    body = _body(model=model, max_tokens=max_tokens, system=system, messages=messages, temperature=temperature, stream=False)
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=15.0)) as client:
        res = await client.post(url, headers=_headers(api_key), json=body)
        if res.status_code == 400 and "temperature" in body and "temperature" in res.text:
            _NO_TEMPERATURE.add(model)
            body.pop("temperature")
            res = await client.post(url, headers=_headers(api_key), json=body)
    await _raise_for_status(res)
    data = res.json()
    choice = (data.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    text = message.get("content") or ""
    if isinstance(text, list):
        text = "".join(part.get("text", "") for part in text if isinstance(part, dict))
    return text, _stop_reason(choice.get("finish_reason"))
