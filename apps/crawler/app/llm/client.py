"""统一 LLM 客户端：多模型路由 + 失败自动降级 + 成本计量。

设计要点（沿用既有做法）：
  - 按 task 路由到不同模型：fast 用于抽取，strong 用于复杂推理；
  - 主模型失败自动降级到备用模型；
  - 全部失败抛出 LLMUnavailable，由调用方走规则兜底；
  - 每次调用写 llm_call_logs（通过回调注入，避免强耦合）。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Iterable

from ..config import settings
from ..utils import get_logger, retry

log = get_logger(__name__)


class LLMUnavailable(RuntimeError):
    """所有模型均不可用时抛出。"""


@dataclass
class LLMResult:
    text: str
    model: str
    prompt_tokens: int = 0
    output_tokens: int = 0
    latency_ms: int = 0


# 任务 → 模型链（主模型在前，依次降级）
TASK_ROUTES: dict[str, list[str]] = {
    "extract_job": [settings.llm_model_fast, settings.llm_model_strong],
    "match_field": [settings.llm_model_fast, settings.llm_model_strong],
    "polish_essay": [settings.llm_model_strong, settings.llm_model_fast],
}
DEFAULT_ROUTE = [settings.llm_model_fast, settings.llm_model_strong]


class LLMClient:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        on_call: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self.api_key = api_key if api_key is not None else settings.llm_api_key
        self.base_url = base_url or settings.llm_base_url
        self._on_call = on_call

    def route(self, task: str) -> list[str]:
        return TASK_ROUTES.get(task, DEFAULT_ROUTE)

    def complete(
        self,
        task: str,
        prompt: str,
        system: str | None = None,
        temperature: float = 0.0,
        max_tokens: int = 2048,
    ) -> LLMResult:
        if not self.api_key:
            raise LLMUnavailable("未配置 LLM_API_KEY，请走规则兜底")

        errors: list[str] = []
        for model in self.route(task):
            try:
                return self._call_once(model, prompt, system, temperature, max_tokens, task)
            except Exception as exc:  # noqa: BLE001 - 逐个降级
                errors.append(f"{model}: {exc}")
                log.warning("模型调用失败，降级中 model=%s err=%s", model, exc)

        raise LLMUnavailable("全部模型不可用: " + "; ".join(errors))

    @retry(times=settings.llm_max_retries, base_delay=0.5)
    def _call_once(
        self,
        model: str,
        prompt: str,
        system: str | None,
        temperature: float,
        max_tokens: int,
        task: str,
    ) -> LLMResult:
        import time

        try:
            import httpx
        except ImportError as exc:  # pragma: no cover
            raise LLMUnavailable("缺少 httpx 依赖") from exc

        messages: list[dict[str, str]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        started = time.monotonic()
        resp = httpx.post(
            f"{self.base_url.rstrip('/')}/chat/completions",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
            },
            timeout=settings.llm_timeout_s,
        )
        resp.raise_for_status()
        data = resp.json()
        latency = int((time.monotonic() - started) * 1000)

        usage = data.get("usage", {})
        result = LLMResult(
            text=data["choices"][0]["message"]["content"],
            model=model,
            prompt_tokens=usage.get("prompt_tokens", 0),
            output_tokens=usage.get("completion_tokens", 0),
            latency_ms=latency,
        )
        self._emit_log(task, result)
        return result

    def _emit_log(self, task: str, result: LLMResult) -> None:
        if not self._on_call:
            return
        try:
            self._on_call(
                {
                    "caller": "crawler-service",
                    "task": task,
                    "model": result.model,
                    "prompt_tokens": result.prompt_tokens,
                    "output_tokens": result.output_tokens,
                    "latency_ms": result.latency_ms,
                    "success": True,
                }
            )
        except Exception:  # noqa: BLE001 - 计量失败不影响主流程
            log.debug("LLM 计量回调失败", exc_info=True)


default_client = LLMClient()


def route_chain(task: str) -> Iterable[str]:
    return default_client.route(task)
