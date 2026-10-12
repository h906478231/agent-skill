"""Piper 离线语音服务：实现 manim-voiceover 的 SpeechService 接口，旁白文本不离开本机。

所属：skill openspec-explainer-video。调用方：tts.create_speech_service。
输入：旁白文本；输出：缓存目录中的 mp3 文件与 manim-voiceover 的缓存记录。
协作对象：piper-tts（PiperVoice）、pydub（经 ffmpeg 把 wav 转为 mp3）。
"""

from __future__ import annotations

import json
import wave
from pathlib import Path

from manim_voiceover.helper import remove_bookmarks
from manim_voiceover.services.base import SpeechService

# 拼音音素化的音色（如 zh_CN-chaowen-medium）依赖 g2pW 模型，Piper 在模型缺失时会自动联网下载。
# 默认引擎必须离线，所以合成前先检查模型文件，缺失时报错并给出 doctor 的指引，不让 Piper 下载。
PINYIN_PHONEME_TYPE = "pinyin"
G2PW_MODEL = Path("g2pW") / "g2pw.onnx"


class PiperService(SpeechService):
    """Piper 语音服务：wav 合成后转为 mp3。

    manim-voiceover 0.3.7 用 mutagen 按 MP3 格式读取音频时长（modify_audio.get_duration），
    直接返回 wav 会让时长读取失败，所以缓存中只保留 mp3。
    """

    def __init__(self, model_path: Path, data_dir: Path, **kwargs):
        """
        Args:
            model_path: 音色模型 `.onnx` 路径，同目录下须有 `<模型>.onnx.json`。
            data_dir: Piper 资源目录（拼音音色的 g2pW 模型在其下的 `g2pW/`）。
            **kwargs: 透传给 SpeechService（如 cache_dir）。

        Raises:
            FileNotFoundError: 音色模型、配置或 g2pW 模型缺失。
        """
        SpeechService.__init__(self, **kwargs)
        self.model_path = Path(model_path)
        self.data_dir = Path(data_dir)
        config_path = Path(f"{self.model_path}.json")
        if not self.model_path.is_file() or not config_path.is_file():
            raise FileNotFoundError(f"Piper 音色模型缺失：{self.model_path}（及 .json）。运行 video.mjs doctor 查看安装指引")
        phoneme_type = json.loads(config_path.read_text(encoding="utf-8")).get("phoneme_type")
        if phoneme_type == PINYIN_PHONEME_TYPE and not (self.data_dir / G2PW_MODEL).is_file():
            raise FileNotFoundError(f"拼音音色需要的 g2pW 模型缺失：{self.data_dir / G2PW_MODEL}。运行 video.mjs doctor 查看安装指引")
        self._voice = None

    def _load_voice(self):
        """首次合成时才加载模型：缓存全部命中时不加载 onnx 模型。"""
        if self._voice is None:
            from piper import PiperVoice

            self._voice = PiperVoice.load(self.model_path, download_dir=self.data_dir)
        return self._voice

    def generate_from_text(self, text: str, cache_dir: str = None, path: str = None, **kwargs) -> dict:
        """合成一段旁白，返回 manim-voiceover 的缓存记录。

        Args:
            text: 旁白文本。
            cache_dir: 缓存目录，缺省为构造时传入的目录。
            path: 指定的音频文件名（相对缓存目录），缺省按文本与模型哈希命名。

        Returns:
            dict: `input_text`、`input_data`、`original_audio`（相对缓存目录的 mp3 文件名）。
        """
        cache_dir = Path(cache_dir or self.cache_dir)
        input_text = remove_bookmarks(text)
        # 缓存键包含音色模型名：切换音色后不复用旧音频。
        input_data = {"input_text": input_text, "service": "piper", "model": self.model_path.name}
        cached = self.get_cached_result(input_data, cache_dir)
        if cached is not None:
            return cached

        audio_name = path or f"{self.get_audio_basename(input_data)}.mp3"
        wav_path = cache_dir / f"{Path(audio_name).stem}.wav"
        with wave.open(str(wav_path), "wb") as wav_file:
            self._load_voice().synthesize_wav(input_text, wav_file)

        from pydub import AudioSegment

        AudioSegment.from_wav(str(wav_path)).export(str(cache_dir / audio_name), format="mp3")
        wav_path.unlink()
        return {"input_text": text, "input_data": input_data, "original_audio": audio_name}
