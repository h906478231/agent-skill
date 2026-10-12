"""讲解视频的固定场景运行器：读取分镜与并集布局 JSON，用 Manim Community 渲染带配音与中文硬字幕的视频。

所属：skill openspec-explainer-video。调用方：scripts/video.mjs render（经 `uv run --frozen`）。
AI 不为变更编写 Manim 代码，只编写分镜数据；本运行器按镜头动作表渲染（design 决策 3，动作表见 shared/storyboard.md）。
输入：`--input <json>`，由 video.mjs 生成：分镜（已通过检查与签署）、change-model.mjs layout 的并集布局、字体、TTS 参数与输出路径。
   加 `--demo` 时忽略分镜与布局，渲染固定两段旁白的环境自检视频。
输出：`<mediaDir>/<outputName>.mp4`（硬字幕）、`srtPath`（SRT），并在 stdout 最后一行输出结果 JSON。
约束：深色背景；只用 Text 与几何对象，不用 LaTeX；元素坐标取自布局 JSON，三个视图共用同一套坐标。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

# 本文件所在目录加入 sys.path：以脚本方式运行时可以导入同目录的 tts 包与 subtitles 模块。
sys.path.insert(0, str(Path(__file__).resolve().parent))

from manim import (  # noqa: E402
    DOWN, LEFT, ORIGIN, RIGHT, UP,
    AnimationGroup, Arrow, Create, DashedVMobject, Dot, FadeIn, FadeOut, GrowArrow, GrowFromCenter,
    FadeTransform, LaggedStart, MoveAlongPath, MovingCameraScene, Polygon, RoundedRectangle, Succession,
    Text, TracedPath, VGroup, VMobject, Write, config, there_and_back,
)
from manim_voiceover import VoiceoverScene  # noqa: E402

from subtitles import build_entries, burn_subtitles, write_srt  # noqa: E402
from tts import create_speech_service  # noqa: E402

# ---------------------------------------------------------------------------
# 风格：3Blue1Brown 风格配色（取自 Manim 默认调色板），深色背景、浅色文字。
# ---------------------------------------------------------------------------
BACKGROUND = "#14161B"
TEXT_COLOR = "#ECECEC"
MUTED_TEXT = "#9AA0A6"
# 变更前 / 变更后视图的中性色：节点蓝色描边，连线浅灰。
NEUTRAL = "#58C4DD"
EDGE_NEUTRAL = "#BBBBBB"
# 对比视图的变动配色，与 overview.html 的图例一致：新增绿色、修改黄色、删除红色虚线。
DIFF_COLORS = {"unchanged": NEUTRAL, "added": "#83C167", "changed": "#F7D96F", "removed": "#FC6255"}
EDGE_DIFF_COLORS = {**DIFF_COLORS, "unchanged": EDGE_NEUTRAL}
# highlight 与 trace 的强调色。
HIGHLIGHT = "#FFFF00"

VIEW_NAMES = {"before": "变更前", "diff": "对比", "after": "变更后"}

# ---------------------------------------------------------------------------
# 画面布局（Manim 单位，画面 16:9，宽约 14.2、高 8）：顶部放主题与图名，底部留给硬字幕。
# ---------------------------------------------------------------------------
TOP_BAND = 1.35
BOTTOM_BAND = 1.25
SIDE_MARGIN = 0.5
TITLE_FONT_SIZE = 30
LABEL_FONT_SIZE = 20

# 布局 JSON 中汉字的宽度（像素，与 change-model.mjs 的 SIZE.WIDE_CHAR 一致）：用来标定字号。
# 折行不在这里做：布局 JSON 的 lines / beforeLines 已按同一规则折好，直接按行绘制。
WIDE_CHAR_PX = 14
STATE_RADIUS_PX = 8
STEP_RADIUS_PX = 4
FINAL_INSET_PX = 3
DECISION_EXTRA_PX = 24
START_RADIUS_PX = 5
TIP_PX = 9

# 镜头动作时长：一段的动作平分旁白时长的 90%，单个动作限制在 0.8～3 秒；旁白更长时停在最后画面等待旁白结束。
ACTION_SHARE = 0.9
MIN_ACTION_SECONDS = 0.8
MAX_ACTION_SECONDS = 3.0
# focus 推近时包围框四周的留白倍数，以及推近后画面的最小宽度（避免放大过度）。
FOCUS_PADDING = 1.8
FOCUS_MIN_WIDTH = 3.5

# 原始画面（未压字幕）的文件名后缀：最终视频在压入字幕后另存为 outputName。
RAW_SUFFIX = "_raw"


def before_value(item: dict, key: str):
    """字段的变更前取值：before 中写了该字段（含 null）取旧值，否则与当前值相同。"""
    before = item.get("before") or {}
    return before[key] if key in before else item.get(key)


# ---------------------------------------------------------------------------
# 图：一个状态机或流程的元素、视图状态与图形构建
# ---------------------------------------------------------------------------
class Diagram:
    """一张图（状态机或流程）：把布局像素坐标映射到画面，按视图给出每个元素的显示状态并构建图形。

    元素键：节点为 `node:<id>`，连线为 `edge:<id>`（迁移 ID、旧路线 `<id>@before`、流程连线 `<from>-><to>`）。
    视图之间元素坐标不变，只改变是否显示、颜色、虚实与文字，所以 morph 时共有元素不移动。
    """

    def __init__(self, data: dict, kind: str, font: str):
        self.id = data["id"]
        self.name = data["name"]
        self.kind = kind
        self.font = font
        self.nodes = {node["id"]: node for node in data["nodes"]}
        self.edges = {edge["id"]: edge for edge in data["edges"]}
        # 改了端点的迁移：变更前视图显示旧路线 `<id>@before`，不显示当前路线。
        self.moved = {edge["of"] for edge in data["edges"] if edge.get("route") == "before"}
        width, height = max(data["width"], 1), max(data["height"], 1)
        area_width = config.frame_width - SIDE_MARGIN * 2
        area_height = config.frame_height - TOP_BAND - BOTTOM_BAND
        self.scale = min(area_width / width, area_height / height)
        self.origin = np.array([-width * self.scale / 2, (config.frame_height / 2 - TOP_BAND + (-config.frame_height / 2 + BOTTOM_BAND)) / 2 + height * self.scale / 2, 0])
        self._font_scale = None

    # 坐标与文字 -------------------------------------------------------------
    def point(self, x: float, y: float) -> np.ndarray:
        """布局像素坐标（原点左上、y 向下）→ 画面坐标（y 向上）。"""
        return self.origin + np.array([x * self.scale, -y * self.scale, 0])

    def text(self, lines: tuple, color: str, px: float = WIDE_CHAR_PX) -> Text:
        """按布局 JSON 已折好的文字行生成文字：汉字宽度对齐布局的 14px，保证文字放得进节点。"""
        if self._font_scale is None:
            # 以 4 个汉字的实际宽度标定字号：不同字体的字宽不同，标定后与布局尺寸一致。
            sample = Text("汉字宽度", font=self.font, font_size=48)
            self._font_scale = 48 * self.scale / (sample.width / 4)
        font_size = self._font_scale * px * 0.9
        return Text("\n".join(lines), font=self.font, font_size=font_size, color=color, line_spacing=0.6)

    # 视图状态 ---------------------------------------------------------------
    def node_state(self, node: dict, view: str):
        """节点在视图中的显示状态；不显示时返回 None。状态元组同时作为 morph 的比较依据。"""
        diff = node.get("diff", "unchanged")
        if (view == "before" and diff == "added") or (view == "after" and diff == "removed"):
            return None
        old = view == "before"
        return (
            tuple(node["beforeLines"] if old else node["lines"]),
            DIFF_COLORS[diff] if view == "diff" else NEUTRAL,
            view == "diff" and diff == "removed",
            (before_value(node, "kind") if old else node.get("kind")) == "decision",
            bool(before_value(node, "initial") if old else node.get("initial")),
            bool(before_value(node, "final") if old else node.get("final")),
        )

    def edge_state(self, edge: dict, view: str):
        """连线在视图中的显示状态；不显示时返回 None。"""
        diff = edge.get("diff", "unchanged")
        if edge.get("route") == "before":
            # 旧路线：变更前视图按中性色显示，对比视图按删除样式显示，变更后视图不显示。
            if view == "after":
                return None
            return (tuple(edge["lines"]), EDGE_DIFF_COLORS["removed"] if view == "diff" else EDGE_NEUTRAL, view == "diff")
        if view == "before" and (diff == "added" or edge["id"] in self.moved):
            return None
        if view == "after" and diff == "removed":
            return None
        lines = tuple(edge["beforeLines"] if view == "before" else edge["lines"])
        return (lines, EDGE_DIFF_COLORS[diff] if view == "diff" else EDGE_NEUTRAL, view == "diff" and diff == "removed")

    def states(self, view: str) -> dict:
        """视图中全部显示元素：元素键 → 显示状态。"""
        result = {}
        for node in self.nodes.values():
            state = self.node_state(node, view)
            if state is not None:
                result[f"node:{node['id']}"] = state
        for edge in self.edges.values():
            state = self.edge_state(edge, view)
            if state is not None:
                result[f"edge:{edge['id']}"] = state
        return result

    # 图形构建 ---------------------------------------------------------------
    def build(self, key: str, state: tuple):
        """按元素键与显示状态构建图形。"""
        kind, element_id = key.split(":", 1)
        return self._node(self.nodes[element_id], state) if kind == "node" else self._edge(self.edges[element_id], state)

    def _node(self, node: dict, state: tuple) -> VGroup:
        name, color, dashed, decision, initial, final = state
        s = self.scale
        x, y, w, h = node["x"], node["y"], node["width"], node["height"]
        center = self.point(x + w / 2, y + h / 2)
        if decision:
            # 判断步骤画成六边形：两端尖角各占 DECISION_EXTRA 的一半。
            tip = DECISION_EXTRA_PX / 2
            corners = [(x, y + h / 2), (x + tip, y), (x + w - tip, y), (x + w, y + h / 2), (x + w - tip, y + h), (x + tip, y + h)]
            shape = Polygon(*[self.point(px, py) for px, py in corners])
        else:
            radius = STATE_RADIUS_PX if self.kind == "machine" else STEP_RADIUS_PX
            shape = RoundedRectangle(width=w * s, height=h * s, corner_radius=min(radius * s, h * s / 2)).move_to(center)
        shape.set_stroke(color, width=3).set_fill(BACKGROUND, opacity=1)
        parts = [DashedVMobject(shape, num_dashes=24).set_stroke(color, width=3) if dashed else shape]
        if final:
            inner = RoundedRectangle(width=(w - FINAL_INSET_PX * 2) * s, height=(h - FINAL_INSET_PX * 2) * s,
                                     corner_radius=max(STATE_RADIUS_PX - FINAL_INSET_PX, 1) * s).move_to(center)
            parts.append(inner.set_stroke(color, width=1.5))
        if initial:
            # 初始状态：左侧实心圆点加一段短线指向节点。
            start = self.point(x - START_RADIUS_PX * 4, y + h / 2)
            parts.append(Dot(start, radius=START_RADIUS_PX * s, color=color))
            parts.append(VMobject().set_points_as_corners([start, self.point(x, y + h / 2)]).set_stroke(color, width=2))
        label = self.text(name, TEXT_COLOR).move_to(center)
        if label.width > w * s * 0.92:
            label.scale_to_fit_width(w * s * 0.92)
        parts.append(label)
        return VGroup(*parts)

    def _edge(self, edge: dict, state: tuple) -> VGroup:
        text, color, dashed = state
        points = [self.point(p["x"], p["y"]) for p in edge["points"]]
        path = VMobject().set_points_as_corners(points).set_stroke(color, width=2.5)
        line = DashedVMobject(path, num_dashes=max(6, int(path.get_arc_length() / 0.12))).set_stroke(color, width=2.5) if dashed else path
        # 箭头：终点处的实心三角形，方向取最后一段折线。
        end, prev = points[-1], points[-2]
        direction = (end - prev) / (np.linalg.norm(end - prev) or 1)
        normal = np.array([-direction[1], direction[0], 0])
        length = TIP_PX * self.scale
        base = end - direction * length
        tip = Polygon(end, base + normal * length * 0.5, base - normal * length * 0.5).set_stroke(color, width=1).set_fill(color, opacity=1)
        parts = [line, tip]
        box = edge.get("labelBox")
        if text and box:
            label = self.text(text, MUTED_TEXT if not dashed else color, px=WIDE_CHAR_PX * 0.85)
            # 字体的半角字宽与布局的 8px 不完全一致：超出标签框时缩小，避免压到相邻节点与连线（与节点文字的兜底相同）。
            if label.width > box["width"] * self.scale:
                label.scale_to_fit_width(box["width"] * self.scale)
            label.move_to(self.point(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2))
            parts.append(label)
        return VGroup(*parts)

    def link_points(self, source: str, target: str):
        """trace 的一跳：取 source → target 的连线路径点（优先当前路线，其次旧路线）。"""
        candidates = [edge for edge in self.edges.values() if edge["from"] == source and edge["to"] == target]
        candidates.sort(key=lambda edge: edge.get("route") == "before")
        return [self.point(p["x"], p["y"]) for p in candidates[0]["points"]] if candidates else None


# ---------------------------------------------------------------------------
# 场景
# ---------------------------------------------------------------------------
class NarratedScene(VoiceoverScene, MovingCameraScene):
    """带旁白的场景基类：记录段落时间轴（字幕由时间轴生成），不使用 manim-voiceover 的字幕拆分（它按空格拆，不适合中文）。"""

    def __init__(self, spec: dict, **kwargs):
        self.spec = spec
        self.timeline: list[dict] = []
        super().__init__(**kwargs)

    def setup_voice(self) -> None:
        """按分镜的 TTS 引擎创建语音服务；音频缓存在 video/media/voiceovers/。"""
        tts = self.spec["tts"]
        self.set_speech_service(create_speech_service(tts["engine"], Path(self.spec["mediaDir"]) / "voiceovers", tts),
                                create_subcaption=False)

    def record(self, tracker, text: str) -> None:
        """记录段落时间轴：开始时间取旁白开始时刻，时长取旁白音频时长。"""
        self.timeline.append({"start": tracker.start_t, "duration": tracker.duration, "text": text})


class DemoScene(NarratedScene):
    """环境自检场景：固定两段旁白与固定图形，验证配音驱动时长、中文字体与字幕压制。"""

    NARRATIONS = (
        "这是讲解视频的环境自检。画面中是一个已支付状态。",
        "接下来新增退款中状态，并用箭头连接两个状态。",
    )

    def construct(self):
        self.setup_voice()
        font = self.spec["font"]
        paid = VGroup(RoundedRectangle(corner_radius=0.15, width=2.6, height=1.0, color=NEUTRAL),
                      Text("已支付", font=font, font_size=34, color=TEXT_COLOR)).shift(LEFT * 3)
        refunding = VGroup(RoundedRectangle(corner_radius=0.15, width=2.6, height=1.0, color=DIFF_COLORS["added"]),
                           Text("退款中", font=font, font_size=34, color=TEXT_COLOR)).shift(RIGHT * 3)
        arrow = Arrow(paid.get_right(), refunding.get_left(), color=DIFF_COLORS["added"], buff=0.15)
        with self.voiceover(text=self.NARRATIONS[0]) as tracker:
            self.record(tracker, self.NARRATIONS[0])
            self.play(Create(paid[0]), Write(paid[1]), run_time=min(2.0, tracker.duration))
        with self.voiceover(text=self.NARRATIONS[1]) as tracker:
            self.record(tracker, self.NARRATIONS[1])
            self.play(FadeIn(refunding, shift=UP * 0.2), run_time=min(1.5, tracker.duration / 2))
            self.play(GrowArrow(arrow), run_time=min(1.5, tracker.duration / 2))


class ExplainerScene(NarratedScene):
    """分镜驱动的讲解场景：每段旁白放在一个 voiceover 块中，块内按顺序执行镜头动作。

    画面状态：当前图（diagram）、当前视图（view）、屏幕上的元素（元素键 → 图形）。
    """

    def construct(self):
        self.setup_voice()
        layout = self.spec["layout"]
        font = self.spec["font"]
        self.diagrams = {item["id"]: Diagram(item, "machine", font) for item in layout["machines"]}
        self.diagrams.update({item["id"]: Diagram(item, "flow", font) for item in layout["flows"]})
        self.diagram = None
        self.view = None
        self.on_screen: dict = {}
        self.view_label = None
        self.zoomed = False
        storyboard = self.spec["storyboard"]
        title = Text(storyboard["focus"], font=font, font_size=TITLE_FONT_SIZE, color=TEXT_COLOR)
        title.to_edge(UP, buff=0.3)
        if title.width > config.frame_width - SIDE_MARGIN * 2:
            title.scale_to_fit_width(config.frame_width - SIDE_MARGIN * 2)
        self.title = title
        self.add(title)
        for segment in storyboard["segments"]:
            with self.voiceover(text=segment["narration"]) as tracker:
                self.record(tracker, segment["narration"])
                actions = segment["actions"]
                if not actions:
                    continue
                # 动作平分旁白时长；旁白更长时由 voiceover 块在结尾等待，动画不会在旁白结束前被截断。
                budget = min(MAX_ACTION_SECONDS, max(MIN_ACTION_SECONDS, tracker.duration * ACTION_SHARE / len(actions)))
                for action in actions:
                    (name, value), = action.items()
                    getattr(self, f"do_{name}")(value, budget)

    # 画面状态 ---------------------------------------------------------------
    def _label(self, diagram: Diagram, view: str) -> Text:
        label = Text(f"{diagram.name} · {VIEW_NAMES[view]}", font=diagram.font, font_size=LABEL_FONT_SIZE, color=MUTED_TEXT)
        return label.next_to(self.title, DOWN, buff=0.15)

    def _reset_camera(self):
        """focus 推近之后，show 与 morph 先恢复全图。"""
        if self.zoomed:
            self.zoomed = False
            return [self.camera.frame.animate.move_to(ORIGIN).set(width=config.frame_width)]
        return []

    def _draw(self, diagram: Diagram, view: str, run_time: float) -> None:
        """清空画面并绘制一张图的指定视图：节点先出现，连线随后。"""
        leaving = [*self.on_screen.values(), *([self.view_label] if self.view_label else [])]
        if leaving:
            self.play(*[FadeOut(item) for item in leaving], *self._reset_camera(), run_time=min(0.6, run_time / 3))
        self.diagram, self.view = diagram, view
        states = diagram.states(view)
        self.on_screen = {key: diagram.build(key, state) for key, state in states.items()}
        self.view_label = self._label(diagram, view)
        nodes = [mob for key, mob in self.on_screen.items() if key.startswith("node:")]
        edges = [mob for key, mob in self.on_screen.items() if key.startswith("edge:")]
        # 连线放在节点下层：节点有背景色填充，连线端点不会压在节点文字上。
        for mob in edges:
            mob.set_z_index(0)
        for mob in nodes:
            mob.set_z_index(1)
        self.play(FadeIn(self.view_label),
                  LaggedStart(*[AnimationGroup(Create(mob[0]), FadeIn(VGroup(*mob[1:]))) for mob in nodes], lag_ratio=0.15),
                  run_time=run_time * 0.6)
        if edges:
            self.play(LaggedStart(*[AnimationGroup(Create(mob[0]), FadeIn(VGroup(*mob[1:]))) for mob in edges], lag_ratio=0.1),
                      run_time=run_time * 0.4)

    def _ensure(self, target: str, run_time: float) -> float:
        """trace 前确保目标图在画面上（沿用当前视图，没有时用变更后视图）；返回剩余的动作时长。"""
        if self.diagram is not None and self.diagram.id == target:
            return run_time
        self._draw(self.diagrams[target], self.view or "after", run_time / 2)
        return run_time / 2

    def _find(self, element_id: str) -> list:
        """当前画面中与元素 ID 对应的图形：节点、迁移或连线，以及迁移的旧路线。"""
        keys = [f"node:{element_id}", f"edge:{element_id}", f"edge:{element_id}@before"]
        return [self.on_screen[key] for key in keys if key in self.on_screen]

    def _in_frame(self, mobs: list) -> bool:
        """图形是否都在当前镜头画面内：focus 推近后判断后续动作的元素是否可见。"""
        if not mobs:
            return True
        frame, group = self.camera.frame, VGroup(*mobs)
        return (group.get_left()[0] >= frame.get_left()[0] and group.get_right()[0] <= frame.get_right()[0]
                and group.get_bottom()[1] >= frame.get_bottom()[1] and group.get_top()[1] <= frame.get_top()[1])

    def _reveal(self, mobs: list, run_time: float) -> float:
        """focus 推近后，后续动作的元素不在画面内时先恢复全图；返回剩余的动作时长。

        不恢复时 trace 的光点或 highlight 的描边会落在镜头外，旁白讲到的内容观众看不到。
        """
        if not self.zoomed or self._in_frame(mobs):
            return run_time
        reset_time = min(0.6, run_time / 4)
        self.play(*self._reset_camera(), run_time=reset_time)
        return run_time - reset_time

    # 镜头动作 ---------------------------------------------------------------
    def do_show(self, value: dict, run_time: float) -> None:
        """show：当前图不同时重画；同一张图换视图时按 morph 过渡（共有元素不动）。"""
        if self.diagram is not None and self.diagram.id == value["target"]:
            if self.view != value["view"] or self.zoomed:
                self._morph(value["view"], run_time)
            return
        self._draw(self.diagrams[value["target"]], value["view"], run_time)

    def do_morph(self, value: dict, run_time: float) -> None:
        """morph：先确保画面是目标图的 from 视图，再过渡到 to 视图。"""
        if self.diagram is None or self.diagram.id != value["target"] or self.view != value["from"]:
            if self.diagram is not None and self.diagram.id == value["target"]:
                self._morph(value["from"], run_time / 3)
            else:
                self._draw(self.diagrams[value["target"]], value["from"], run_time / 3)
            run_time = run_time * 2 / 3
        self._morph(value["to"], run_time)

    def _morph(self, view: str, run_time: float) -> None:
        """视图过渡：显示状态相同的元素不动；状态变化的元素原地变色、换虚实或换字；只在一侧出现的元素淡入或淡出。"""
        diagram = self.diagram
        before_states = diagram.states(self.view)
        after_states = diagram.states(view)
        animations = [*self._reset_camera()]
        for key in set(before_states) | set(after_states):
            old_state, new_state = before_states.get(key), after_states.get(key)
            if old_state == new_state:
                continue
            if new_state is None:
                animations.append(FadeOut(self.on_screen.pop(key)))
            elif old_state is None:
                mob = diagram.build(key, new_state).set_z_index(1 if key.startswith("node:") else 0)
                self.on_screen[key] = mob
                animations.append(FadeIn(mob))
            else:
                # 原地交叉淡化：坐标相同，只换颜色、虚实或文字；逐点形变会让文字笔画与虚线在过渡中扭曲。
                mob = diagram.build(key, new_state).set_z_index(1 if key.startswith("node:") else 0)
                animations.append(FadeTransform(self.on_screen[key], mob))
                self.on_screen[key] = mob
        new_label = self._label(diagram, view)
        animations.append(FadeTransform(self.view_label, new_label))
        self.view_label = new_label
        self.view = view
        self.play(*animations, run_time=run_time)

    @staticmethod
    def _pulse(mob, flashes: int):
        """描边闪烁：在元素外形上叠加强调色粗描边并闪烁若干次，同时轻微放大再复原。

        不用 Indicate：它会连同节点的背景填充一起染色，把节点整块涂成强调色、遮住文字。
        """
        outline = mob[0].copy().set_fill(opacity=0).set_stroke(HIGHLIGHT, width=7).set_z_index(mob.z_index + 1)
        blinks = [Succession(FadeIn(outline), FadeOut(outline)) for _ in range(flashes)]
        return AnimationGroup(Succession(*blinks), mob.animate(rate_func=there_and_back).scale(1.08))

    def do_highlight(self, ids: list, run_time: float) -> None:
        """highlight：放大描边并闪烁两次。"""
        mobs = [mob for element_id in ids for mob in self._find(element_id)]
        if not mobs:
            self.wait(run_time)
            return
        run_time = self._reveal(mobs, run_time)
        self.play(*[self._pulse(mob, 2) for mob in mobs], run_time=run_time)

    def do_trace(self, value: dict, run_time: float) -> None:
        """trace：光点沿布局折线逐跳移动，留下短暂高亮轨迹，到达的节点闪一下。"""
        run_time = self._ensure(value["target"], run_time)
        diagram = self.diagram
        hops = list(zip(value["path"], value["path"][1:]))
        run_time = self._reveal([mob for node_id in value["path"] for mob in self._find(node_id)], run_time)
        dot = Dot(radius=0.09, color=HIGHLIGHT).set_z_index(3)
        glow = Dot(radius=0.2, color=HIGHLIGHT, fill_opacity=0.25).set_z_index(2)
        glow.add_updater(lambda mob: mob.move_to(dot))
        first = diagram.link_points(*hops[0])
        dot.move_to(first[0])
        glow.move_to(first[0])
        self.play(GrowFromCenter(dot), FadeIn(glow), run_time=min(0.3, run_time / 5))
        hop_time = run_time * 0.8 / len(hops)
        trails = []
        for source, target in hops:
            path = VMobject().set_points_as_corners(diagram.link_points(source, target))
            # 直接复制布局折线作为轨迹；TracedPath 在快速经过直角时会跨采样点连成斜线。
            trail = path.copy().set_stroke(HIGHLIGHT, width=4).set_z_index(2)
            trails.append(trail)
            landing = [self._pulse(mob, 1) for mob in self._find(target)]
            movement = AnimationGroup(MoveAlongPath(dot, path), Create(trail))
            self.play(Succession(movement, AnimationGroup(*landing)) if landing else movement, run_time=hop_time)
        glow.clear_updaters()
        self.play(FadeOut(dot), FadeOut(glow), *[FadeOut(trail) for trail in trails],
                  run_time=min(0.3, run_time / 5))

    def do_focus(self, ids: list, run_time: float) -> None:
        """focus：镜头推近到元素包围框；下一个 show 或 morph 恢复全图，后续动作的元素在画面外时也先恢复。"""
        mobs = [mob for element_id in ids for mob in self._find(element_id)]
        if not mobs:
            self.wait(run_time)
            return
        group = VGroup(*mobs)
        aspect = config.frame_width / config.frame_height
        width = max(group.width * FOCUS_PADDING, group.height * FOCUS_PADDING * aspect, FOCUS_MIN_WIDTH)
        self.zoomed = True
        self.play(self.camera.frame.animate.move_to(group.get_center()).set(width=width), run_time=run_time)


def render(scene_class, spec: dict) -> dict:
    """渲染场景、生成 SRT 并压入硬字幕。

    Args:
        scene_class: 场景类（DemoScene 或 ExplainerScene）。
        spec: 输入参数（见模块说明）。

    Returns:
        结果字典：最终视频、SRT 路径、实际时长（秒）与字幕条数。
    """
    media_dir = Path(spec["mediaDir"])
    media_dir.mkdir(parents=True, exist_ok=True)
    output_name = spec.get("outputName", "explainer")
    # Manim 的全部缓存与中间产物都写入 media_dir（即 video/media/），保证二进制文件不进 git。
    config.media_dir = str(media_dir)
    config.quality = spec.get("quality", "medium_quality")
    config.output_file = f"{output_name}{RAW_SUFFIX}"
    config.background_color = BACKGROUND
    config.progress_bar = "none"
    config.verbosity = "WARNING"

    scene = scene_class(spec)
    scene.render()
    raw_video = Path(scene.renderer.file_writer.movie_file_path)
    entries = build_entries(scene.timeline)
    srt_path = Path(spec["srtPath"])
    write_srt(entries, srt_path)
    output = media_dir / f"{output_name}.mp4"
    burn_subtitles(raw_video, srt_path, output, spec["font"])
    return {"video": str(output), "srt": str(srt_path), "duration": round(scene.renderer.time, 2), "subtitles": len(entries)}


def main() -> int:
    """命令行入口：解析参数并渲染；结果 JSON 输出到 stdout 最后一行，供 video.mjs 读取。"""
    parser = argparse.ArgumentParser(description="OpenSpec 讲解视频场景运行器")
    parser.add_argument("--input", required=True, help="video.mjs 生成的输入 JSON 文件")
    parser.add_argument("--demo", action="store_true", help="忽略分镜，渲染固定两段旁白的环境自检视频")
    args = parser.parse_args()
    spec = json.loads(Path(args.input).read_text(encoding="utf-8"))
    result = render(DemoScene if args.demo else ExplainerScene, spec)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
