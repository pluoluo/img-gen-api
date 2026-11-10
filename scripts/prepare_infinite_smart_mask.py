"""Prepare pinned browser segmentation assets; weights and runtimes stay out of Git."""
from pathlib import Path
import hashlib
import json
import shutil
import tempfile
import urllib.request


def prepare(web: Path):
    public = web / "public" / "smart-mask"
    metadata = json.loads((web / "src/lib/smart-mask-models.json").read_text())
    model = public / "models" / "sam2.1-tiny"
    for name, info in metadata["files"].items():
        expected = info["sha256"]
        target = model / name
        if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == expected:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            print(f"Preparing SAM 2.1 Tiny: {name}", flush=True)
            url = f"https://huggingface.co/{metadata['repo']}/resolve/{metadata['revision']}/{name}"
            with urllib.request.urlopen(url) as response, tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
                temporary = Path(output.name)
                shutil.copyfileobj(response, output)
            if hashlib.sha256(temporary.read_bytes()).hexdigest() != expected:
                raise ValueError(f"SAM 2.1 Tiny asset checksum mismatch: {name}")
            temporary.replace(target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    runtime = web / "node_modules" / "onnxruntime-web" / "dist"
    destination = public / "runtime"
    destination.mkdir(parents=True, exist_ok=True)
    for item in runtime.glob("ort-wasm-simd-threaded*"):
        if item.suffix in (".mjs", ".wasm"):
            shutil.copy2(item, destination / item.name)
    shutil.copy2(web / "node_modules" / "@huggingface" / "transformers" / "LICENSE", public / "LICENSE-Apache-2.0.txt")
    (public / "NOTICE.txt").write_text(
        f"SAM 2.1 Tiny ONNX: https://huggingface.co/{metadata['repo']}/tree/{metadata['revision']}\n"
        "SAM 2.1: https://github.com/facebookresearch/sam2 (Apache-2.0).\n"
        "Transformers.js: Apache-2.0.\n"
        "ONNX Runtime: MIT, see ../onnxruntime-LICENSE.txt\n",
        encoding="utf-8",
    )
    print(f"Browser segmentation assets ready: {public}", flush=True)


if __name__ == "__main__":
    prepare(Path(__file__).resolve().parents[1] / "infinite" / "web")
