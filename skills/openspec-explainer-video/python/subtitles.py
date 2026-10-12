"""讲解视频字幕：由每段旁白与音频时间生成 SRT，并用 ffmpeg 字幕滤镜压入中文硬字幕。

所属：skill openspec-explainer-video。调用方：explainer_scene.py。
输入：段落时间轴 [{start, duration, text}]；输出：`video/explainer.srt` 与 `video/media/<name>.mp4`。
协作对象：ffmpeg（需 libass 字幕滤镜，由 doctor 检查）。
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

# 单条字幕的最大字数：一行放得下、读得完；超过时在标点处拆成多条。
MAX_ENTRY_CHARS = 18
# 子句结束标点：拆分字幕的位置。
CLAUSE_END = re.compile(r"(?<=[。！？；，、：!?;,:])")
# 显示时去掉的条尾标点：字幕行尾的逗号、句号不提供信息，问号与感叹号保留语气。
TRAILING_PUNCT = "，。、；：,.;:"
# 计入时长权重的字符：文字与数字；标点不发音，不分配时长。
SPOKEN_CHAR = re.compile(r"[\w]", re.UNICODE)

# 硬字幕样式（libass force_style）：白字黑边，底部居中；字号按 libass 默认 288 行高的参考分辨率换算。
SUBTITLE_STYLE = "FontSize=16,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1.2,Shadow=0,MarginV=14"


def _weight(text: str) -> int:
    """字幕条的时长权重：发音字符数，至少为 1，避免纯标点条目时长为 0。"""
    return max(1, len(SPOKEN_CHAR.findall(text)))


def split_narration(text: str) -> list[str]:
    """把一段旁白拆成若干条字幕：先按标点切子句，再贪心合并到不超过 MAX_ENTRY_CHARS。

    单个子句超过上限时按上限硬切，保证每条字幕都放得下一行。
    """
    clauses = [clause.strip() for clause in CLAUSE_END.split(" ".join(text.split())) if clause.strip()]
    entries: list[str] = []
    current = ""
    for clause in clauses:
        # 条尾标点显示时会去掉，不计入长度：避免子句恰好超出 1 个字符时把标点单独切成一条。
        while len(clause.rstrip(TRAILING_PUNCT)) > MAX_ENTRY_CHARS:
            if current:
                entries.append(current)
                current = ""
            entries.append(clause[:MAX_ENTRY_CHARS])
            clause = clause[MAX_ENTRY_CHARS:]
        if current and len(current.rstrip(TRAILING_PUNCT)) + len(clause.rstrip(TRAILING_PUNCT)) > MAX_ENTRY_CHARS:
            entries.append(current)
            current = ""
        current += clause
    if current:
        entries.append(current)
    return [entry.rstrip(TRAILING_PUNCT) or entry for entry in entries]


def build_entries(timeline: list[dict]) -> list[dict]:
    """由段落时间轴生成字幕条目：段内按发音字数分配时长，条目首尾相接、按时间递增、互不重叠。

    Args:
        timeline: [{start, duration, text}]，时间单位为秒，按播放顺序排列。

    Returns:
        [{start_ms, end_ms, text}]，整数毫秒；每条的结束时间不晚于下一条的开始时间。
    """
    entries: list[dict] = []
    for segment in timeline:
        start_ms = round(segment["start"] * 1000)
        duration_ms = round(segment["duration"] * 1000)
        parts = split_narration(segment["text"])
        total = sum(_weight(part) for part in parts)
        # 用累计权重求边界（而不是逐条累加时长），避免舍入误差让最后一条越过段尾。
        cumulative = 0
        for part in parts:
            begin = start_ms + round(duration_ms * cumulative / total)
            cumulative += _weight(part)
            end = start_ms + round(duration_ms * cumulative / total)
            entries.append({"start_ms": begin, "end_ms": end, "text": part})
    # 防御：段与段之间理论上不会重叠（下一段在旁白结束后才开始），仍按下一条的开始时间截断。
    for current, following in zip(entries, entries[1:]):
        current["end_ms"] = min(current["end_ms"], following["start_ms"])
    return entries


def _timestamp(ms: int) -> str:
    """SRT 时间戳 `HH:MM:SS,mmm`。"""
    hours, rest = divmod(ms, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    seconds, millis = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def write_srt(entries: list[dict], srt_path: Path) -> None:
    """按 SRT 格式写入字幕文件（UTF-8、LF 换行）。"""
    blocks = [
        f"{index}\n{_timestamp(entry['start_ms'])} --> {_timestamp(entry['end_ms'])}\n{entry['text']}\n"
        for index, entry in enumerate(entries, start=1)
    ]
    srt_path.parent.mkdir(parents=True, exist_ok=True)
    srt_path.write_text("\n".join(blocks), encoding="utf-8", newline="\n")


def burn_subtitles(raw_video: Path, srt_path: Path, output: Path, font: str) -> None:
    """用 ffmpeg 字幕滤镜把 SRT 压入视频。

    字幕滤镜的文件名参数要转义 `:`、`'`、`\\` 等字符；先把 SRT 复制到输出目录，
    在该目录下以固定短文件名引用，避免路径中的特殊字符破坏滤镜表达式。

    Raises:
        RuntimeError: 找不到 ffmpeg 或 ffmpeg 返回非零退出码（stderr 原样附在异常中）。
    """
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("找不到 ffmpeg。运行 video.mjs doctor 查看安装指引")
    work_dir = output.parent
    local_srt = work_dir / "subtitles.srt"
    shutil.copyfile(srt_path, local_srt)
    style = f"FontName={font},{SUBTITLE_STYLE}"
    command = [
        ffmpeg, "-y", "-loglevel", "error",
        "-i", str(raw_video),
        "-vf", f"subtitles={local_srt.name}:charenc=UTF-8:force_style='{style}'",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "copy",
        output.name,
    ]
    result = subprocess.run(command, cwd=work_dir, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg 压制字幕失败（退出码 {result.returncode}）：{result.stderr.strip()}")
