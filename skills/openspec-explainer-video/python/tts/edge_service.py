"""Edge 在线语音服务：实现 manim-voiceover 的 SpeechService 接口，经 edge-tts 调用微软在线语音合成。

所属：skill openspec-explainer-video。调用方：tts.create_speech_service。
输入：旁白文本；输出：缓存目录中的 mp3 文件与 manim-voiceover 的缓存记录。
协作对象：edge-tts（Communicate）。旁白文本会发送到微软在线服务：只有分镜选择 `tts: edge`
且 render 带 `--allow-online-tts` 时才会走到这里，二次确认由 video.mjs 与 `/opsx:video` 负责。
"""

from __future__ import annotations

from pathlib import Path

from manim_voiceover.helper import remove_bookmarks
from manim_voiceover.services.base import SpeechService


class EdgeService(SpeechService):
    """Edge 语音服务：edge-tts 默认输出 mp3，manim-voiceover 可直接读取时长，无需转码。"""

    def __init__(self, voice: str, **kwargs):
        """
        Args:
            voice: Edge 音色名，如 `zh-CN-XiaoxiaoNeural`。
            **kwargs: 透传给 SpeechService（如 cache_dir）。
        """
        SpeechService.__init__(self, **kwargs)
        self.voice = voice

    def generate_from_text(self, text: str, cache_dir: str = None, path: str = None, **kwargs) -> dict:
        """合成一段旁白，返回 manim-voiceover 的缓存记录。

        Args:
            text: 旁白文本。
            cache_dir: 缓存目录，缺省为构造时传入的目录。
            path: 指定的音频文件名（相对缓存目录），缺省按文本与音色哈希命名。

        Returns:
            dict: `input_text`、`input_data`、`original_audio`（相对缓存目录的 mp3 文件名）。

        Raises:
            RuntimeError: 在线合成失败（网络不可用或服务拒绝），原始异常保留为 __cause__。
        """
        cache_dir = Path(cache_dir or self.cache_dir)
        input_text = remove_bookmarks(text)
        # 缓存键包含音色名：切换音色后不复用旧音频；命中缓存时不再联网。
        input_data = {"input_text": input_text, "service": "edge", "voice": self.voice}
        cached = self.get_cached_result(input_data, cache_dir)
        if cached is not None:
            return cached

        audio_name = path or f"{self.get_audio_basename(input_data)}.mp3"
        audio_path = cache_dir / audio_name
        from edge_tts import Communicate

        try:
            Communicate(input_text, self.voice).save_sync(str(audio_path))
        except Exception as error:
            # 失败时删除写了一半的音频：否则残缺文件留在缓存目录，下次渲染的时长读取会出错。
            audio_path.unlink(missing_ok=True)
            raise RuntimeError(f"Edge 在线语音合成失败（音色 {self.voice}）：检查网络后重试，或改用 tts: piper") from error
        return {"input_text": text, "input_data": input_data, "original_audio": audio_name}
