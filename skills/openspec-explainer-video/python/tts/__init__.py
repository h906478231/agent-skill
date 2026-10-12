"""讲解视频的 TTS 引擎接口：按分镜 `tts` 字段创建 manim-voiceover 语音服务。

所属：skill openspec-explainer-video。调用方：explainer_scene.py。
引擎取值与在线确认规则的事实源：shared/storyboard.md、SKILL.md（本包只实现引擎，不做确认）。
新增引擎：实现 manim-voiceover 的 SpeechService，并在 ENGINES 中登记；在线引擎须同时在 video.mjs 的
ONLINE_ENGINES 中登记，render 才会要求 `--allow-online-tts`。
"""

from __future__ import annotations

from pathlib import Path


def create_speech_service(engine: str, cache_dir: Path, options: dict):
    """创建语音服务。

    Args:
        engine: 分镜中的 `tts` 取值：`piper`（离线，默认）或 `edge`（在线）。
        cache_dir: 音频缓存目录，必须位于 `video/media/` 之下，保证音频不进 git。
        options: video.mjs 传入的引擎参数（如 Piper 音色模型路径、edge 音色名）。

    Returns:
        manim-voiceover 的 SpeechService 实例。

    Raises:
        ValueError: 引擎名不在支持范围内（分镜检查已拦截，这里是防御）。
    """
    # 延迟导入：只加载被选中的引擎，未选中的引擎缺少依赖时不影响渲染。
    if engine == "piper":
        from .piper_service import PiperService

        return PiperService(
            model_path=Path(options["piperModel"]),
            data_dir=Path(options["piperDataDir"]),
            cache_dir=str(cache_dir),
        )
    if engine == "edge":
        from .edge_service import EdgeService

        return EdgeService(voice=options["edgeVoice"], cache_dir=str(cache_dir))
    raise ValueError(f"不支持的 TTS 引擎：{engine}")
