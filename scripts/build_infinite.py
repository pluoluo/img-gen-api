"""Build the bundled Infinite frontend and atomically publish its same-origin assets."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from prepare_infinite_smart_mask import prepare as prepare_smart_mask


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=root / "infinite", help="源码目录，默认使用本仓库的 infinite/")
    args = parser.parse_args()
    source = args.source.resolve()
    web = source / "web"
    if not (web / "bun.lock").is_file():
        parser.error("缺少 Infinite 前端源码或锁文件，请完整同步本仓库的 infinite/ 目录")
    destination = root / "frontend" / "infinite"
    if destination.exists() and not destination.is_symlink():
        parser.error("frontend/infinite 已存在且不是本脚本管理的链接，请先保留该目录")
    releases = root / "frontend" / ".infinite-releases"
    releases.mkdir(exist_ok=True)
    release = Path(tempfile.mkdtemp(prefix="release-", dir=releases))
    subprocess.run(["bun", "install", "--frozen-lockfile"], cwd=web, check=True)
    prepare_smart_mask(web)
    subprocess.run(["bun", "run", "typecheck"], cwd=web, check=True)
    env = {**os.environ, "VITE_BASE": "/infinite/", "VITE_IMAGE_API": "1"}
    subprocess.run(["bun", "run", "build", "--outDir", str(release)], cwd=web, env=env, check=True)
    # Reuse the legacy site's original full-color logo for the integrated app and favicon.
    shutil.copy2(root / "frontend" / "favicon.svg", release / "logo.svg")
    shutil.copy2(source / "LICENSE", release / "infinite-canvas-LICENSE.txt")
    # Keep hashed chunks referenced by already-open pages across atomic upgrades.
    if (destination / "assets").is_dir():
        for asset in (destination / "assets").iterdir():
            if asset.is_file() and not (release / "assets" / asset.name).exists():
                shutil.copy2(asset, release / "assets" / asset.name)
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=root, text=True).strip())
    (release / "build-info.json").write_text(json.dumps({"source": "pluoluo/img-gen-api", "revision": revision, "dirty": dirty}), encoding="utf-8")
    link = root / "frontend" / ".infinite-next"
    link.unlink(missing_ok=True)
    link.symlink_to(release.relative_to(root / "frontend"), target_is_directory=True)
    os.replace(link, destination)
    print(f"Infinite assets ready: {destination} -> {release.name}")


if __name__ == "__main__":
    main()
