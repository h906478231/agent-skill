#!/usr/bin/env python3
"""Check the Flows skill release once per local calendar day (macOS/Windows/Linux)."""

from contextlib import contextmanager
import datetime
import errno
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import tempfile
import zipfile

if os.name == "nt":
    import msvcrt
else:
    import fcntl


PLUGIN_ID = "plugin_9e3e79e5-b8f7-44dd-9a62-f8ef7cea799b"
# Marketplace version of this package; advance when publishing.
BASE_VERSION = 7
WINDOWS_RESERVED_NAMES = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"} | {
    prefix + number for prefix in ("COM", "LPT") for number in "123456789¹²³"
}


def cli(*args):
    executable = shutil.which("flows-cli")
    if executable is None:
        raise FileNotFoundError("PATH 中未找到 flows-cli")
    result = subprocess.run(
        [executable, "--json", *args], capture_output=True, text=True,
        encoding="utf-8", timeout=25
    )
    if result.returncode:
        raise RuntimeError("flows-cli 请求失败")
    response = json.loads(result.stdout)
    if response.get("ok") is not True:
        raise RuntimeError("云舟返回失败")
    return response["data"]


@contextmanager
def daily_lock(path):
    with path.open("a+b") as lock:
        # Windows locks a byte range; keep byte zero present and seek before locking.
        if os.name == "nt" and os.fstat(lock.fileno()).st_size == 0:
            lock.write(b"\0")
            lock.flush()
        lock.seek(0)
        try:
            if os.name == "nt":
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                raise
            yield False
            return
        try:
            yield True
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)


def save_state(path, state):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)


def unpack(package, destination):
    with zipfile.ZipFile(package) as archive:
        entries = archive.infolist()
        if len(entries) > 1000 or sum(item.file_size for item in entries) > 20_000_000:
            raise ValueError("插件包超出大小限制")
        names = set()
        for item in entries:
            path = PurePosixPath(item.filename)
            kind = stat.S_IFMT(item.external_attr >> 16)
            if (not path.parts or path.parts[0] != "flows-role-comment"
                    or path.is_absolute() or ".." in path.parts
                    or "\\" in item.filename or ":" in item.filename
                    or any(part.split(".", 1)[0].rstrip(" ").upper() in WINDOWS_RESERVED_NAMES
                           for part in path.parts)
                    or any(part.endswith((".", " ")) for part in path.parts)
                    or any(ord(char) < 32 or char in '<>"|?*' for char in item.filename)
                    or kind not in (0, stat.S_IFREG, stat.S_IFDIR)
                    or str(path).casefold() in names):
                raise ValueError("插件包包含不安全或重复路径")
            names.add(str(path).casefold())
        archive.extractall(destination)
    root = destination / "flows-role-comment"
    for required in ("SKILL.md", "agents/openai.yaml", "scripts/check_update.py"):
        if not (root / required).is_file():
            raise ValueError("插件包缺少必要文件")
    text = (root / "SKILL.md").read_text(encoding="utf-8")
    if not text.startswith("---\n") or "\nname: flows-role-comment\n" not in text.split("\n---", 1)[0]:
        raise ValueError("插件包技能名称不匹配")
    compile((root / "scripts/check_update.py").read_text(encoding="utf-8"), "check_update.py", "exec")
    return root


def install(package, skill_dir, cache_dir):
    # Keep a full backup before replacing the directory, including local edits.
    backup = cache_dir / ("backup-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
    with tempfile.TemporaryDirectory(prefix=".flows-role-comment-", dir=skill_dir.parent) as temporary:
        root = unpack(package, Path(temporary))
        shutil.copytree(skill_dir, backup, symlinks=True)
        old = Path(temporary) / "previous"
        os.replace(skill_dir, old)
        try:
            os.replace(root, skill_dir)
        except BaseException:
            os.replace(old, skill_dir)
            raise
    return str(backup)


def check(skill_dir, cache_dir, today=None):
    today = today or datetime.date.today().isoformat()
    cache_dir.mkdir(parents=True, exist_ok=True)
    with daily_lock(cache_dir / "lock") as acquired:
        if not acquired:
            return {"status": "busy"}
        state_path = cache_dir / "state.json"
        state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
        if state.get("checked_date") == today:
            return {"status": "checked_today"}
        # Record the attempt too: a failed network check must not repeat all day.
        state["checked_date"] = today
        save_state(state_path, state)
        versions = cli("plugin", "get", "--plugin-id", PLUGIN_ID)["versions"]
        latest = max(versions, key=lambda item: item["versionNumber"])
        version = latest["versionNumber"]
        if type(version) is not int or version < 1:
            raise ValueError("插件版本编号无效")
        installed = max(BASE_VERSION, state.get("installed_version", BASE_VERSION))
        if version <= installed:
            return {"status": "current", "version_number": installed}
        with tempfile.TemporaryDirectory(prefix="flows-role-comment-download-") as temporary:
            package = Path(temporary) / "release.zip"
            cli("plugin", "download", "--plugin-id", PLUGIN_ID,
                "--version", str(version), "--output", str(package))
            backup = install(package, skill_dir, cache_dir)
        state["installed_version"] = version
        save_state(state_path, state)
        return {"status": "updated", "version_number": version,
                "release_label": latest.get("releaseLabel"), "backup": backup}


def main():
    skill_dir = Path(__file__).resolve().parent.parent
    installation = hashlib.sha256(str(skill_dir).encode()).hexdigest()[:16]
    cache_dir = Path.home() / ".cache" / "flows-role-comment" / installation
    try:
        result = check(skill_dir, cache_dir)
    except Exception as error:
        # Do not echo CLI responses or credentials into task output.
        result = {"status": "failed", "error_type": type(error).__name__,
                  "message": "检查或更新失败，继续使用本地版本；下次本机日期变更后重试"}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
